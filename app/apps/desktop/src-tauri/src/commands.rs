//! The Tauri command surface — the entire Phase 0 disk + index API exposed to
//! the React UI. All disk I/O happens here (or in the modules these call);
//! the UI never touches the filesystem directly.

use crate::attachments::{self, AttachmentMeta};
use crate::error::{AppError, AppResult};
use crate::import_export::{self, ImportSummary};
use crate::index::{Backlink, Index, NoteMeta, NoteTitle, ResolvedLink, SearchResult, YjsState};
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
    /// Root directory the app manages: one persistent subfolder per workspace,
    /// plus a stable `current` symlink repointed to the active workspace so
    /// external tools (e.g. Claude Desktop MCP) can target one fixed path.
    #[serde(default)]
    workspace_root: Option<String>,
}

// ---- helpers --------------------------------------------------------------

fn require_vault(state: &State<AppState>) -> AppResult<(PathBuf, Arc<Mutex<Index>>)> {
    let inner = state.inner.lock().unwrap();
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

fn vault_info(path: &Path) -> VaultInfo {
    VaultInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("vault")
            .to_string(),
    }
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

    let index = Index::open(&path)?;
    index.rebuild(&path)?;
    let index = Arc::new(Mutex::new(index));

    let watcher = watcher::start(path.clone(), index.clone(), app.clone())?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.vault = Some(path.clone());
        inner.index = Some(index);
        inner.watcher = Some(watcher); // replaces & drops any previous watcher
    }

    let info = vault_info(&path);
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

/// The last-opened vault path from config (None on first launch).
#[tauri::command]
pub fn get_last_vault(app: AppHandle) -> AppResult<Option<VaultInfo>> {
    let cfg = read_config(&app);
    Ok(cfg.last_vault.and_then(|p| {
        let path = PathBuf::from(p);
        path.is_dir().then(|| vault_info(&path))
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
                    name: vault_info(&path).name,
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

/// Create a brand-new empty vault folder `<parent>/<name>` and open it.
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
    let dir = PathBuf::from(&parent).join(name);
    if dir.exists() {
        return Err(AppError::new("a folder with that name already exists"));
    }
    std::fs::create_dir_all(&dir)?;
    open_vault_inner(&app, &state, dir)
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

// ---- workspace root + `current` pointer -----------------------------------
//
// A workspace (server org) maps 1:1 to a local folder. The app owns one root
// directory; each workspace gets a persistent subfolder under it, and switching
// workspaces repoints `<root>/current` at the active folder. Folders bound to a
// workspace before the root existed keep their original location — the root is
// only where *new* workspace folders are created.

/// User-visible name of the default managed-root folder. Layer-1 brand surface
/// (spec: rebrand policy) — the one place the default root folder name is set.
const DEFAULT_ROOT_DIR_NAME: &str = "Baalda Vaults";

/// Default managed root: `<home>/Documents/Baalda Vaults`. Lives under Documents
/// so it's easy to find in the OS file browser (Finder/Explorer both surface
/// Documents in their sidebar) instead of being buried at the top of home.
fn default_workspace_root(app: &AppHandle) -> AppResult<PathBuf> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| AppError::new(format!("no home dir: {e}")))?;
    Ok(home.join("Documents").join(DEFAULT_ROOT_DIR_NAME))
}

/// The effective workspace root, auto-initialized to the default and persisted
/// on first read so the rest of the app can rely on it always existing.
#[tauri::command]
pub fn get_workspace_root(app: AppHandle) -> AppResult<String> {
    let mut cfg = read_config(&app);
    let root = match cfg.workspace_root.clone() {
        Some(r) => PathBuf::from(r),
        None => {
            let d = default_workspace_root(&app)?;
            cfg.workspace_root = Some(d.to_string_lossy().to_string());
            d
        }
    };
    let _ = write_config(&app, &cfg);
    std::fs::create_dir_all(&root)?;
    Ok(root.to_string_lossy().to_string())
}

/// Change the managed root (existing workspace folders keep their location;
/// only newly created ones land under the new root).
#[tauri::command]
pub fn set_workspace_root(app: AppHandle, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p)?;
    let mut cfg = read_config(&app);
    cfg.workspace_root = Some(p.to_string_lossy().to_string());
    write_config(&app, &cfg)
}

/// Native folder picker for the managed root; persists and returns it.
#[tauri::command]
pub async fn pick_workspace_root(app: AppHandle) -> AppResult<Option<String>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    std::fs::create_dir_all(&path)?;
    let mut cfg = read_config(&app);
    cfg.workspace_root = Some(path.to_string_lossy().to_string());
    write_config(&app, &cfg)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Native folder picker that only returns the chosen path (does NOT open it as
/// a vault). Used to let the user pick the local folder for a workspace, which
/// is then opened via `open_workspace_folder`.
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
) -> AppResult<ImportSummary> {
    let (vault, index) = require_vault(&state)?;
    let summary = import_export::import_paths(&vault, &dest, &sources);
    // Index every new note under the imported top-level items.
    let guard = index.lock().unwrap();
    for rel in &summary.imported {
        if let Ok(abs) = vault::resolve_in_vault(&vault, rel) {
            index_md_tree(&guard, &vault, &abs);
        }
    }
    Ok(summary)
}

/// Recursively index every `.md` file at/under `abs` (best-effort).
fn index_md_tree(index: &Index, vault: &Path, abs: &Path) {
    if abs.is_dir() {
        if let Ok(entries) = std::fs::read_dir(abs) {
            for entry in entries.flatten() {
                index_md_tree(index, vault, &entry.path());
            }
        }
    } else if abs.extension().and_then(|e| e.to_str()) == Some("md") {
        let _ = index.index_note(vault, abs);
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
) -> AppResult<()> {
    let (vault, _) = require_vault(&state)?;
    import_export::export_path(&vault, &rel, &dest)
}

/// Open a workspace's folder: ensure it exists, repoint `<root>/current` at it,
/// then open it as the active vault. The folder may live anywhere (a legacy
/// folder bound before the root existed), but `current` always tracks it.
#[tauri::command]
pub async fn open_workspace_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<VaultInfo> {
    let folder = PathBuf::from(&path);
    std::fs::create_dir_all(&folder)?;
    if let Some(root) = read_config(&app).workspace_root {
        repoint_current(Path::new(&root), &folder);
    }
    open_vault_inner(&app, &state, folder)
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
            eprintln!("[workspace] `current` is not a symlink; leaving it in place");
            return;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            eprintln!("[workspace] cannot stat `current`: {e}");
            return;
        }
    }
    #[cfg(unix)]
    if let Err(e) = std::os::unix::fs::symlink(target, &link) {
        eprintln!("[workspace] symlink failed: {e}");
    }
    #[cfg(windows)]
    if let Err(e) = std::os::windows::fs::symlink_dir(target, &link) {
        eprintln!("[workspace] symlink_dir failed: {e}");
    }
}

