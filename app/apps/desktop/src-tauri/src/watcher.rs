//! Debounced filesystem watcher (spec 01 §3). Raw `notify` events are funneled
//! into a background thread that drains a dirty-set, then re-indexes the whole
//! batch in ONE index transaction and emits ONE `files-changed` event to the UI.
//!
//! Why batched. `Index::index_note`/`remove_note` each run a whole-vault link
//! resolution pass in their own transaction, so the old per-path loop made a
//! 1000-file drop cost 1000 whole-vault passes (and 1000 Tauri events, and 1000
//! index-mutex acquisitions). `Index::index_notes`/`remove_notes` collapse that
//! to one pass per batch; this module's job is to hand them the whole batch.
//!
//! `.context/` and dotfolders are ignored so the app's own state dir never
//! feeds the note pipeline (spec 02 §2 hard rule).

use crate::index::Index;
use crate::vault::{rel_from_abs, rel_path_is_ignored};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Quiet period: flush once nothing has changed for this long.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Ceiling on how long the dirty set may keep growing before we flush anyway.
/// Without it, a long copy (which never goes quiet for 150ms) defers ALL of the
/// indexing to the moment it finishes, so the sidebar shows nothing meanwhile.
const MAX_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    /// Vault-relative path of the changed item.
    pub path: String,
    /// "modified" | "removed" | "tree" (folder/structure change).
    pub kind: String,
}

/// Payload of the single `files-changed` event emitted per batch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesChanged {
    pub changes: Vec<FileChanged>,
}

/// How many paths one index transaction may cover.
///
/// The batch used to be unbounded: one transaction, one lock acquisition, for
/// however many paths arrived. A bulk sync writes every note in the vault, so
/// that became `index_notes: 4940 files in 44778 ms` — 45 seconds during which
/// the drain thread holds the index mutex and SQLite's single write slot. Every
/// UI command that touches the index (titles, backlinks, search, opening a note)
/// queues behind that lock, which is what "clicks are slow while it syncs" was.
///
/// Chunking costs one link pass per CHUNK instead of per batch, which is cheap
/// now that the pass is scoped to the notes a batch actually touched
/// (`Index::resolve_links` / `LinkScope::Touched`) rather than scanning every
/// link in the vault. Before that scoping this trade was a bad one, and chunking
/// made a damaged vault slower rather than faster.
///
/// Sized from the real logs of a 1,560-note vault mid-sync: a pass costs about
/// 88 ms fixed (it rebuilds the basename/title maps from `notes`) plus ~1.4 ms
/// per file, so 128 files is a ceiling of roughly a quarter second on how long a
/// click can be stuck behind the indexer — under the ~300 ms where a delay stops
/// reading as "slow" and starts reading as "broken". Bigger chunks amortise the
/// fixed cost better (400 measured 1215 ms for 824 files in ONE hold), smaller
/// ones pay it too often.
const CHUNK: usize = 128;

/// Breather between chunks. A std mutex is not fair: the drain thread releasing
/// the guard and immediately re-locking it can hand the lock straight back to
/// itself while a UI command sits in the queue, which turns per-chunk locking
/// back into one long hold. Sleeping briefly guarantees the waiters run.
const CHUNK_GAP: Duration = Duration::from_millis(2);

/// Owns the live watcher and its drain thread.
///
/// Dropping it signals the thread to stop and JOINS it. The join is the point:
/// the thread holds an `Arc<Mutex<Index>>`, and therefore a live SQLite
/// connection to `.context/index.sqlite`. It used to be spawned detached, so a
/// vault switch (or, in dev, an HMR remount re-running `open_vault`) opened
/// connection #2 while the outgoing thread was still inside a multi-second write
/// transaction on connection #1. Two writers on one SQLite file is
/// `SQLITE_BUSY`, and past the 5s `busy_timeout` it surfaced as the
/// `[watcher] index failed …: database is locked` storm — index rows silently
/// lost, and every reader stalled behind the doomed writer.
///
/// `stop` is checked between chunks, so the join waits for at most one chunk
/// rather than a whole 45-second batch.
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    drain: Option<std::thread::JoinHandle<()>>,
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // The thread may be parked in `recv_timeout`; it wakes within DEBOUNCE
        // and sees the flag. Dropping `_watcher` first would also disconnect the
        // channel, but field drop order is declaration order, so signal
        // explicitly rather than depending on it.
        if let Some(h) = self.drain.take() {
            let _ = h.join();
        }
    }
}

