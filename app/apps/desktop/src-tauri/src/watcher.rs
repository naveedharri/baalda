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

/// Owns the live watcher. Dropping it stops watching and lets the drain thread
/// exit (its channel disconnects).
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
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
    std::thread::spawn(move || {
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        let mut opened_at: Option<Instant> = None;
        loop {
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
                        process_batch(&vault, &index, &app, batch);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !dirty.is_empty() {
                        opened_at = None;
                        let batch = std::mem::take(&mut dirty);
                        process_batch(&vault, &index, &app, batch);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(VaultWatcher { _watcher: watcher })
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
) {
    let plan = plan_batch(vault, batch);
    if plan.changes.is_empty() {
        return;
    }

    // ONE lock, ONE transaction each way, ONE link-resolution pass each way.
    if !plan.modified.is_empty() || !plan.removed.is_empty() {
        let guard = index.lock().unwrap();
        if let Ok(failures) = guard.index_notes(vault, &plan.modified) {
            for (path, err) in failures {
                eprintln!("[watcher] index failed for {}: {err}", path.display());
            }
        }
        if let Ok(failures) = guard.remove_notes(vault, &plan.removed) {
            for (path, err) in failures {
                eprintln!("[watcher] remove failed for {}: {err}", path.display());
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