/// Raw contents of the open vault's `.context/config.json`, or None if absent.
/// The TS sync layer owns the schema (server vault id + doc-id mapping); Rust is
/// a dumb reader/writer so the registry mapping travels with the vault, not the
/// app profile (spec 03 §5 "store server vault id in .context/config.json").
#[tauri::command]
pub async fn get_vault_config(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let (vault, _) = require_vault(&state)?;
    let p = vault.join(".context").join("config.json");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Overwrite the open vault's `.context/config.json` with `content`.
#[tauri::command]
pub async fn set_vault_config(state: State<'_, AppState>, content: String) -> AppResult<()> {
    let (vault, _) = require_vault(&state)?;
    let dir = vault.join(".context");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("config.json"), content)?;
    Ok(())
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
pub async fn list_tree(state: State<'_, AppState>) -> AppResult<TreeNode> {
    let (vault, _) = require_vault(&state)?;
    tree::list_tree(&vault)
}

#[tauri::command]
pub async fn read_note(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let (vault, _) = require_vault(&state)?;
    notefile::read_note(&vault, &path)
}

#[tauri::command]
pub async fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> AppResult<()> {
    let (vault, index) = require_vault(&state)?;
    notefile::write_note(&vault, &path, &content)?;
    // Re-index immediately so search/backlinks are fresh without waiting for
    // the watcher echo.
    let abs = vault::resolve_in_vault(&vault, &path)?;
    index.lock().unwrap().index_note(&vault, &abs)?;
    Ok(())
}

#[tauri::command]
pub async fn create_note(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> AppResult<String> {
    let (vault, index) = require_vault(&state)?;
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
) -> AppResult<String> {
    let (vault, _) = require_vault(&state)?;
    notefile::create_folder(&vault, &parent, &name)
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<String> {
    let (vault, index) = require_vault(&state)?;
    let old_abs = vault::resolve_in_vault(&vault, &from)?;
    let new_rel = notefile::rename_path(&vault, &from, &to)?;
    let new_abs = vault::resolve_in_vault(&vault, &new_rel)?;
    // Keep doc_id stable across the move (file or folder subtree).
    index.lock().unwrap().rename_note(&vault, &old_abs, &new_abs)?;
    Ok(new_rel)
}

#[tauri::command]
pub async fn delete_path(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let (vault, index) = require_vault(&state)?;
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
pub async fn list_note_titles(state: State<'_, AppState>) -> AppResult<Vec<NoteTitle>> {
    let (_, index) = require_vault(&state)?;
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
) -> AppResult<()> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.append_yjs_update(&doc_id, &update)
}

#[tauri::command]
pub async fn load_yjs_state(state: State<'_, AppState>, doc_id: String) -> AppResult<YjsState> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.load_yjs_state(&doc_id)
}

#[tauri::command]
pub async fn save_yjs_snapshot(
    state: State<'_, AppState>,
    doc_id: String,
    snapshot: Vec<u8>,
    state_vector: Vec<u8>,
) -> AppResult<()> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.save_yjs_snapshot(&doc_id, &snapshot, &state_vector)
}

// ---- Attachment I/O (Phase 3 blob store, spec 02 §2) ----------------------
//
// Raw bytes cross the IPC boundary as JSON number arrays (Vec<u8>), like the
// Yjs updates above. Every path is validated to stay inside the vault. These
// never touch the note/CRDT pipeline.

#[tauri::command]
pub async fn read_binary_file(state: State<'_, AppState>, rel_path: String) -> AppResult<Vec<u8>> {
    let (vault, _) = require_vault(&state)?;
    attachments::read_binary_file(&vault, &rel_path)
}

#[tauri::command]
pub async fn write_binary_file(
    state: State<'_, AppState>,
    rel_path: String,
    bytes: Vec<u8>,
) -> AppResult<()> {
    let (vault, _) = require_vault(&state)?;
    attachments::write_binary_file(&vault, &rel_path, &bytes)
}

#[tauri::command]
pub async fn list_attachments(state: State<'_, AppState>) -> AppResult<Vec<AttachmentMeta>> {
    let (vault, _) = require_vault(&state)?;
    attachments::list_attachments(&vault)
}

/// Read an arbitrary host file the user just dropped/picked (absolute path).
/// Unlike `read_binary_file` this is NOT vault-scoped — the bytes are on their
/// way into an attachment; the path came from a user drag-drop, not the tree.
#[tauri::command]
pub async fn read_external_file(path: String) -> AppResult<Vec<u8>> {
    std::fs::read(&path).map_err(|e| AppError::new(format!("read external file failed: {e}")))
}
