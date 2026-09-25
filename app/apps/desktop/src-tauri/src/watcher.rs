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
//!
//! Read-only events are dropped at the source ([`should_forward`]): on Linux
//! `notify`'s inotify backend reports every open/read/close-after-read, and
//! indexing a note is itself a read, so forwarding those made the watcher feed
//! itself forever.
//!
//! Whatever still gets through is priced by content, not by the event: the index
//! compares each file's sha256 against the row it already holds, and a path whose
//! bytes did not change is reported back as `unchanged` and forwarded to the UI
//! as `unchanged: true` on its [`FileChanged`] entry. The entry is NOT dropped —
//! the TS side counts on exactly one watcher echo per path it materialises
//! (`registry.consumeMaterialized`) and on a `modified` cancelling a pending disk
//! delete — it just lets the UI and the sync layer skip the expensive half
//! (re-reading the note, diffing it into the CRDT, re-uploading it).

use crate::extract_worker::{self, ExtractQueue, ExtractWorker};
use crate::index::Index;
use crate::vault::{
    is_indexable_file, is_note_file, rel_from_abs, rel_path_is_ignored, vault_path_state,
    PathState,
};
use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
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
    /// The index re-read this file and its bytes were identical to what it had
    /// already indexed, so nothing was rewritten — the event fired for something
    /// that is not a content change (a metadata/attribute touch, a backup or
    /// cloud-sync tool rewriting the same bytes, our own echo).
    ///
    /// Always `false` for `removed` and `tree`, which have no content to compare.
    ///
    /// The entry is still emitted rather than filtered out, because the TS side
    /// treats the echo itself as meaningful: `registry.consumeMaterialized`
    /// expects exactly one per path it wrote, and a `modified` inside the
    /// `DISK_DELETE_GRACE_MS` window is what cancels a pending disk delete. The
    /// flag only tells it to skip the work that would have no effect.
    pub unchanged: bool,
    /// The path is no longer on disk (or is now a link, which sync treats as
    /// absent). Always true for `removed`; for `tree` it separates a folder
    /// that went away from one that appeared or changed — the half of a folder
    /// move the sync layer pairs by sub-path (#221). The vault root itself is
    /// reported as `{ path: "", kind: "tree", gone: true }` when it vanishes.
    pub gone: bool,
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
    /// The tier-2 extraction thread. Declared last so it is dropped (stopped and
    /// joined) after the drain thread that feeds it, and never while that thread
    /// is mid-enqueue.
    extractor: ExtractWorker,
}

