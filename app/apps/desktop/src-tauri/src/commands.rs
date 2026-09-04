//! The Tauri command surface — the entire Phase 0 disk + index API exposed to
//! the React UI. All disk I/O happens here (or in the modules these call);
//! the UI never touches the filesystem directly.

use crate::attachments::{self, AttachmentMeta};
use crate::error::{AppError, AppResult};
use crate::import_export::{self, ImportSummary};
use crate::index::{
    Backlink, GraphEdge, Index, NoteMeta, NoteTitle, ResolvedLink, SearchResult, YjsPruneReport,
    YjsState, YjsStateVector,
};
use crate::notefile;
use crate::state::AppState;
use crate::tree::{self, TreeNode};
use crate::{vault, watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    /// The vault epoch (see `state::Inner::vault_epoch`) in effect for this
    /// info. For an open (`open_vault`, `pick_vault`, `create_vault`,
    /// `open_vault_in_root`) it is the epoch that open established, so the
    /// caller can pin every follow-up write to *this* vault. Purely
    /// informational for `get_last_vault`, which doesn't open anything.
    pub epoch: u64,
}

/// One entry in the "recently opened vaults" list surfaced on the welcome
/// screen. `opened_at` is epoch-millis of the last open (0 if unknown, e.g. a
/// migrated legacy `last_vault`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
}

/// How many recent vaults we keep in config / show on the welcome screen.
const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    /// Legacy single last-opened vault. Superseded by `recent_vaults`; kept so
    /// old configs migrate cleanly and nothing else that reads it breaks.
    last_vault: Option<String>,
    /// Most-recently-opened vaults, newest first (see `RecentVault`).
    #[serde(default)]
    recent_vaults: Vec<RecentVault>,
    /// Sync server base URL (spec 04 §7 — configurable; default in the TS layer).
    #[serde(default)]
    server_url: Option<String>,
    /// Root directory the app manages: one persistent subfolder per vault,
    /// plus a stable `current` symlink repointed to the active vault so
    /// external tools (e.g. Claude Desktop MCP) can target one fixed path.
    /// `alias` keeps pre-rename configs (which used `workspace_root`) loadable —
    /// same migration pattern as `last_vault` → `recent_vaults` above.
    #[serde(default, alias = "workspace_root")]
    vaults_root: Option<String>,
}

// ---- helpers --------------------------------------------------------------

/// Marker prefix on the error a vault-epoch mismatch produces. Callers in the TS
/// sync layer match on it to tell "your vault moved out from under you" (drop the
/// work silently) apart from a real I/O failure.
pub const VAULT_MISMATCH: &str = "vault-mismatch";

/// Reject a command whose caller pinned a different vault epoch than the one
/// currently open. `expected == None` means the caller didn't pin anything (UI
/// reads, user-driven edits) — those keep the legacy "whatever is open" behaviour.
fn check_epoch(expected: Option<u64>, current: u64) -> AppResult<()> {
    match expected {
        Some(e) if e != current => Err(AppError::new(format!(
            "{VAULT_MISMATCH}: caller pinned vault epoch {e}, but epoch {current} is open"
        ))),
        _ => Ok(()),
    }
}

/// Resolve the open vault WITHOUT an epoch assertion. Only for commands that
/// purely read the index for display (`search_notes`, `get_backlinks`,
/// `graph_edges`, `get_note_meta`, `resolve_wikilink`) — nothing writes based on
/// their result, so "whatever vault is open" is the correct answer. Anything that
/// writes, or whose result is written back, must use `require_vault_at`.
fn require_vault(state: &State<AppState>) -> AppResult<(PathBuf, Arc<Mutex<Index>>)> {
    require_vault_at(state, None)
}