/// Start watching `vault`. Returns a handle that must be kept alive.
pub fn start(
    vault: PathBuf,
    index: Arc<Mutex<Index>>,
    app: AppHandle,
) -> crate::error::AppResult<VaultWatcher> {
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Forward the event's paths; the drain thread decides what to do.
            let _ = tx.send(event.paths);
        }
    })?;
    watcher.watch(&vault, RecursiveMode::Recursive)?;

    // Drain thread: collect until quiet (or until the batch has been open for
    // MAX_WINDOW), then process the dirty set as one batch.
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let drain = std::thread::spawn(move || {
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        let mut opened_at: Option<Instant> = None;
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(DEBOUNCE) {
                Ok(paths) => {
                    if dirty.is_empty() {
                        opened_at = Some(Instant::now());
                    }
                    for p in paths {
                        dirty.insert(p);
                    }
                    // A sustained stream never goes quiet — flush on the ceiling.
                    let stale = opened_at.is_some_and(|t| t.elapsed() >= MAX_WINDOW);
                    if stale && !dirty.is_empty() {
                        opened_at = None;
                        let batch = std::mem::take(&mut dirty);
                        process_batch(&vault, &index, &app, batch, &thread_stop);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !dirty.is_empty() {
                        opened_at = None;
                        let batch = std::mem::take(&mut dirty);
                        process_batch(&vault, &index, &app, batch, &thread_stop);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(VaultWatcher {
        _watcher: watcher,
        stop,
        drain: Some(drain),
    })
}

/// One planned change: what the index must do, and what the UI is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChange {
    /// Absolute path, for the index calls.
    pub abs: PathBuf,
    /// Vault-relative path, for the UI event.
    pub rel: String,
    /// The `kind` reported to the UI: "modified" | "removed" | "tree".
    pub kind: &'static str,
    /// This path must be dropped from the index: a `.md` that's gone, or a
    /// vanished non-markdown path that may have been a folder (whose notes are
    /// pruned by prefix).
    pub gone: bool,
}

/// The batch, partitioned by what each path needs. Pure enough to test: the only
/// I/O is the existence check that decides modified-vs-removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    /// `.md` files present on disk → `Index::index_notes`.
    pub modified: Vec<PathBuf>,
    /// Everything to drop from the index → `Index::remove_notes`.
    pub removed: Vec<PathBuf>,
    /// The UI event payload, in a deterministic order.
    pub changes: Vec<PlannedChange>,
}

/// Turn a dirty set into a [`Plan`]: drop ignored paths, sort for determinism,
/// and split `.md` writes from `.md` deletions from structural changes.
pub fn plan_batch<I: IntoIterator<Item = PathBuf>>(vault: &Path, batch: I) -> Plan {
    let mut planned: Vec<PlannedChange> = Vec::new();
    for abs in batch {
        let Ok(rel) = rel_from_abs(vault, &abs) else {
            continue;
        };
        if rel.is_empty() || rel_path_is_ignored(&rel) {
            continue;
        }
        let is_md = rel.to_lowercase().ends_with(".md");
        let exists = abs.exists();
        let (kind, gone) = if is_md {
            if exists && abs.is_file() {
                ("modified", false)
            } else {
                ("removed", true)
            }
        } else {
            // Directory or non-markdown file → structural refresh. If it's gone
            // it may have been a folder, so prune its notes from the index too.
            ("tree", !exists)
        };
        planned.push(PlannedChange {
            abs,
            rel,
            kind,
            gone,
        });
    }
    // A HashSet iterates in an arbitrary order; sorting keeps the emitted event
    // (and the index writes) reproducible, which is what makes this testable.
    planned.sort_by(|a, b| (a.rel.as_str(), a.kind).cmp(&(b.rel.as_str(), b.kind)));

    let modified = planned
        .iter()
        .filter(|c| c.kind == "modified")
        .map(|c| c.abs.clone())
        .collect();
    let removed = planned
        .iter()
        .filter(|c| c.gone)
        .map(|c| c.abs.clone())
        .collect();
    Plan {
        modified,
        removed,
        changes: planned,
    }
}

fn process_batch(
    vault: &Path,
    index: &Arc<Mutex<Index>>,
    app: &AppHandle,
    batch: HashSet<PathBuf>,
    stop: &AtomicBool,
) {
    let plan = plan_batch(vault, batch);
    if plan.changes.is_empty() {
        return;
    }

    // One transaction and one link pass per CHUNK, and — the part that matters
    // for responsiveness — the index mutex is re-acquired per chunk instead of
    // held for the whole batch. A UI command only ever waits for the chunk in
    // flight. See `CHUNK`.
    let mut chunks = 0usize;
    for slice in plan.modified.chunks(CHUNK) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if chunks > 0 {
            std::thread::sleep(CHUNK_GAP);
        }
        chunks += 1;
        {
            let guard = index.lock().unwrap();
            if let Ok(failures) = guard.index_notes(vault, slice) {
                for (path, err) in failures {
                    eprintln!("[watcher] index failed for {}: {err}", path.display());
                }
            }
        }
    }
    for slice in plan.removed.chunks(CHUNK) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if chunks > 0 {
            std::thread::sleep(CHUNK_GAP);
        }
        chunks += 1;
        {
            let guard = index.lock().unwrap();
            if let Ok(failures) = guard.remove_notes(vault, slice) {
                for (path, err) in failures {
                    eprintln!("[watcher] remove failed for {}: {err}", path.display());
                }
            }
        }
    }

    // ONE event for the whole batch. The UI used to receive one `file-changed`
    // per path, so a bulk drop turned into a storm of tree refreshes.
    let _ = app.emit(
        "files-changed",
        FilesChanged {
            changes: plan
                .changes
                .into_iter()
                .map(|c| FileChanged {
                    path: c.rel,
                    kind: c.kind.to_string(),
                })
                .collect(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notefile::write_note;

    fn kinds(plan: &Plan) -> Vec<(String, &'static str)> {
        plan.changes
            .iter()
            .map(|c| (c.rel.clone(), c.kind))
            .collect()
    }

    #[test]
    fn plan_splits_modified_removed_and_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha").unwrap();
        write_note(&v, "sub/Beta.md", "# Beta").unwrap();
        std::fs::create_dir_all(v.join("folder")).unwrap();
        std::fs::write(v.join("image.png"), b"x").unwrap();

        let batch: HashSet<PathBuf> = [
            v.join("Alpha.md"),       // exists → modified
            v.join("sub/Beta.md"),    // exists → modified
            v.join("Gone.md"),        // absent → removed
            v.join("folder"),         // dir → tree
            v.join("image.png"),      // non-md file → tree
            v.join("deleted-folder"), // absent, non-md → tree + prune
        ]
        .into_iter()
        .collect();

        let plan = plan_batch(&v, batch);

        assert_eq!(
            kinds(&plan),
            vec![
                ("Alpha.md".to_string(), "modified"),
                ("Gone.md".to_string(), "removed"),
                ("deleted-folder".to_string(), "tree"),
                ("folder".to_string(), "tree"),
                ("image.png".to_string(), "tree"),
                ("sub/Beta.md".to_string(), "modified"),
            ],
            "sorted by rel path, so the batch is reproducible"
        );

        assert_eq!(
            plan.modified,
            vec![v.join("Alpha.md"), v.join("sub/Beta.md")]
        );
        // A gone `.md` AND a gone folder both need pruning from the index.
        assert_eq!(
            plan.removed,
            vec![v.join("Gone.md"), v.join("deleted-folder")]
        );
    }

    #[test]
    fn plan_drops_ignored_and_out_of_vault_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Keep.md", "# Keep").unwrap();

        let batch: HashSet<PathBuf> = [
            v.join(".context/index.sqlite"), // the app's own state dir
            v.join(".context/config.json"),
            v.join(".git/HEAD"),
            v.join("node_modules/pkg/readme.md"),
            v.clone(),                                  // the vault root itself
            PathBuf::from("/elsewhere/on/disk/foo.md"), // not in this vault
            v.join("Keep.md"),
        ]
        .into_iter()
        .collect();

        let plan = plan_batch(&v, batch);
        assert_eq!(kinds(&plan), vec![("Keep.md".to_string(), "modified")]);
        assert!(plan.removed.is_empty());
    }

    #[test]
    fn plan_coalesces_repeated_paths_and_survives_an_empty_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha").unwrap();

        // The drain thread's dirty set is a HashSet, so a file touched 500 times
        // during a save storm reaches the plan exactly once.
        let mut batch: HashSet<PathBuf> = HashSet::new();
        for _ in 0..500 {
            batch.insert(v.join("Alpha.md"));
        }
        let plan = plan_batch(&v, batch);
        assert_eq!(plan.changes.len(), 1);
        assert_eq!(plan.modified.len(), 1);

        assert_eq!(plan_batch(&v, Vec::new()), Plan::default());
    }

    /// The plan feeds the batch index entry points directly; this pins that the
    /// pairing actually indexes and prunes what it claims to.
    #[test]
    fn plan_applied_to_the_index_indexes_and_prunes_in_one_pass_each() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\n[[Beta]]").unwrap();
        write_note(&v, "sub/Beta.md", "# Beta").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        // Beta is deleted on disk; Alpha is edited. One batch.
        std::fs::remove_file(v.join("sub/Beta.md")).unwrap();
        write_note(&v, "Alpha.md", "# Alpha\n\nno more links").unwrap();
        let batch: HashSet<PathBuf> = [v.join("Alpha.md"), v.join("sub/Beta.md")]
            .into_iter()
            .collect();
        let plan = plan_batch(&v, batch);
        assert!(idx.index_notes(&v, &plan.modified).unwrap().is_empty());
        assert!(idx.remove_notes(&v, &plan.removed).unwrap().is_empty());

        let paths: Vec<String> = idx
            .list_note_titles()
            .unwrap()
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert_eq!(paths, vec!["Alpha.md".to_string()]);
    }
}
