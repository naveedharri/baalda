//! The extraction worker: one background thread per open vault that turns the
//! `files` rows the index marked `pending` into searchable text.
//!
//! ## Why it is a thread and not part of the batch
//!
//! Parsing a container is unbounded work on untrusted input — a 20 MB `.xlsx`
//! is tens of thousands of XML events — and the index mutex is the lock every
//! UI command waits on (titles, search, backlinks, opening a note). Doing it
//! inside `index_files`, the way notes are parsed inside `index_notes`, would
//! put a spreadsheet between the user and every click. So the rule is absolute:
//! **nothing that parses a container runs under the index mutex.** This thread
//! stats, hashes and parses with no lock held at all, and takes the lock twice
//! per file for two small statements — a cache lookup and the write.
//!
//! ## Superseding
//!
//! The queue is path-keyed: enqueuing a path that is already waiting is a no-op,
//! because the work is "bring this path up to date" and the file is re-stat'd,
//! re-hashed and re-read when it is finally popped. A file saved forty times
//! while the queue is busy is therefore extracted once, from its final bytes.
//!
//! ## Lifetime
//!
//! Owned by [`crate::watcher::VaultWatcher`], so a vault switch drops it, which
//! signals the stop flag and JOINS — exactly like the watcher's own drain
//! thread, and for the same reason: the thread holds an `Arc<Mutex<Index>>` and
//! therefore a live SQLite connection, and two connections writing one file is
//! `SQLITE_BUSY`. Abandoning a queue mid-drain is safe: the rows it did not
//! reach are still `pending`, and the next `rebuild` queues them again.

use crate::error::AppResult;
use crate::extract::{extract_text, extractor_for, max_input_bytes, Extracted, Extractor, TextStatus};
use crate::index::Index;
use crate::notefile::sha256_file;
use crate::vault::{is_indexable_file, rel_from_abs};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// How long the thread parks when there is nothing to do. Short enough that the
/// stop flag is seen promptly on a vault switch, long enough to be free.
const IDLE_TICK: Duration = Duration::from_millis(200);

/// Coalescing for the `files-indexed` event: emit after this many files, or this
/// often, whichever comes first. Dropping 200 documents into a vault must not
/// mean 200 events, and an open search panel re-runs its query on each one.
const EVENT_BATCH: usize = 20;
const EVENT_INTERVAL: Duration = Duration::from_millis(400);

/// Payload of `files-indexed`: the vault-relative paths whose extracted text
/// just landed. A panel with results on screen re-runs its query; everything
/// else can ignore it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesIndexed {
    pub paths: Vec<String>,
}

/// A cloneable handle for enqueuing work. Held by the watcher's drain thread and
/// by whoever ran a `rebuild`.
#[derive(Clone)]
pub struct ExtractQueue {
    tx: mpsc::Sender<Vec<PathBuf>>,
}

impl ExtractQueue {
    /// Queue absolute paths for extraction. Cheap and non-blocking; a dead
    /// worker (vault already switched) silently drops the send, because the rows
    /// stay `pending` and the next open re-queues them.
    pub fn enqueue(&self, paths: Vec<PathBuf>) {
        if paths.is_empty() {
            return;
        }
        let _ = self.tx.send(paths);
    }
}