/// `require_vault`, but asserting the caller's expected vault epoch first, so a
/// command that crossed a vault switch fails instead of resolving against the
/// wrong vault. Every vault-relative command the sync layer drives goes through
/// here with the epoch its VaultScope was opened under.
fn require_vault_at(
    state: &State<AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<(PathBuf, Arc<Mutex<Index>>)> {
    let inner = state.inner.lock().unwrap();
    check_epoch(expected_epoch, inner.vault_epoch)?;
    let vault = inner
        .vault
        .clone()
        .ok_or_else(|| AppError::new("no vault is open"))?;
    let index = inner
        .index
        .clone()
        .ok_or_else(|| AppError::new("index not initialized"))?;
    Ok((vault, index))
}

fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(format!("no config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &AppHandle) -> AppConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &AppConfig) -> AppResult<()> {
    let p = config_path(app)?;
    std::fs::write(p, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Label for a path with no `file_name` (a filesystem/drive root): the path
/// itself minus trailing separators, so `D:\\` reads "D:" — except a bare `/`,
/// which has nothing left after the trim and stays as it is.
fn root_label(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string()
    } else {
        trimmed.to_string()
    }
}

fn vault_info(path: &Path, epoch: u64) -> VaultInfo {
    // A filesystem/drive root (`/`, `D:\`) has no `file_name`, but it is a
    // legal vault root (opened by path — the native picker can't select one).
    // Label it by the path itself, trimmed of trailing separators, rather than
    // the old anonymous "vault".
    let name = match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n.to_string(),
        None => root_label(&path.to_string_lossy()),
    };
    VaultInfo {
        path: path.to_string_lossy().to_string(),
        name,
        epoch,
    }
}

/// Payload of the `index-ready` event: the background index rebuild that
/// `open_vault` starts has committed. `epoch` lets the UI drop a stale one.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexReady {
    pub path: String,
    pub epoch: u64,
    pub ok: bool,
    pub ms: u64,
}

/// The epoch of the currently-open vault (0 when none has been opened). The TS
/// layer reads this when it starts a VaultScope for a vault it didn't just open.
#[tauri::command]
pub fn get_vault_epoch(state: State<'_, AppState>) -> AppResult<u64> {
    Ok(state.inner.lock().unwrap().vault_epoch)
}

/// Open a vault: build/refresh its index, start the watcher, remember it, and
/// emit `vault-opened`. Shared by `pick_vault` and `open_vault`.
fn open_vault_inner(app: &AppHandle, state: &State<AppState>, path: PathBuf) -> AppResult<VaultInfo> {
    if !path.is_dir() {
        return Err(AppError::new("selected path is not a folder"));
    }

    // Grant the runtime fs scope for this vault (spec 01 §3). Rust does the I/O
    // with std::fs regardless, but this keeps the plugin scope consistent.
    {
        use tauri_plugin_fs::FsExt;
        let scope = app.fs_scope();
        let _ = scope.allow_directory(&path, true);
    }
    // Grant the asset-protocol scope for the same directory so the webview can
    // stream vault files (e.g. `<img src>` in notes) via convertFileSrc.
    let _ = app.asset_protocol_scope().allow_directory(&path, true);

    let index = Arc::new(Mutex::new(Index::open(&path)?));

    // The watcher first, so nothing that changes during the rebuild below is
    // missed: its drain thread queues behind the same index lock and re-indexes
    // any file the rebuild may have seen too (idempotent).
    let watcher = watcher::start(path.clone(), index.clone(), app.clone())?;

    let epoch = {
        let mut inner = state.inner.lock().unwrap();
        // Every open invalidates the previous vault's epoch, so any command still
        // in flight for it is rejected rather than applied to this one.
        let epoch = inner.vault_epoch + 1;

        // Reconcile the index with disk in the BACKGROUND (#84). This used to run
        // inline, so opening a large vault returned nothing to the UI until every
        // changed/new `.md` had been re-parsed — a multi-second blank on first
        // open, read as "the app hangs". The sidebar listing needs no index (it
        // walks the disk), so the vault is usable at once; anything that does
        // need the index (titles, search, backlinks, the sync reconcile) simply
        // waits on its lock and gets the rebuilt answer.
        //
        // The rebuild thread takes the index lock BEFORE this open publishes the
        // index into the state (the `ready` handshake below), so no command can
        // read a stale index in between: the first reader blocks until the
        // rebuild commits, exactly as if it had been inline. Correctness of every
        // index reader is unchanged; only who waits for the rebuild is.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
        let (bg_index, bg_path, bg_app) = (index.clone(), path.clone(), app.clone());
        std::thread::spawn(move || {
            let guard = bg_index.lock().unwrap();
            let _ = ready_tx.send(());
            let started = std::time::Instant::now();
            let result = guard.rebuild(&bg_path);
            drop(guard);
            let ok = match result {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("[index] rebuild failed for {}: {e}", bg_path.display());
                    false
                }
            };
            // Tells the UI the index is current: titles/backlinks/graph refresh.
            let _ = bg_app.emit(
                "index-ready",
                IndexReady {
                    path: bg_path.to_string_lossy().to_string(),
                    epoch,
                    ok,
                    ms: started.elapsed().as_millis() as u64,
                },
            );
        });
        // Wait until the rebuild thread HOLDS the index lock (sub-millisecond),
        // then publish. A `recv` error means the thread died before locking, in
        // which case the index is simply stale-but-consistent, as before.
        let _ = ready_rx.recv();

        inner.vault = Some(path.clone());
        inner.index = Some(index);
        inner.watcher = Some(watcher); // replaces & drops any previous watcher
        inner.vault_epoch = epoch;
        epoch
    };

    let info = vault_info(&path, epoch);
    // Preserve other config keys (e.g. server_url) when updating recents.
    let mut cfg = read_config(app);
    cfg.last_vault = Some(info.path.clone()); // kept for back-compat
    // Move this vault to the front of the recents list (dedup by path), stamp
    // the open time, and cap the list length.
    cfg.recent_vaults.retain(|r| r.path != info.path);
    cfg.recent_vaults.insert(
        0,
        RecentVault {
            path: info.path.clone(),
            name: info.name.clone(),
            opened_at: now_ms(),
        },
    );
    cfg.recent_vaults.truncate(RECENT_LIMIT);
    write_config(app, &cfg)?;
    app.emit("vault-opened", info.clone())?;
    Ok(info)
}

// ---- vault commands -------------------------------------------------------

/// Native folder picker → open the chosen vault. Returns None if cancelled.
#[tauri::command]
pub async fn pick_vault(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<VaultInfo>> {
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    Ok(Some(open_vault_inner(&app, &state, path)?))
}

/// Open a vault by absolute path (used for auto-reopen of the last vault).
#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<VaultInfo> {
    open_vault_inner(&app, &state, PathBuf::from(path))
}