impl VaultWatcher {
    /// A handle for enqueuing file extractions from outside the watcher — what
    /// `open_vault`'s background `rebuild` and the `rebuild_index` command use
    /// to hand over the files whose text is stale.
    pub fn extract_queue(&self) -> ExtractQueue {
        self.extractor.queue()
    }
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

/// Should this raw `notify` event reach the drain thread at all?
///
/// Everything is forwarded EXCEPT a pure read: `Access(_)` in every shape
/// (open, read, close-after-read) other than `Access(Close(Write))`.
///
/// Why. Linux is the only platform that reports reads. `notify`'s inotify
/// backend subscribes with `WatchMask::OPEN` alongside CREATE/MODIFY/DELETE, so
/// merely *reading* a file — or a directory — produces `EventKind::Access`
/// events. Indexing a batch reads every note in it, which produced a fresh
/// round of Access events, which `plan_batch` classified as `modified` (it only
/// asks whether the path exists), which re-indexed them: a vault that nobody
/// touched re-indexed itself 264–335 times a minute and wrote ~32 MB/s into
/// `.context/index.sqlite` (#155). macOS/FSEvents and Windows
/// `ReadDirectoryChangesW` never emit Access, so their behaviour is unchanged.
///
/// Two deliberate exceptions:
/// - `Access(Close(Write))` is KEPT. On inotify that is `IN_CLOSE_WRITE`, the
///   reliable "the writer is done" signal for editors that write a file in
///   place (no temp+rename, so no Create/Rename to lean on). It follows a write,
///   never a read, so it cannot feed the loop.
/// - An event carrying the Rescan flag is KEPT whatever its kind: that flag
///   means the backend's queue overflowed and state may have been missed, so it
///   must still reach the drain thread and re-index the batch.
pub(crate) fn should_forward(event: &notify::Event) -> bool {
    if event.need_rescan() {
        return true;
    }
    match event.kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

/// Map an event path reported under the CANONICAL vault root back onto the
/// root the vault was opened as. A path already under the typed root (inotify,
/// ReadDirectoryChangesW, or a canonical vault) passes through unchanged.
pub(crate) fn rebase_event_path(typed_root: &Path, canon_root: &Path, p: PathBuf) -> PathBuf {
    if typed_root == canon_root || p.starts_with(typed_root) {
        return p;
    }
    match p.strip_prefix(canon_root) {
        Ok(rest) => typed_root.join(rest),
        Err(_) => p,
    }
}

/// Start watching `vault`. Returns a handle that must be kept alive.
pub fn start(
    vault: PathBuf,
    index: Arc<Mutex<Index>>,
    app: AppHandle,
) -> crate::error::AppResult<VaultWatcher> {
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();

    // FSEvents canonicalises the watched path and reports REAL paths (#216,
    // pinned by `a_vault_opened_through_a_symlinked_root_still_receives_events`):
    // a vault opened as `/var/...` (really `/private/var/...`) or through a
    // linked folder got events that `rel_from_abs` could not strip, so
    // `plan_batch` dropped every one and external edits went unseen. Events are
    // rebased onto the root as opened, so the rest of the app — state, index,
    // recents, display — keeps the path the user chose.
    let canon_root = std::fs::canonicalize(&vault).unwrap_or_else(|_| vault.clone());
    let typed_root = vault.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if !should_forward(&event) {
                return;
            }
            // Forward the event's paths; the drain thread decides what to do.
            let paths = event
                .paths
                .into_iter()
                .map(|p| rebase_event_path(&typed_root, &canon_root, p))
                .collect();
            let _ = tx.send(paths);
        }
    })?;
    watcher.watch(&vault, RecursiveMode::Recursive)?;

    // One extraction worker per open vault, started before the drain thread so
    // the very first batch has somewhere to hand its files.
    let extractor = extract_worker::start(vault.clone(), index.clone(), app.clone());
    let queue = extractor.queue();

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
                        process_batch(&vault, &index, &app, &queue, batch, &thread_stop);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !dirty.is_empty() {
                        opened_at = None;
                        let batch = std::mem::take(&mut dirty);
                        process_batch(&vault, &index, &app, &queue, batch, &thread_stop);
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
        extractor,
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
    /// Note-family files present on disk → `Index::index_notes`.
    pub modified: Vec<PathBuf>,
    /// Everything to drop from the index → `Index::remove_notes` AND
    /// `Index::remove_files` (a vanished path may have been either, or a folder
    /// holding both).
    pub removed: Vec<PathBuf>,
    /// Tree binaries present on disk → `Index::index_files`, then the extraction
    /// worker. These are the SAME entries the UI is told about as `"tree"`: the
    /// emitted kind is a wire contract with the TS side (a non-note file has
    /// always meant "refresh the sidebar"), and the file index is a second
    /// consumer of the plan, not a new event.
    pub indexable_files: Vec<PathBuf>,
    /// The UI event payload, in a deterministic order.
    pub changes: Vec<PlannedChange>,
}