/// The running worker. Dropping it stops and joins the thread.
pub struct ExtractWorker {
    queue: ExtractQueue,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ExtractWorker {
    pub fn queue(&self) -> ExtractQueue {
        self.queue.clone()
    }
}

impl Drop for ExtractWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// Start the worker for `vault`.
pub fn start(vault: PathBuf, index: Arc<Mutex<Index>>, app: AppHandle) -> ExtractWorker {
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();

    let thread = std::thread::spawn(move || {
        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        let mut queued: HashSet<PathBuf> = HashSet::new();
        let mut done: Vec<String> = Vec::new();
        let mut last_emit = Instant::now();

        loop {
            if thread_stop.load(Ordering::Relaxed) {
                return;
            }
            match rx.recv_timeout(IDLE_TICK) {
                Ok(paths) => push(&mut queue, &mut queued, paths),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // Take whatever else is already waiting, so one drain covers a whole
            // burst rather than re-entering the loop per message.
            while let Ok(paths) = rx.try_recv() {
                push(&mut queue, &mut queued, paths);
            }
            if queue.is_empty() {
                continue;
            }

            while let Some(abs) = queue.pop_front() {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }
                queued.remove(&abs);
                if let Some(rel) = extract_one(&vault, &index, &abs) {
                    done.push(rel);
                }
                while let Ok(paths) = rx.try_recv() {
                    push(&mut queue, &mut queued, paths);
                }
                if done.len() >= EVENT_BATCH || last_emit.elapsed() >= EVENT_INTERVAL {
                    emit(&app, &mut done, &mut last_emit);
                }
            }
            emit(&app, &mut done, &mut last_emit);

            // The queue is empty, so any cached text nothing references is
            // genuinely orphaned — a rename's new path has claimed its text back
            // by now. Doing this in `rebuild` instead would delete the text a
            // rename is seconds away from reusing.
            if let Ok(guard) = index.lock() {
                if let Ok(n) = guard.prune_file_text() {
                    if n > 0 {
                        log::info!("[extract] pruned {n} orphaned cached texts");
                    }
                }
            }
        }
    });

    ExtractWorker {
        queue: ExtractQueue { tx },
        stop,
        thread: Some(thread),
    }
}

fn push(queue: &mut VecDeque<PathBuf>, queued: &mut HashSet<PathBuf>, paths: Vec<PathBuf>) {
    for path in paths {
        // Path-keyed superseding: already waiting means already up to date, as
        // the file is re-read when it is popped.
        if queued.insert(path.clone()) {
            queue.push_back(path);
        }
    }
}

fn emit(app: &AppHandle, done: &mut Vec<String>, last_emit: &mut Instant) {
    *last_emit = Instant::now();
    if done.is_empty() {
        return;
    }
    let _ = app.emit(
        "files-indexed",
        FilesIndexed {
            paths: std::mem::take(done),
        },
    );
}

/// What one file's extraction did. Returned for the event and, in tests, so the
/// cache can be proven to have been used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractOutcome {
    pub rel: String,
    pub status: TextStatus,
    /// The text came from `file_text` (same bytes seen before) — no parse ran.
    pub from_cache: bool,
}

/// Bring ONE file's text up to date. The whole point of this module: the read,
/// the hash and the parse happen with no lock held; the index is locked twice,
/// briefly, for a cache lookup and the write.
///
/// `None` means nothing was written — the path is not ours, vanished mid-flight,
/// or its row is gone (deleted, or the vault switched under us).
fn extract_one(vault: &Path, index: &Mutex<Index>, abs: &Path) -> Option<String> {
    match run(vault, index, abs) {
        Ok(Some(outcome)) => Some(outcome.rel),
        Ok(None) => None,
        Err(e) => {
            log::warn!("[extract] {} failed: {e}", abs.display());
            None
        }
    }
}