/// The last-opened vault path from config (None on first launch). This does NOT
/// open the vault, so the returned `epoch` is the currently-open one (0 at
/// launch) — callers must pin the epoch returned by the subsequent `open_vault`.
#[tauri::command]
pub fn get_last_vault(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<VaultInfo>> {
    let cfg = read_config(&app);
    let epoch = state.inner.lock().unwrap().vault_epoch;
    Ok(cfg.last_vault.and_then(|p| {
        let path = PathBuf::from(p);
        path.is_dir().then(|| vault_info(&path, epoch))
    }))
}

/// Recently opened vaults, newest first, pruned to those that still exist on
/// disk. Migrates a legacy `last_vault` into the list on first read.
#[tauri::command]
pub fn get_recent_vaults(app: AppHandle) -> AppResult<Vec<RecentVault>> {
    let mut cfg = read_config(&app);

    // One-time migration: fold a legacy single last_vault into the list.
    if cfg.recent_vaults.is_empty() {
        if let Some(p) = cfg.last_vault.clone() {
            let path = PathBuf::from(&p);
            if path.is_dir() {
                cfg.recent_vaults.push(RecentVault {
                    name: vault_info(&path, 0).name,
                    path: p,
                    opened_at: 0,
                });
            }
        }
    }

    // Drop entries whose folder has since been moved/deleted; persist if changed.
    let before = cfg.recent_vaults.len();
    cfg.recent_vaults.retain(|r| Path::new(&r.path).is_dir());
    if cfg.recent_vaults.len() != before {
        let _ = write_config(&app, &cfg);
    }

    Ok(cfg.recent_vaults)
}

/// Remove one vault from the recents list (welcome-screen "×").
#[tauri::command]
pub fn remove_recent_vault(app: AppHandle, path: String) -> AppResult<()> {
    let mut cfg = read_config(&app);
    cfg.recent_vaults.retain(|r| r.path != path);
    if cfg.last_vault.as_deref() == Some(path.as_str()) {
        cfg.last_vault = None;
    }
    write_config(&app, &cfg)
}

/// Move a local vault's folder — and all its notes — to the OS trash, then
/// forget it from the recents list. Used by the local-vault "Delete files"
/// action. This is the only copy of a local vault (no server), so we trash
/// (recoverable) instead of hard-deleting, and the UI gates it behind a
/// two-click confirm.
#[tauri::command]
pub fn delete_vault(app: AppHandle, path: String) -> AppResult<()> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(AppError::new("selected path is not a folder"));
    }
    // A missing parent means this is a filesystem root — never a real vault
    // folder. Refuse rather than trash an entire drive.
    if dir.parent().is_none() {
        return Err(AppError::new("refusing to delete a filesystem root"));
    }
    trash::delete(&dir).map_err(|e| AppError::new(format!("could not move to trash: {e}")))?;
    // Also drop it from recents / last_vault so it doesn't linger in the switcher.
    let mut cfg = read_config(&app);
    cfg.recent_vaults.retain(|r| r.path != path);
    if cfg.last_vault.as_deref() == Some(path.as_str()) {
        cfg.last_vault = None;
    }
    write_config(&app, &cfg)
}

/// Create a brand-new empty vault folder `<parent>/<name>` and open it. A name
/// whose folder is taken gets a numeric suffix (see `free_vault_dir`) rather
/// than an error — duplicate vault names are allowed.
#[tauri::command]
pub async fn create_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> AppResult<VaultInfo> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(AppError::new("invalid vault name"));
    }
    let dir = free_vault_dir(Path::new(&parent), name)
        .ok_or_else(|| AppError::new("a folder with that name already exists"))?;
    std::fs::create_dir_all(&dir)?;
    open_vault_inner(&app, &state, dir)
}

/// `<parent>/<name>`, or the first free `<parent>/<name> 2`, `… 3`, … if that
/// folder is taken. None if every candidate up to 99 exists.
///
/// A vault's identity is its `doc_id`s, never its name, so two vaults may share
/// a display name — including one already on this disk. This used to be a hard
/// error ("a folder with that name already exists"), which made a name someone
/// else had picked (a teammate's vault, an old folder of your own) un-typeable
/// rather than merely un-repeatable as a *folder*. A local vault is named by
/// its folder, so the second "hey" reads "hey 2" — nameable, and renamable
/// from Finder — instead of refusing to be created at all.
fn free_vault_dir(parent: &Path, name: &str) -> Option<PathBuf> {
    let first = parent.join(name);
    if !first.exists() {
        return Some(first);
    }
    (2..100).map(|n| parent.join(format!("{name} {n}"))).find(|d| !d.exists())
}

/// Report whether a folder already looks like a vault (has our `.context/` index
/// or contains markdown notes). The vault picker calls this after "New vault"
/// picks a parent, so it can offer to *open* an existing vault instead of
/// nesting a new empty one inside it.
#[tauri::command]
pub fn is_vault(path: String) -> AppResult<bool> {
    Ok(crate::vault::is_vault(std::path::Path::new(&path)))
}

/// The configured sync server base URL, if the user has set one.
#[tauri::command]
pub fn get_server_url(app: AppHandle) -> AppResult<Option<String>> {
    Ok(read_config(&app).server_url)
}

// ---- vaults root + `current` pointer --------------------------------------
//
// A vault (server org) maps 1:1 to a local folder. The app owns one root
// directory; each vault gets a persistent subfolder under it, and switching
// vaults repoints `<root>/current` at the active folder. Folders bound to a
// vault before the root existed keep their original location — the root is
// only where *new* vault folders are created.

/// User-visible name of the default managed-root folder. Layer-1 brand surface
/// (spec: rebrand policy) — the one place the default root folder name is set.
const DEFAULT_ROOT_DIR_NAME: &str = "Baalda Vaults";