/// Turn a dirty set into a [`Plan`]: drop ignored paths, sort for determinism,
/// and split note-family writes from note-family deletions from structural changes.
pub fn plan_batch<I: IntoIterator<Item = PathBuf>>(vault: &Path, batch: I) -> Plan {
    let mut batch = batch.into_iter().peekable();
    if batch.peek().is_none() {
        return Plan::default();
    }
    // The vault root itself went away: renamed, moved, or its volume unmounted
    // (#221). Following links on purpose — a vault opened through a linked
    // folder is still a vault while the link resolves. Report ONLY the root, and
    // plan no index work at all: every child path would read as removed, and
    // pruning the whole index for a folder that merely moved is the one thing
    // that would make reopening it from its new location lose its identities.
    if !vault.is_dir() {
        return Plan {
            changes: vec![PlannedChange {
                abs: vault.to_path_buf(),
                rel: String::new(),
                kind: "tree",
                gone: true,
            }],
            ..Plan::default()
        };
    }
    let mut planned: Vec<PlannedChange> = Vec::new();
    for abs in batch {
        let Ok(rel) = rel_from_abs(vault, &abs) else {
            continue;
        };
        if rel.is_empty() || rel_path_is_ignored(&rel) {
            continue;
        }
        // The whole note family, not just `.md` — `index.rs` indexes all of it,
        // so a `.txt` edit that arrived as a "tree" change would refresh the
        // sidebar and never re-index the file it actually touched. Asked of the
        // file NAME, so a dot in a directory (`a.b/notes`) cannot answer for it.
        let name = rel.rsplit('/').next().unwrap_or(rel.as_str());
        let is_note = is_note_file(name);
        // `symlink_metadata`, per component (#216): a link at or above this path
        // is invisible to the tree walk and the index rebuild, so the live path
        // treats it exactly like a missing one. `exists()` followed the link and
        // kept a moved note's old path "present".
        let state = vault_path_state(vault, &rel);
        let (kind, gone) = if is_note {
            if state == PathState::Regular {
                ("modified", false)
            } else {
                ("removed", true)
            }
        } else {
            // Directory or non-note file → structural refresh. If it's gone
            // (or now a link, which the walk skips) it may have been a folder,
            // so prune its notes from the index too.
            ("tree", state.is_absent())
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
    // Present, surfaced, not a note, not under `attachments/` — see
    // `vault::is_indexable_file`, the one authority both this and
    // `Index::rebuild` ask.
    let indexable_files = planned
        .iter()
        .filter(|c| c.kind == "tree" && !c.gone && is_indexable_file(&c.rel) && c.abs.is_file())
        .map(|c| c.abs.clone())
        .collect();
    Plan {
        modified,
        removed,
        indexable_files,
        changes: planned,
    }
}

fn process_batch(
    vault: &Path,
    index: &Arc<Mutex<Index>>,
    app: &AppHandle,
    queue: &ExtractQueue,
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
    let mut unchanged: HashSet<PathBuf> = HashSet::new();
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
            if let Ok(outcome) = guard.index_notes(vault, slice) {
                for (path, err) in outcome.failures {
                    eprintln!("[watcher] index failed for {}: {err}", path.display());
                }
                unchanged.extend(outcome.unchanged);
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
            // The same paths, against tier 2: a vanished path is a note, a tree
            // binary or a folder holding either, and nothing here knows which.
            if let Err(e) = guard.remove_files(vault, slice) {
                eprintln!("[watcher] file rows: {e}");
            }
        }
    }

    // Tier 2, same chunking and the same short holds: the rows are written
    // under the lock (they are a stat and an insert), and the paths whose TEXT
    // is stale go to the extraction worker, which parses with no lock at all.
    let mut pending: Vec<PathBuf> = Vec::new();
    for slice in plan.indexable_files.chunks(CHUNK) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if chunks > 0 {
            std::thread::sleep(CHUNK_GAP);
        }
        chunks += 1;
        {
            let guard = index.lock().unwrap();
            match guard.index_files(vault, slice) {
                Ok(mut stale) => pending.append(&mut stale),
                Err(e) => eprintln!("[watcher] file rows: {e}"),
            }
        }
    }
    queue.enqueue(pending);

    // ONE event for the whole batch. The UI used to receive one `file-changed`
    // per path, so a bulk drop turned into a storm of tree refreshes.
    let _ = app.emit(
        "files-changed",
        FilesChanged {
            changes: mark_unchanged(plan.changes, &unchanged),
        },
    );
}

