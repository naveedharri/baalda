//! The Tauri command surface — the entire Phase 0 disk + index API exposed to
//! the React UI. All disk I/O happens here (or in the modules these call);
//! the UI never touches the filesystem directly.

use crate::attachments::{self, AttachmentMeta};
use crate::error::{AppError, AppResult};
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

#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    last_vault: Option<String>,
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

/// One-time migration for the rebrand: earlier builds kept vault state under
/// `.opencontext/`. If that dir exists and `.context/` does not, rename it in
/// place before the index opens — same contents (index.sqlite, config.json),
/// just the new name. Best-effort, non-fatal on failure.
fn migrate_vault_dir(vault: &Path) {
    let old = vault.join(".opencontext");
    let new = vault.join(".context");
    if old.is_dir() && !new.exists() {
        if let Err(e) = std::fs::rename(&old, &new) {
            eprintln!("[vault] .opencontext -> .context migration failed: {e}");
        }
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

    migrate_vault_dir(&path);
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
    // Preserve other config keys (e.g. server_url) when updating last_vault.
    let mut cfg = read_config(app);
    cfg.last_vault = Some(info.path.clone());
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

/// Legacy managed-root folder name under the user's home directory. Kept only
/// for the one-time `OpenContext -> Baalda` rebrand migration below; new installs
/// use `DEFAULT_ROOT_DIR_NAME` under Documents instead.
const MANAGED_ROOT_DIR_NAME: &str = "Baalda";

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

/// One-time migration for the rebrand: earlier builds managed `<home>/OpenContext`.
/// If that folder exists and `<home>/Baalda` does not, rename it in place, then
/// repoint a `current` symlink still pointing inside the old root, and fix up a
/// persisted config value that still names the old path. Best-effort — every
/// failure is logged and non-fatal, matching `repoint_current` below.
fn migrate_managed_root(app: &AppHandle, cfg: &mut AppConfig) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let old_root = home.join("OpenContext");
    let new_root = home.join(MANAGED_ROOT_DIR_NAME);

    if old_root.is_dir() && !new_root.exists() {
        match std::fs::rename(&old_root, &new_root) {
            Ok(()) => {
                // If `current` inside the (now-moved) root still points somewhere
                // under the old root path, recreate it pointing at the new root.
                let link = new_root.join("current");
                if let Ok(target) = std::fs::read_link(&link) {
                    if let Ok(suffix) = target.strip_prefix(&old_root) {
                        let new_target = new_root.join(suffix);
                        let _ = std::fs::remove_file(&link);
                        #[cfg(unix)]
                        if let Err(e) = std::os::unix::fs::symlink(&new_target, &link) {
                            eprintln!("[workspace] migration symlink repoint failed: {e}");
                        }
                        #[cfg(windows)]
                        if let Err(e) = std::os::windows::fs::symlink_dir(&new_target, &link) {
                            eprintln!("[workspace] migration symlink_dir repoint failed: {e}");
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[workspace] managed-root migration (OpenContext -> Baalda) failed: {e}");
            }
        }
    }

    // A persisted config may still name the old path even if the folder itself
    // was already renamed (or just got renamed above).
    if let Some(r) = &cfg.workspace_root {
        if PathBuf::from(r) == old_root && new_root.exists() {
            cfg.workspace_root = Some(new_root.to_string_lossy().to_string());
        }
    }
}

/// The effective workspace root, auto-initialized to the default and persisted
/// on first read so the rest of the app can rely on it always existing.
#[tauri::command]
pub fn get_workspace_root(app: AppHandle) -> AppResult<String> {
    let mut cfg = read_config(&app);
    migrate_managed_root(&app, &mut cfg);
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