/// Default managed root: `<home>/Documents/Baalda Vaults`. Lives under Documents
/// so it's easy to find in the OS file browser (Finder/Explorer both surface
/// Documents in their sidebar) instead of being buried at the top of home.
fn default_vaults_root(app: &AppHandle) -> AppResult<PathBuf> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| AppError::new(format!("no home dir: {e}")))?;
    Ok(home.join("Documents").join(DEFAULT_ROOT_DIR_NAME))
}

/// The effective vaults root, auto-initialized to the default and persisted
/// on first read so the rest of the app can rely on it always existing.
#[tauri::command]
pub fn get_vaults_root(app: AppHandle) -> AppResult<String> {
    let mut cfg = read_config(&app);
    let root = match cfg.vaults_root.clone() {
        Some(r) => PathBuf::from(r),
        None => {
            let d = default_vaults_root(&app)?;
            cfg.vaults_root = Some(d.to_string_lossy().to_string());
            d
        }
    };
    let _ = write_config(&app, &cfg);
    std::fs::create_dir_all(&root)?;
    Ok(root.to_string_lossy().to_string())
}

/// Change the managed vaults root (existing vault folders keep their location;
/// only newly created ones land under the new root).
#[tauri::command]
pub fn set_vaults_root(app: AppHandle, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p)?;
    let mut cfg = read_config(&app);
    cfg.vaults_root = Some(p.to_string_lossy().to_string());
    write_config(&app, &cfg)
}

/// Native folder picker for the managed vaults root; persists and returns it.
#[tauri::command]
pub async fn pick_vaults_root(app: AppHandle) -> AppResult<Option<String>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    std::fs::create_dir_all(&path)?;
    let mut cfg = read_config(&app);
    cfg.vaults_root = Some(path.to_string_lossy().to_string());
    write_config(&app, &cfg)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Native folder picker that only returns the chosen path (does NOT open it as
/// a vault). Used to let the user pick the local folder for a vault, which
/// is then opened via `open_vault_in_root`.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> AppResult<Option<String>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Native multi-file picker. Returns the chosen absolute paths, or None if the
/// dialog was cancelled.
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> AppResult<Option<Vec<String>>> {
    let Some(files) = app.dialog().file().blocking_pick_files() else {
        return Ok(None);
    };
    let paths = files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(Some(paths))
}

/// Native save-file dialog (used for single-note export). Returns the chosen
/// absolute path, or None if cancelled.
#[tauri::command]
pub async fn save_file(app: AppHandle, default_name: String) -> AppResult<Option<String>> {
    let Some(file) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|e| AppError::new(format!("invalid path: {e}")))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Import external files/folders into the vault under `dest` (vault-relative;
/// "" = root). Copies bytes, then indexes any new `.md` notes synchronously so
/// search/backlinks are fresh (the watcher echo also refreshes the sidebar).
#[tauri::command]
pub async fn import_paths(
    state: State<'_, AppState>,
    dest: String,
    sources: Vec<String>,
    expected_epoch: Option<u64>,
) -> AppResult<ImportSummary> {
    // Epoch-pinned: the caller sits behind a native file-picker dialog, the longest
    // await in the app, and `dest` is a path from the tree that was on screen when
    // it opened. Without the pin an import could copy files into a different vault.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let summary = import_export::import_paths(&vault, &dest, &sources);
    // Index every new note under the imported top-level items — collected FIRST,
    // then handed to the index as ONE batch. Indexing them one at a time re-ran a
    // whole-vault link-resolution pass per file, so importing a folder of 1000
    // notes cost 1000 of them (see `Index::index_notes`).
    let mut md_paths: Vec<PathBuf> = Vec::new();
    for rel in &summary.imported {
        if let Ok(abs) = vault::resolve_in_vault(&vault, rel) {
            collect_md_tree(&abs, &mut md_paths);
        }
    }
    let guard = index.lock().unwrap();
    for (path, err) in guard.index_notes(&vault, &md_paths)? {
        eprintln!("[import] index failed for {}: {err}", path.display());
    }
    Ok(summary)
}

/// Collect every `.md` file at/under `abs` (best-effort; an unreadable dir is
/// skipped rather than failing the whole import).
fn collect_md_tree(abs: &Path, out: &mut Vec<PathBuf>) {
    if abs.is_dir() {
        if let Ok(entries) = std::fs::read_dir(abs) {
            for entry in entries.flatten() {
                collect_md_tree(&entry.path(), out);
            }
        }
    } else if abs.extension().and_then(|e| e.to_str()) == Some("md") {
        out.push(abs.to_path_buf());
    }
}

/// Export a note, folder subtree, or the whole vault (`rel == ""`) to `dest`.
/// For a directory source, `dest` is a destination directory; for a single
/// file, `dest` is the exact target path from the Save dialog.
#[tauri::command]
pub async fn export_path(
    state: State<'_, AppState>,
    rel: String,
    dest: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    // Epoch-pinned like `import_paths` (same post-dialog window). Exporting the
    // wrong vault's notes to the chosen destination leaks them out of the vault
    // the user actually picked.
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    import_export::export_path(&vault, &rel, &dest)
}

/// Open a vault's folder, repoint `<root>/current` at it, then make it the
/// active vault. The folder may live anywhere (a legacy folder bound before the
/// root existed), but `current` always tracks it.
///
/// `create` gates the mkdir: only the paths that deliberately mint a NEW folder
/// (auto-folder on switch, "start empty") pass true. Reopening a REMEMBERED
/// binding must not create — `create_dir_all` here used to silently resurrect a
/// folder the user had moved/renamed in Finder, and the registry then
/// re-materialized the whole vault into the empty ghost (a duplicate copy).
#[tauri::command]
pub async fn open_vault_in_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    create: Option<bool>,
) -> AppResult<VaultInfo> {
    let folder = PathBuf::from(&path);
    if create.unwrap_or(false) {
        std::fs::create_dir_all(&folder)?;
    } else if !folder.is_dir() {
        return Err(AppError::new(format!("vault folder not found: {path}")));
    }
    if let Some(root) = read_config(&app).vaults_root {
        repoint_current(Path::new(&root), &folder);
    }
    open_vault_inner(&app, &state, folder)
}

/// Forget the launch auto-reopen target (recents are untouched). Called when
/// the user deliberately lands on the welcome screen — closing the vault,
/// signing out, removing the open vault from this device — so a reload or
/// relaunch respects that choice instead of reopening the folder they just
/// left. The next vault open re-arms it (`remember_recent`).
#[tauri::command]
pub fn clear_last_vault(app: AppHandle) -> AppResult<()> {
    let mut cfg = read_config(&app);
    cfg.last_vault = None;
    write_config(&app, &cfg)
}

/// Does this absolute path exist as a directory? Lets the vault-switch flow tell
/// "bound folder moved/deleted" (rediscover it) from "folder present but failed
/// to open" (surface the error) without attempting the open.
#[tauri::command]
pub fn folder_exists(path: String) -> AppResult<bool> {
    Ok(Path::new(&path).is_dir())
}

/// Read a folder's `.context/config.json` WITHOUT opening it as the active vault
/// (contrast `get_vault_config`, which is epoch-pinned to the open one). This is
/// the discovery probe behind `store.setActiveOrganization`'s rediscovery pass:
/// it identifies a folder as an existing local copy of a vault so the switch can
/// reopen it instead of auto-creating a duplicate under the vaults root.
/// Best-effort by design — a missing folder, a non-vault folder, or an
/// unreadable config all return None so one bad candidate can't abort a scan.
#[tauri::command]
pub fn peek_vault_config(path: String) -> AppResult<Option<String>> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(None);
    }
    Ok(std::fs::read_to_string(p.join(".context").join("config.json")).ok())
}