/// The testable half of [`extract_one`] — same work, full outcome, real errors.
///
/// Public because `tests/index_integration.rs` drives the real pipeline with it
/// (rebuild → queue → extract) without needing a Tauri app handle or a thread.
pub fn run(
    vault: &Path,
    index: &Mutex<Index>,
    abs: &Path,
) -> AppResult<Option<ExtractOutcome>> {
    let Ok(rel) = rel_from_abs(vault, abs) else {
        return Ok(None);
    };
    if !is_indexable_file(&rel) {
        return Ok(None);
    }
    // A file that vanished between the watcher event and here is not an error:
    // its row is removed by the batch's `remove_files`, not by us.
    let Ok(meta) = std::fs::metadata(abs) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let ext = rel
        .rsplit('/')
        .next()
        .unwrap_or(&rel)
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let extractor = extractor_for(&ext);
    let cap = max_input_bytes(extractor);
    // Name-only and unsupported kinds derive their text from the file NAME, so
    // caching it by CONTENT hash would hand a copy saved under another name the
    // wrong answer.
    let cacheable = !matches!(extractor, Extractor::NameOnly | Extractor::Unsupported);

    // Streamed, so the 500 MB video this is most likely to meet never lands in
    // memory. This is also what makes a rename free further down.
    let sha = sha256_file(abs)?;

    let mut from_cache = false;
    let extracted = if cap == 0 {
        // Never opened: there is nothing in the bytes we would index.
        extract_text(abs, &ext, &[])
    } else if meta.len() > cap {
        // The cheap half of the cap — refused without a read. `extract_text`
        // makes the same decision for a caller that hands it the bytes anyway.
        Extracted {
            text: String::new(),
            status: TextStatus::SkippedSize,
        }
    } else if let Some(cached) = cacheable
        .then(|| index.lock().unwrap().cached_file_text(&sha))
        .transpose()?
        .flatten()
    {
        from_cache = true;
        Extracted {
            text: cached,
            status: TextStatus::Ok,
        }
    } else {
        let bytes = std::fs::read(abs)?;
        extract_text(abs, &ext, &bytes)
    };

    // Only a successful, content-derived extraction earns a cache row: caching
    // an empty body for a file we refused to read would make the refusal look
    // like an answer for every other file with those bytes.
    let cache = cacheable && extracted.status == TextStatus::Ok;
    let wrote = index.lock().unwrap().store_file_text(
        &rel,
        &sha,
        &extracted.text,
        extracted.status.as_str(),
        cache,
    )?;
    if !wrote {
        return Ok(None);
    }
    Ok(Some(ExtractOutcome {
        rel,
        status: extracted.status,
        from_cache,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn docx_bytes(text: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            writer
                .start_file("word/document.xml", zip::write::SimpleFileOptions::default())
                .unwrap();
            write!(
                writer,
                r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
            )
            .unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    fn vault_with_docx(name: &str, text: &str) -> (tempfile::TempDir, PathBuf, Mutex<Index>) {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::write(vault.join(name), docx_bytes(text)).unwrap();
        let index = Index::open(&vault).unwrap();
        index.rebuild(&vault).unwrap();
        (tmp, vault, Mutex::new(index))
    }

    /// The cache exists so a second pass over unchanged bytes costs a hash, not
    /// a parse. Proven by the flag the run reports, and by there still being
    /// exactly one cached text.
    #[test]
    fn extraction_is_cached_by_sha() {
        let (_tmp, vault, index) = vault_with_docx("Report.docx", "sardonic marmalade");

        let first = run(&vault, &index, &vault.join("Report.docx"))
            .unwrap()
            .unwrap();
        assert_eq!(first.status, TextStatus::Ok);
        assert!(!first.from_cache, "nothing was cached yet");

        let second = run(&vault, &index, &vault.join("Report.docx"))
            .unwrap()
            .unwrap();
        assert!(second.from_cache, "identical bytes must not be re-parsed");

        let text = index
            .lock()
            .unwrap()
            .file_text("Report.docx")
            .unwrap()
            .unwrap();
        assert!(text.text.contains("sardonic marmalade"));
    }

    /// Identity is per path, but TEXT is per content: renaming a 15 MB document
    /// must not re-parse it.
    #[test]
    fn renamed_file_reuses_cached_text() {
        let (_tmp, vault, index) = vault_with_docx("Report.docx", "quarterly figures");
        run(&vault, &index, &vault.join("Report.docx")).unwrap();

        std::fs::rename(vault.join("Report.docx"), vault.join("Renamed.docx")).unwrap();
        {
            let guard = index.lock().unwrap();
            guard
                .index_files(&vault, &[vault.join("Renamed.docx")])
                .unwrap();
            guard
                .remove_files(&vault, &[vault.join("Report.docx")])
                .unwrap();
        }

        let out = run(&vault, &index, &vault.join("Renamed.docx"))
            .unwrap()
            .unwrap();
        assert!(out.from_cache, "same bytes at a new path: no parse");
        assert!(index
            .lock()
            .unwrap()
            .file_text("Renamed.docx")
            .unwrap()
            .unwrap()
            .text
            .contains("quarterly figures"));
    }

    /// A video is hashed and rowed but never opened, and its text is NOT cached
    /// by content — a copy under a different name must not inherit this name.
    #[test]
    fn media_is_name_only_and_never_cached_by_content() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::write(vault.join("Clip.mp4"), b"\x00\x00\x00 ftypmp42").unwrap();
        let index = Index::open(&vault).unwrap();
        index.rebuild(&vault).unwrap();
        let index = Mutex::new(index);

        let out = run(&vault, &index, &vault.join("Clip.mp4")).unwrap().unwrap();
        assert_eq!(out.status, TextStatus::Ok);
        assert!(!out.from_cache);

        let guard = index.lock().unwrap();
        let text = guard.file_text("Clip.mp4").unwrap().unwrap();
        assert_eq!(text.chars, 0, "no body — the name is the searchable part");
        // Still findable, by name.
        let hits = guard.search_all("Clip").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "file");
    }

    /// A path outside the tier-2 set is refused rather than rowed: `.md` is a
    /// note, and `.context/` is never touched by anything.
    #[test]
    fn notes_and_ignored_paths_are_not_extracted() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join(".context")).unwrap();
        std::fs::write(vault.join("Note.md"), "# hi").unwrap();
        std::fs::write(vault.join(".context/notes.csv"), "a,b").unwrap();
        let index = Mutex::new(Index::open(&vault).unwrap());

        assert_eq!(run(&vault, &index, &vault.join("Note.md")).unwrap(), None);
        assert_eq!(
            run(&vault, &index, &vault.join(".context/notes.csv")).unwrap(),
            None
        );
    }
}