/// Turn the plan into the emitted payload, flagging the `modified` entries the
/// index reported as byte-identical.
///
/// Split out so the flag can be tested without an `AppHandle`. Matching is by
/// absolute path, which is exactly what `index_notes` was handed and hands back.
/// `removed` and `tree` entries are always `unchanged: false` — there is no
/// content comparison behind them.
pub(crate) fn mark_unchanged(
    changes: Vec<PlannedChange>,
    unchanged: &HashSet<PathBuf>,
) -> Vec<FileChanged> {
    changes
        .into_iter()
        .map(|c| FileChanged {
            unchanged: c.kind == "modified" && unchanged.contains(&c.abs),
            gone: c.gone,
            path: c.rel,
            kind: c.kind.to_string(),
        })
        .collect()
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

    /// #221: a folder moved outside the app (Finder, `mv`, a script) reaches the
    /// plan as the folder itself, never per child: the old path `tree` + gone,
    /// the new path `tree` and present. The sync layer pairs those two by
    /// sub-path, so the `gone` flag has to survive onto the wire.
    #[test]
    fn a_folder_move_arrives_as_a_gone_and_a_present_tree_change() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Old/a.md", "# A").unwrap();
        write_note(&v, "Old/sub/b.md", "# B").unwrap();
        std::fs::rename(v.join("Old"), v.join("Archive")).unwrap();

        let plan = plan_batch(&v, [v.join("Old"), v.join("Archive")]);
        let wire = mark_unchanged(plan.changes.clone(), &HashSet::new());
        assert_eq!(
            wire,
            vec![
                FileChanged {
                    path: "Archive".into(),
                    kind: "tree".into(),
                    unchanged: false,
                    gone: false,
                },
                FileChanged {
                    path: "Old".into(),
                    kind: "tree".into(),
                    unchanged: false,
                    gone: true,
                },
            ]
        );
        // The old prefix is pruned; the moved notes are left for the sync layer
        // to index under their kept ids.
        assert_eq!(plan.removed, vec![v.join("Old")]);
        assert!(plan.modified.is_empty());
    }

    /// #221: the vault root vanishing (renamed, moved, volume unmounted) is
    /// reported as ONE root change and nothing else — no index pruning, which
    /// would strip every identity from a folder that merely moved.
    #[test]
    fn a_vanished_root_is_reported_once_and_plans_no_index_work() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().join("vault");
        write_note(&v, "a.md", "# A").unwrap();
        write_note(&v, "sub/b.md", "# B").unwrap();
        std::fs::rename(&v, tmp.path().join("moved")).unwrap();

        let plan = plan_batch(&v, [v.clone(), v.join("a.md"), v.join("sub/b.md")]);
        assert_eq!(kinds(&plan), vec![(String::new(), "tree")]);
        assert!(plan.changes[0].gone);
        assert!(plan.removed.is_empty(), "nothing is pruned from the index");
        assert!(plan.modified.is_empty());
        assert!(plan.indexable_files.is_empty());
        let wire = mark_unchanged(plan.changes, &HashSet::new());
        assert_eq!(
            wire,
            vec![FileChanged {
                path: String::new(),
                kind: "tree".into(),
                unchanged: false,
                gone: true,
            }]
        );
    }

    /// A present root never produces the root entry: an event for the root
    /// path itself is dropped as before.
    #[test]
    fn a_present_root_event_is_still_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "a.md", "# A").unwrap();
        let plan = plan_batch(&v, [v.clone()]);
        assert!(plan.changes.is_empty());
    }

    /// The root check follows links: a vault opened through a linked folder is
    /// still a vault while the link resolves (#216).
    #[cfg(unix)]
    #[test]
    fn a_linked_root_is_not_reported_as_vanished() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        write_note(&real, "a.md", "# A").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let plan = plan_batch(&link, [link.join("a.md")]);
        assert_eq!(kinds(&plan), vec![("a.md".to_string(), "modified")]);
    }

    /// Watch `root` exactly as [`start`] does, make an edit inside it, and plan
    /// whatever `notify` reported against `root` the way the drain thread does.
    #[cfg(unix)]
    fn plan_live_edit(root: &Path) -> Plan {
        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        // The same rebasing `start` applies.
        let canon = std::fs::canonicalize(root).unwrap();
        let typed = root.to_path_buf();
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if should_forward(&event) {
                    let paths = event
                        .paths
                        .into_iter()
                        .map(|p| rebase_event_path(&typed, &canon, p))
                        .collect();
                    let _ = tx.send(paths);
                }
            }
        })
        .unwrap();
        w.watch(root, RecursiveMode::Recursive).unwrap();
        // FSEvents needs a moment before the stream delivers.
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(root.join("Edited.md"), "# edited").unwrap();
        let mut paths: HashSet<PathBuf> = HashSet::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) {
                paths.extend(batch);
                if !paths.is_empty() {
                    // Drain whatever else arrives in the debounce window.
                    while let Ok(more) = rx.recv_timeout(DEBOUNCE) {
                        paths.extend(more);
                    }
                    break;
                }
            }
        }
        assert!(!paths.is_empty(), "notify reported nothing for {}", root.display());
        plan_batch(root, paths)
    }

    /// #216 step 4, answered empirically: a vault opened through a symlinked
    /// root (and through the macOS temp dir, itself `/var` → `/private/var`)
    /// must still turn a live edit into a `files-changed` entry. Measured on
    /// macOS without `rebase_event_path`: FSEvents reported
    /// `/private/var/.../real-vault/Edited.md` for BOTH roots, `rel_from_abs`
    /// could not strip either, and both plans were empty.
    #[cfg(unix)]
    #[test]
    fn a_vault_opened_through_a_symlinked_root_still_receives_events() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real-vault");
        std::fs::create_dir_all(&real).unwrap();
        let linked = tmp.path().join("linked-vault");
        symlink(&real, &linked).unwrap();

        let plan = plan_live_edit(&linked);
        assert!(
            plan.changes.iter().any(|c| c.rel == "Edited.md" && c.kind == "modified"),
            "linked root: {:?}",
            plan.changes
        );
        let plan = plan_live_edit(&real);
        assert!(
            plan.changes.iter().any(|c| c.rel == "Edited.md" && c.kind == "modified"),
            "non-canonical temp root: {:?}",
            plan.changes
        );
    }

    /// #216: a link at a note path, or a folder link above it, is gone for
    /// identity purposes — exactly what the tree walk and the index rebuild see.
    #[cfg(unix)]
    #[test]
    fn plan_treats_linked_paths_as_removed() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Business/Old/n.md", "# moved").unwrap();
        write_note(&v, "Real.md", "# real").unwrap();
        symlink(v.join("Business/Old"), v.join("Old")).unwrap();
        symlink(v.join("Real.md"), v.join("Link.md")).unwrap();

        let batch: HashSet<PathBuf> = [
            v.join("Old/n.md"),
            v.join("Link.md"),
            v.join("Old"),
            v.join("Business/Old/n.md"),
        ]
        .into_iter()
        .collect();
        let plan = plan_batch(&v, batch);
        assert_eq!(
            kinds(&plan),
            vec![
                ("Business/Old/n.md".to_string(), "modified"),
                ("Link.md".to_string(), "removed"),
                ("Old".to_string(), "tree"),
                ("Old/n.md".to_string(), "removed"),
            ]
        );
        assert_eq!(plan.modified, vec![v.join("Business/Old/n.md")]);
        // The folder link prunes whatever the index still holds under `Old/`.
        assert_eq!(plan.removed, vec![v.join("Link.md"), v.join("Old"), v.join("Old/n.md")]);
    }

    /// A rename from OUTSIDE the app is two unpaired `notify` events — measured
    /// on macOS/FSEvents as `Modify(Name(Any))` for the old path and another for
    /// the new one, with no rename cookie exposed — and both land inside one
    /// 150 ms drain. This pins what the TS side is therefore entitled to assume:
    /// ONE batch carrying `removed` for the old path and `modified` for the new,
    /// with nothing linking them. The sync layer pairs them by content hash
    /// (`SyncManager.drainDiskDeletes`), which is only sound because they arrive
    /// together; if this ever became two batches, an external rename would
    /// propagate as a delete plus a brand-new note.
    #[test]
    fn plan_reports_an_external_rename_as_removed_plus_modified_in_one_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Old.md", "# Same bytes").unwrap();
        // The rename itself: the file is at the new path by the time we plan.
        std::fs::rename(v.join("Old.md"), v.join("New.md")).unwrap();

        let batch: HashSet<PathBuf> = [v.join("Old.md"), v.join("New.md")].into_iter().collect();
        let plan = plan_batch(&v, batch);

        assert_eq!(
            kinds(&plan),
            vec![
                ("New.md".to_string(), "modified"),
                ("Old.md".to_string(), "removed"),
            ]
        );
        assert_eq!(plan.modified, vec![v.join("New.md")]);
        assert_eq!(plan.removed, vec![v.join("Old.md")]);
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
        assert!(idx
            .index_notes(&v, &plan.modified)
            .unwrap()
            .failures
            .is_empty());
        assert!(idx.remove_notes(&v, &plan.removed).unwrap().is_empty());

        let paths: Vec<String> = idx
            .list_note_titles()
            .unwrap()
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert_eq!(paths, vec!["Alpha.md".to_string()]);
    }

    /// The flag the UI reads: only `modified` entries the index reported as
    /// byte-identical carry it, and nothing is ever dropped from the event.
    #[test]
    fn mark_unchanged_flags_only_the_matching_modified_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Same.md", "# Same").unwrap();
        write_note(&v, "Edited.md", "# Edited").unwrap();
        std::fs::create_dir_all(v.join("folder")).unwrap();

        let batch: HashSet<PathBuf> = [
            v.join("Same.md"),
            v.join("Edited.md"),
            v.join("Gone.md"),
            v.join("folder"),
        ]
        .into_iter()
        .collect();
        let plan = plan_batch(&v, batch);

        // The index saw Same.md as byte-identical. `Gone.md` is named too, to
        // pin that a non-`modified` entry can never pick the flag up.
        let unchanged: HashSet<PathBuf> =
            [v.join("Same.md"), v.join("Gone.md")].into_iter().collect();
        let changes = mark_unchanged(plan.changes, &unchanged);

        assert_eq!(
            changes,
            vec![
                FileChanged {
                    path: "Edited.md".into(),
                    kind: "modified".into(),
                    unchanged: false,
                    gone: false,
                },
                FileChanged {
                    path: "Gone.md".into(),
                    kind: "removed".into(),
                    unchanged: false,
                    gone: true,
                },
                FileChanged {
                    path: "Same.md".into(),
                    kind: "modified".into(),
                    unchanged: true,
                    gone: false,
                },
                FileChanged {
                    path: "folder".into(),
                    kind: "tree".into(),
                    unchanged: false,
                    gone: false,
                },
            ],
            "every path is still reported; only the modified match is flagged"
        );
    }

    /// The flag is derived from what the index actually did, not from the event:
    /// re-indexing the same bytes must produce `unchanged: true` end to end.
    #[test]
    fn a_no_op_rewrite_reaches_the_event_as_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\nbody").unwrap();
        let idx = Index::open(&v).unwrap();
        let plan = plan_batch(&v, [v.join("Alpha.md")]);
        assert!(
            idx.index_notes(&v, &plan.modified)
                .unwrap()
                .unchanged
                .is_empty(),
            "first pass indexes it"
        );

        // A second watcher event for a file nobody edited.
        let plan = plan_batch(&v, [v.join("Alpha.md")]);
        let out = idx.index_notes(&v, &plan.modified).unwrap();
        let changes = mark_unchanged(plan.changes, &out.unchanged.into_iter().collect());
        assert_eq!(
            changes,
            vec![FileChanged {
                path: "Alpha.md".into(),
                kind: "modified".into(),
                unchanged: true,
                gone: false,
            }]
        );
    }

    /// Tier 2 rides the SAME plan without changing the wire: a `.docx` is still
    /// reported to the UI as `"tree"` (that is what a non-note file has always
    /// meant — refresh the sidebar), and separately collected for the file
    /// index. Changing the kind would be a breaking change for every TS consumer
    /// of `files-changed`.
    #[test]
    fn a_tree_binary_is_indexable_and_still_reported_as_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Note.md", "# Note").unwrap();
        std::fs::write(v.join("Report.docx"), b"PK\x03\x04").unwrap();
        std::fs::create_dir_all(v.join("attachments")).unwrap();
        std::fs::write(v.join("attachments/a1b2.png"), b"\x89PNG").unwrap();
        std::fs::create_dir_all(v.join("sub")).unwrap();
        std::fs::write(v.join("sub/clip.mp4"), b"ftyp").unwrap();
        std::fs::write(v.join("notes.bak"), b"junk").unwrap();

        let batch: HashSet<PathBuf> = [
            v.join("Note.md"),
            v.join("Report.docx"),
            v.join("attachments/a1b2.png"),
            v.join("sub/clip.mp4"),
            v.join("notes.bak"),
        ]
        .into_iter()
        .collect();
        let plan = plan_batch(&v, batch);

        assert_eq!(
            kinds(&plan),
            vec![
                ("Note.md".to_string(), "modified"),
                ("Report.docx".to_string(), "tree"),
                ("attachments/a1b2.png".to_string(), "tree"),
                ("notes.bak".to_string(), "tree"),
                ("sub/clip.mp4".to_string(), "tree"),
            ],
        );
        assert_eq!(
            plan.indexable_files,
            vec![v.join("Report.docx"), v.join("sub/clip.mp4")],
            "the attachments store is excluded (hash-named, hidden, unlocatable \
             hits) and `.bak` is not a surfaced format at all"
        );
    }

    /// A deleted binary must leave no row behind — and the plan cannot tell a
    /// vanished file from a vanished folder, so both tiers are asked.
    #[test]
    fn a_vanished_binary_prunes_its_file_row() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        std::fs::create_dir_all(v.join("Reports")).unwrap();
        std::fs::write(v.join("Reports/q3.docx"), b"PK\x03\x04").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        assert_eq!(idx.file_rows().unwrap().len(), 1);

        // The whole folder goes, which is one unpaired "tree" event for a path
        // that no longer exists.
        std::fs::remove_dir_all(v.join("Reports")).unwrap();
        let plan = plan_batch(&v, [v.join("Reports")]);
        assert_eq!(kinds(&plan), vec![("Reports".to_string(), "tree")]);
        assert!(plan.indexable_files.is_empty(), "gone files are not queued");
        idx.remove_files(&v, &plan.removed).unwrap();
        assert!(idx.file_rows().unwrap().is_empty());
    }

    /// Linux-only feedback loop (#155). Every read-shaped inotify event must die
    /// in the callback, or indexing (which reads the notes) re-dirties them.
    #[test]
    fn read_only_access_events_are_dropped() {
        use notify::event::{AccessKind, AccessMode};
        use notify::{Event, EventKind};

        let read_kinds = [
            EventKind::Access(AccessKind::Any),
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Open(AccessMode::Read)),
            EventKind::Access(AccessKind::Close(AccessMode::Any)),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
            EventKind::Access(AccessKind::Other),
        ];
        for kind in read_kinds {
            let event = Event::new(kind).add_path(PathBuf::from("/vault/Note.md"));
            assert!(
                !should_forward(&event),
                "{kind:?} is a read and must not reach the drain thread"
            );
        }
    }

    /// Everything that can mean "the bytes on disk changed" still gets through —
    /// including `Close(Write)`, the in-place editor's end-of-write signal.
    #[test]
    fn writes_renames_and_deletes_are_forwarded() {
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind,
            RenameMode,
        };
        use notify::{Event, EventKind};

        let write_kinds = [
            EventKind::Create(CreateKind::Any),
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            EventKind::Remove(RemoveKind::Any),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Any,
            EventKind::Other,
        ];
        for kind in write_kinds {
            let event = Event::new(kind).add_path(PathBuf::from("/vault/Note.md"));
            assert!(
                should_forward(&event),
                "{kind:?} may have changed the file and must be forwarded"
            );
        }
    }

    /// The Rescan flag means the backend's queue overflowed, so its kind is not
    /// to be trusted — forward it even though it claims to be a read.
    #[test]
    fn a_rescan_flagged_access_event_is_forwarded() {
        use notify::event::{AccessKind, Flag};
        use notify::{Event, EventKind};

        let event = Event::new(EventKind::Access(AccessKind::Read))
            .add_path(PathBuf::from("/vault/Note.md"))
            .set_flag(Flag::Rescan);
        assert!(event.need_rescan());
        assert!(should_forward(&event));
    }
}