/// Immediate subdirectories of the managed vaults root (absolute paths), for the
/// rediscovery candidate list — auto-created folders may have aged out of the
/// recents list. Skips dotfiles and symlinks (which also excludes `current`).
#[tauri::command]
pub fn list_vaults_root_dirs(app: AppHandle) -> AppResult<Vec<String>> {
    let Some(root) = read_config(&app).vaults_root else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    Ok(out)
}

/// Point `<root>/current` at `target`. Best-effort: it never clobbers a real
/// directory squatting the `current` name, and symlink failures are non-fatal
/// (the pointer is a convenience for external tools, not required for sync).
fn repoint_current(root: &Path, target: &Path) {
    let link = root.join("current");
    match std::fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let _ = std::fs::remove_file(&link);
        }
        Ok(_) => {
            eprintln!("[vault] `current` is not a symlink; leaving it in place");
            return;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            eprintln!("[vault] cannot stat `current`: {e}");
            return;
        }
    }
    #[cfg(unix)]
    if let Err(e) = std::os::unix::fs::symlink(target, &link) {
        eprintln!("[vault] symlink failed: {e}");
    }
    #[cfg(windows)]
    if let Err(e) = std::os::windows::fs::symlink_dir(target, &link) {
        eprintln!("[vault] symlink_dir failed: {e}");
    }
}

/// Raw contents of the open vault's `.context/config.json`, or None if absent.
/// The TS sync layer owns the schema (server vault id + doc-id mapping); Rust is
/// a dumb reader/writer so the registry mapping travels with the vault, not the
/// app profile (spec 03 §5 "store server vault id in .context/config.json").
///
/// `expected_epoch` is the vault epoch the caller pinned (see `check_epoch`).
/// It's a read, but its result is written back to the SAME file, so reading the
/// wrong vault's config is how two vaults' doc maps got merged.
#[tauri::command]
pub async fn get_vault_config(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Option<String>> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    let p = vault.join(".context").join("config.json");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Overwrite the open vault's `.context/config.json` with `content`.
#[tauri::command]
pub async fn set_vault_config(
    state: State<'_, AppState>,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    // Atomic + fsync'd: this file is the ONLY copy of the vault's doc-id map, and
    // it is rewritten on every registry pull. A bare `fs::write` truncates first,
    // so a crash (or a full disk) mid-write leaves a half-written or empty map —
    // which the sync layer reads as "this vault knows nothing about its notes"
    // and re-registers everything. See `notefile::write_atomic_fsync`.
    let target = vault.join(".context").join("config.json");
    notefile::write_atomic_fsync(&target, content.as_bytes())
}

/// Persist the sync server base URL (app config, next to last_vault).
#[tauri::command]
pub fn set_server_url(app: AppHandle, url: Option<String>) -> AppResult<()> {
    let mut cfg = read_config(&app);
    // Normalize empty string to None so the TS default kicks back in.
    cfg.server_url = url.filter(|s| !s.trim().is_empty());
    write_config(&app, &cfg)
}

// ---- tree + file commands -------------------------------------------------

#[tauri::command]
pub async fn list_tree(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<TreeNode> {
    // Epoch-pinned for the sync layer: the registry feeds this tree straight into
    // `syncStructure`, so returning the WRONG vault's tree is what created one
    // vault's folders/notes under another vault's server rows.
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    tree::list_tree(&vault)
}

/// Lazy sidebar loading: return only one directory's immediate children.
/// `path` is the vault-relative dir ("" = root). Sub-dirs come back as
/// expandable-but-unloaded folders (empty `children`); the UI fetches deeper
/// levels on expand. Keeps vault switching O(entries) instead of O(all notes).
#[tauri::command]
pub async fn list_children(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<TreeNode>> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    tree::list_children(&vault, &path)
}

#[tauri::command]
pub async fn read_note(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::read_note(&vault, &path)
}

#[tauri::command]
pub async fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    notefile::write_note(&vault, &path, &content)?;
    // Re-index immediately so search/backlinks are fresh without waiting for
    // the watcher echo.
    let abs = vault::resolve_in_vault(&vault, &path)?;
    index.lock().unwrap().index_note(&vault, &abs)?;
    Ok(())
}

/// Create a note only if it doesn't exist yet; returns true when it was created.
/// Used by the registry to materialize server-only notes without ever being able
/// to overwrite local content — see `notefile::write_note_if_missing`.
#[tauri::command]
pub async fn write_note_if_missing(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<bool> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    if !notefile::write_note_if_missing(&vault, &path, &content)? {
        return Ok(false);
    }
    let abs = vault::resolve_in_vault(&vault, &path)?;
    index.lock().unwrap().index_note(&vault, &abs)?;
    Ok(true)
}

#[tauri::command]
pub async fn create_note(
    state: State<'_, AppState>,
    parent: String,
    name: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let rel = notefile::create_note(&vault, &parent, &name)?;
    let abs = vault::resolve_in_vault(&vault, &rel)?;
    index.lock().unwrap().index_note(&vault, &abs)?;
    Ok(rel)
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    parent: String,
    name: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::create_folder(&vault, &parent, &name)
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    from: String,
    to: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    // Epoch-pinned because the UI renames a multi-select in a loop: every lap
    // after the first runs past an await, and a rename applied to the wrong vault
    // moves a same-named file the user never touched.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let old_abs = vault::resolve_in_vault(&vault, &from)?;
    let new_rel = notefile::rename_path(&vault, &from, &to)?;
    let new_abs = vault::resolve_in_vault(&vault, &new_rel)?;
    // Keep doc_id stable across the move (file or folder subtree).
    index.lock().unwrap().rename_note(&vault, &old_abs, &new_abs)?;
    Ok(new_rel)
}

/// Idempotent folder create, for reconciliation (see `notefile::ensure_folder`).
#[tauri::command]
pub async fn ensure_folder(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::ensure_folder(&vault, &path)?;
    Ok(())
}

/// Move a note into the vault's recoverable trash (see `notefile::trash_note`).
#[tauri::command]
pub async fn trash_note(
    state: State<'_, AppState>,
    path: String,
    stamp: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    // Epoch-pinned for the same reason as `delete_path`, and it matters as much:
    // this is driven by a debounced registry pull that can outlive a vault switch.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let abs = vault::resolve_in_vault(&vault, &path)?;
    let dest = notefile::trash_note(&vault, &path, &stamp)?;
    // Drop the index row rather than renaming it: the doc_id has to be RELEASED so
    // a file later recreated at this path is indexed as new, instead of reviving a
    // soft-deleted server row as an unsyncable ghost. (Renaming the row would also
    // leave a phantom `.context/...` path in FTS results.)
    index.lock().unwrap().remove_note(&vault, &abs)?;
    Ok(dest)
}

/// Remove a folder the server has deleted — but only when it is empty by now
/// (its notes leave via their own tombstones first). Returns whether it was
/// removed; a folder still holding anything stays on disk, which is the safe
/// direction (see `notefile::delete_folder_if_empty`).
#[tauri::command]
pub async fn delete_folder_if_empty(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<bool> {
    // Epoch-pinned like `trash_note`: driven by a debounced registry pull that
    // can outlive a vault switch.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let abs = vault::resolve_in_vault(&vault, &path)?;
    let removed = notefile::delete_folder_if_empty(&vault, &path)?;
    if removed {
        index.lock().unwrap().remove_note(&vault, &abs)?;
    }
    Ok(removed)
}

#[tauri::command]
pub async fn delete_path(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    // Epoch-pinned for the same reason as `rename_path`, and it matters more here:
    // a delete that lands in the wrong vault destroys a file at the same relative
    // path in a vault the user wasn't even looking at.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let abs = vault::resolve_in_vault(&vault, &path)?;
    notefile::delete_path(&vault, &path)?;
    index.lock().unwrap().remove_note(&vault, &abs)?;
    Ok(())
}

// ---- query commands -------------------------------------------------------

#[tauri::command]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: String,
) -> AppResult<Vec<SearchResult>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.search_notes(&query)
}

#[tauri::command]
pub async fn get_backlinks(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<Vec<Backlink>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.get_backlinks(&note_id)
}

/// Every resolved edge of the note graph in one call — backs the Graph view so
/// it no longer fires one `get_backlinks` per note.
#[tauri::command]
pub async fn graph_edges(state: State<'_, AppState>) -> AppResult<Vec<GraphEdge>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.graph_edges()
}

/// The edges touching the given notes only — the Graph view's per-change delta
/// (#83), so an edit to one note no longer re-reads the whole edge set.
#[tauri::command]
pub async fn graph_edges_for(
    state: State<'_, AppState>,
    note_ids: Vec<String>,
) -> AppResult<Vec<GraphEdge>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.graph_edges_for(&note_ids)
}

#[tauri::command]
pub async fn get_note_meta(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<NoteMeta>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.get_note_meta(&path)
}

#[tauri::command]
pub async fn resolve_wikilink(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<Option<ResolvedLink>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.resolve_wikilink(&name)
}

#[tauri::command]
pub async fn list_note_titles(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<NoteTitle>> {
    // Epoch-pinned like `list_tree`: the registry uses these ids as the doc_ids it
    // registers server-side, so the wrong vault's ids would fork every note.
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.list_note_titles()
}

// ---- CRDT persistence commands (Phase 1, spec 02 §4) ----------------------
//
// Binary Yjs updates cross the IPC boundary as JSON number arrays (Vec<u8>).
// The TS bridge owns all Yjs semantics; these commands are a thin durable store.

#[tauri::command]
pub async fn append_yjs_update(
    state: State<'_, AppState>,
    doc_id: String,
    update: Vec<u8>,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    // The CRDT log lives in the vault's own `.context/index.sqlite`, so an
    // epoch-less append that crossed a switch would file vault A's doc history
    // under vault B.
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.append_yjs_update(&doc_id, &update)
}

#[tauri::command]
pub async fn load_yjs_state(
    state: State<'_, AppState>,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<YjsState> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.load_yjs_state(&doc_id)
}

#[tauri::command]
pub async fn save_yjs_snapshot(
    state: State<'_, AppState>,
    doc_id: String,
    snapshot: Vec<u8>,
    state_vector: Vec<u8>,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.save_yjs_snapshot(&doc_id, &snapshot, &state_vector)
}

/// Persist a batch of per-doc Yjs state vectors (the durable sync manifest).
///
/// Batched on purpose: the vault-wide background feed touches many docs, and one
/// IPC round trip + one SQLite transaction for the batch is what keeps that off
/// the hot path. Epoch-pinned like every other CRDT write — the manifest lives in
/// the vault's own `.context/index.sqlite`.
#[tauri::command]
pub async fn save_yjs_state_vectors(
    state: State<'_, AppState>,
    entries: Vec<(String, Vec<u8>)>,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.save_yjs_state_vectors(&entries)
}

/// Discard one doc's local CRDT (the local half of an oversized-note repair).
#[tauri::command]
pub async fn clear_yjs_doc(
    state: State<'_, AppState>,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.clear_yjs_doc(&doc_id)
}

/// Collect dead CRDT docs, then reclaim the file.
///
/// `live` is the caller's COMPLETE set of doc ids still in use — the TS registry
/// owns that map (`.context/config.json`), which is why this is driven from the
/// UI layer rather than derived here: Rust's `notes.id` and the server's
/// `doc_id` are not guaranteed to be the same value in a vault whose index was
/// built before it was registered, so a Rust-side guess would delete live docs.
///
/// One command rather than two so a caller cannot prune and then skip the
/// vacuum, which is the combination that frees nothing a user can see.
#[tauri::command]
pub async fn prune_yjs_docs(
    state: State<'_, AppState>,
    live: Vec<String>,
    expected_epoch: Option<u64>,
) -> AppResult<YjsPruneReport> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    let mut report = guard.prune_yjs_docs(&live)?;
    // Only rewrite the file when the prune actually freed something; VACUUM on a
    // clean 900 MB database is minutes of pointless I/O on every vault open.
    if report.docs_removed > 0 || report.updates_removed > 0 {
        report.bytes_reclaimed = guard.vacuum()?;
    }
    Ok(report)
}

/// Every state vector this vault holds, for the sync engine's `hello` manifest.
#[tauri::command]
pub async fn list_yjs_state_vectors(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<YjsStateVector>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.list_yjs_state_vectors()
}

// ---- Attachment I/O (Phase 3 blob store, spec 02 §2) ----------------------
//
// Raw bytes cross the IPC boundary as JSON number arrays (Vec<u8>), like the
// Yjs updates above. Every path is validated to stay inside the vault. These
// never touch the note/CRDT pipeline.

#[tauri::command]
pub async fn read_binary_file(
    state: State<'_, AppState>,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<u8>> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::read_binary_file(&vault, &rel_path)
}

#[tauri::command]
pub async fn write_binary_file(
    state: State<'_, AppState>,
    rel_path: String,
    bytes: Vec<u8>,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::write_binary_file(&vault, &rel_path, &bytes)
}

#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<AttachmentMeta>> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::list_attachments(&vault)
}

/// Read an arbitrary host file the user just dropped/picked (absolute path).
/// Unlike `read_binary_file` this is NOT vault-scoped — the bytes are on their
/// way into an attachment; the path came from a user drag-drop, not the tree.
#[tauri::command]
pub async fn read_external_file(path: String) -> AppResult<Vec<u8>> {
    std::fs::read(&path).map_err(|e| AppError::new(format!("read external file failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault opened at a filesystem/drive root has no `file_name`; its label
    /// must fall back to the path itself, never the anonymous "vault".
    #[test]
    fn vault_info_names_filesystem_roots() {
        // Ordinary folder: the folder's own name.
        let v = vault_info(Path::new("/home/me/Notes"), 1);
        assert_eq!(v.name, "Notes");
        // Unix root: nothing to trim — keep the path.
        let v = vault_info(Path::new("/"), 1);
        assert_eq!(v.name, "/");
        // Windows drive root (verbatim string, host-independent): trailing
        // separator trimmed so the label reads "D:".
        assert_eq!(root_label("D:\\"), "D:");
        assert_eq!(root_label("/"), "/");
    }

    /// The rediscovery probe must identify a vault folder without opening it,
    /// and must answer None (never an error) for everything that isn't one —
    /// a scan over recents can't have one bad candidate abort the whole pass.
    #[test]
    fn peek_vault_config_reads_without_opening() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("my-vault");
        std::fs::create_dir_all(vault.join(".context")).unwrap();
        std::fs::write(
            vault.join(".context").join("config.json"),
            r#"{"organizationId":"org-1"}"#,
        )
        .unwrap();

        // A vault folder: raw config comes back.
        let got = peek_vault_config(vault.to_string_lossy().to_string()).unwrap();
        assert_eq!(got.as_deref(), Some(r#"{"organizationId":"org-1"}"#));

        // A plain folder (no .context): None.
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            peek_vault_config(plain.to_string_lossy().to_string()).unwrap(),
            None
        );

        // A path that doesn't exist / isn't a directory: None, not an error.
        let missing = dir.path().join("gone");
        assert_eq!(
            peek_vault_config(missing.to_string_lossy().to_string()).unwrap(),
            None
        );
        let file = dir.path().join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            peek_vault_config(file.to_string_lossy().to_string()).unwrap(),
            None
        );
    }

    /// Two vaults may share a name (identity is the doc_ids, not the name), so
    /// a taken folder must not make the name un-typeable — it takes a suffix.
    #[test]
    fn free_vault_dir_suffixes_a_taken_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Free name: used exactly as typed.
        assert_eq!(free_vault_dir(root, "hey").unwrap(), root.join("hey"));
        // Taken twice over: the first free suffix wins, and the user's name
        // stays recognizable in it.
        std::fs::create_dir_all(root.join("hey")).unwrap();
        assert_eq!(free_vault_dir(root, "hey").unwrap(), root.join("hey 2"));
        std::fs::create_dir_all(root.join("hey 2")).unwrap();
        assert_eq!(free_vault_dir(root, "hey").unwrap(), root.join("hey 3"));
        // A file (not a folder) in the way still counts as taken — creating the
        // vault there would fail.
        std::fs::write(root.join("note"), "x").unwrap();
        assert_eq!(free_vault_dir(root, "note").unwrap(), root.join("note 2"));
    }

    /// `folder_exists` is what tells "bound folder moved" (rediscover) from
    /// "folder present but failed to open" (prompt) — a file must not count.
    #[test]
    fn folder_exists_is_directories_only() {
        let dir = tempfile::tempdir().unwrap();
        assert!(folder_exists(dir.path().to_string_lossy().to_string()).unwrap());
        let file = dir.path().join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!folder_exists(file.to_string_lossy().to_string()).unwrap());
        assert!(!folder_exists(
            dir.path().join("gone").to_string_lossy().to_string()
        )
        .unwrap());
    }

    /// A config.json written before the `workspace_root` → `vaults_root` rename
    /// must still load, so upgrading users keep their managed-root path instead
    /// of silently falling back to the default and orphaning their vaults.
    #[test]
    fn app_config_loads_legacy_workspace_root_alias() {
        let legacy = r#"{"workspace_root": "/home/me/Documents/Baalda Vaults"}"#;
        let cfg: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            cfg.vaults_root.as_deref(),
            Some("/home/me/Documents/Baalda Vaults")
        );
    }

    /// A caller that pins the epoch it started under is accepted only while that
    /// vault is still the open one — this is what stops an in-flight sync write
    /// from landing in the vault the user just switched to.
    #[test]
    fn check_epoch_rejects_a_stale_pin() {
        assert!(check_epoch(Some(7), 7).is_ok());
        let err = check_epoch(Some(7), 8).unwrap_err();
        assert!(
            err.0.starts_with(VAULT_MISMATCH),
            "mismatch must be recognisable by the TS sync layer: {}",
            err.0
        );
        // A vault opened while the caller was mid-flight, then re-opened back to
        // the same folder, still counts as a different epoch (paths repeat, epochs
        // don't).
        assert!(check_epoch(Some(1), 3).is_err());
    }

    /// Unpinned callers (UI reads, user-driven edits) keep the legacy behaviour:
    /// resolve against whatever vault is open. Enforcement is opt-in.
    #[test]
    fn check_epoch_ignores_an_absent_pin() {
        assert!(check_epoch(None, 0).is_ok());
        assert!(check_epoch(None, 42).is_ok());
    }

    /// `epoch` must survive the camelCase serialization the UI receives.
    #[test]
    fn vault_info_serializes_the_epoch() {
        let json = serde_json::to_string(&vault_info(Path::new("/tmp/My Vault"), 5)).unwrap();
        assert!(json.contains("\"epoch\":5"), "{json}");
        assert!(json.contains("\"name\":\"My Vault\""), "{json}");
    }

    /// The current field name deserializes, and a round-trip writes it back
    /// under the new `vaults_root` key (not the legacy alias).
    #[test]
    fn app_config_round_trips_vaults_root() {
        let current = r#"{"vaults_root": "/tmp/vaults"}"#;
        let cfg: AppConfig = serde_json::from_str(current).unwrap();
        assert_eq!(cfg.vaults_root.as_deref(), Some("/tmp/vaults"));

        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("vaults_root"));
        assert!(!json.contains("workspace_root"));
    }
}
