//! The Tauri command surface — the entire Phase 0 disk + index API exposed to
//! the React UI. All disk I/O happens here (or in the modules these call);
//! the UI never touches the filesystem directly.

use crate::attachments::{self, AttachmentMeta, FileStat};
use crate::error::{io_ctx, AppError, AppResult};
use crate::import_export::{self, ImportSummary};
use crate::index::{
    Backlink, BootstrapRow, FileRow, FileText, GraphEdge, Index, NoteMeta, NoteTitle, ResolvedLink,
    SearchResult, YjsPruneReport, YjsState, YjsStateVector,
};
use crate::notefile::{self, WriteOutcome};
use crate::state::AppState;
use crate::checks::{self, EmptyTrashReport, VaultChecks};
use crate::stats::{self, VaultStats};
use crate::tree::{self, TreeNode};
use crate::{vault, watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// How many times the background index rebuild retries a BUSY database, and the
/// first backoff step (doubled per attempt: 500ms, 1s, 2s). See the retry loop in
/// `open_vault_inner` for why a locked database is worth retrying rather than
/// reporting.
const REBUILD_BUSY_RETRIES: u32 = 3;
const REBUILD_BUSY_BACKOFF_MS: u64 = 500;

/// Per-phase timings of one `open_vault`, in whole ms.
///
/// Returned on `VaultInfo` rather than only logged: `log::info!` reaches the
/// `tauri dev` terminal (tauri_plugin_log is registered for debug builds only,
/// see lib.rs), and the numbers that decide anything are the ones a shipped
/// install can report. `None` on the infos that open nothing (`get_last_vault`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenTiming {
    /// `Index::open` + `migrate`.
    pub index_open_ms: u64,
    /// `watcher::start` — creating the recursive `notify` watch.
    pub watcher_ms: u64,
    /// Spawning the rebuild thread and waiting for it to hold the index lock
    /// (the `ready` handshake in `open_vault_inner`).
    pub publish_ms: u64,
    /// Reading + rewriting the app config's recents list.
    pub config_ms: u64,
    pub total_ms: u64,
}

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
    /// How long each phase of the open that produced this info took. Absent on
    /// the infos that open nothing, so the UI can tell a real open's numbers
    /// from a config read's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<OpenTiming>,
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

/// Log a `load_yjs_state` past this payload size. The largest doc on the vault
/// this was measured against holds 17.7 MB of CRDT and ~40 docs are over 1 MB;
/// below that the line is noise, above it it is the number that explains a slow
/// note open on someone else's install.
const LARGE_DOC_LOG_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
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

/// Path of the app's own `config.json`, resolved (and its directory created)
/// once per process.
///
/// `app_config_dir()` + `create_dir_all` is a syscall pair, and it used to be
/// charged on every single `read_config` — thirteen-plus times per launch, for a
/// directory that exists after the first one.
///
/// **Fallback (#128).** On Windows `app_config_dir()` is under `%APPDATA%` — the
/// *roaming* profile, and therefore precisely the directory a redirected/roaming
/// profile or a OneDrive Known Folder Move can point somewhere this process
/// cannot create or write under. A failure there used to abort the whole vault
/// open with an unattributed "The system cannot find the file specified.
/// (os error 2)". So when it is unusable we fall back to `app_local_data_dir()`
/// (`%LOCALAPPDATA%\<bundle id>` on Windows — never roamed, never redirected by
/// KFM; `~/Library/Application Support/<bundle id>` on macOS,
/// `$XDG_DATA_HOME/<bundle id>` on Linux).
///
/// Deliberately NOT the vault's own `.context/`, the other obvious candidate:
/// this file holds the recents list, the server URL and the vaults root, it has
/// to be readable BEFORE any vault is open (that is how the app decides which
/// vault to open), and `.context/config.json` is already a *different*,
/// vault-scoped file that travels with the vault — putting account-shaped state
/// there would sync it to whoever the folder is shared with.
///
/// Both paths are logged, and if neither works the contextual error is returned
/// rather than the config being silently dropped.
fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    static PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(p) = PATH.get() {
        return Ok(p.clone());
    }
    let primary = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(format!("Couldn't locate the settings folder: {e}")));
    let primary_err = match &primary {
        Ok(dir) => match prepare_config_dir(dir) {
            Ok(()) => return Ok(PATH.get_or_init(|| dir.join("config.json")).clone()),
            Err(e) => e.to_string(),
        },
        Err(e) => e.to_string(),
    };
    // Loud, because the app is now keeping its settings somewhere the user (and
    // the next person debugging this) would not look first.
    log::warn!("[config] the settings folder is unusable ({primary_err}) — falling back to the local app-data folder");
    let fallback = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::new(format!("Couldn't locate the local app-data folder: {e}")))?;
    prepare_config_dir(&fallback)
        .map_err(|e| AppError::new(format!("{primary_err} — and the fallback failed too: {e}")))?;
    log::warn!(
        "[config] using the fallback settings folder {}",
        fallback.display()
    );
    Ok(PATH.get_or_init(|| fallback.join("config.json")).clone())
}

/// Create `dir` and prove a file can actually be written in it.
///
/// `create_dir_all` returning Ok is not the same as the directory being usable —
/// a redirected profile or an offline network home can hand back a path that
/// exists and refuses writes — and the point of the fallback above is to find
/// that out once, at resolve time, rather than on the first `write_config`,
/// which happens in the middle of a vault open.
fn prepare_config_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir).map_err(io_ctx("create the settings folder", dir))?;
    let probe = dir.join(".write-test");
    std::fs::write(&probe, b"").map_err(io_ctx("write to the settings folder", dir))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn load_config_from_disk(app: &AppHandle) -> AppConfig {
    // Every failure here silently costs the user their recents, server URL and
    // vaults root, so each one says so in the log rather than defaulting mutely.
    let path = match config_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[config] no settings file ({e}) — using defaults for this session");
            return AppConfig::default();
        }
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!(
                "[config] {} is not readable JSON ({e}) — using defaults",
                path.display()
            );
            AppConfig::default()
        }),
        // First launch: nothing written yet. Not a problem, not worth a line.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
        Err(e) => {
            log::warn!(
                "[config] couldn't read {} ({e}) — using defaults",
                path.display()
            );
            AppConfig::default()
        }
    }
}

/// The app config, from `AppState`'s cache after the first read (see
/// `AppState::config` for why the cache is sound).
fn read_config(app: &AppHandle, state: &State<AppState>) -> AppConfig {
    if let Some(cfg) = state.config.lock().unwrap().as_ref() {
        return cfg.clone();
    }
    let cfg = load_config_from_disk(app);
    *state.config.lock().unwrap() = Some(cfg.clone());
    cfg
}

fn write_config(app: &AppHandle, state: &State<AppState>, cfg: &AppConfig) -> AppResult<()> {
    let p = config_path(app)?;
    std::fs::write(&p, serde_json::to_string_pretty(cfg)?)
        .map_err(io_ctx("write the settings file", &p))?;
    *state.config.lock().unwrap() = Some(cfg.clone());
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
        timing: None,
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
pub async fn get_vault_epoch(state: State<'_, AppState>) -> AppResult<u64> {
    Ok(state.inner.lock().unwrap().vault_epoch)
}

/// Open a vault: build/refresh its index, start the watcher, remember it, and
/// emit `vault-opened`. Shared by `pick_vault` and `open_vault`.
///
/// Thin wrapper over [`open_vault_impl`] so that EVERY failure of an open lands
/// in the log with the folder that was being opened. This is the funnel both
/// buttons of the vault-setup prompt come through, and in #128 a Windows user
/// saw only "The system cannot find the file specified. (os error 2)" with no
/// record anywhere of which step or which path produced it.
fn open_vault_inner(app: &AppHandle, state: &State<AppState>, path: PathBuf) -> AppResult<VaultInfo> {
    let attempted = path.display().to_string();
    open_vault_impl(app, state, path).map_err(|e| {
        log::error!("[open_vault] failed for {attempted}: {e}");
        e
    })
}

fn open_vault_impl(app: &AppHandle, state: &State<AppState>, path: PathBuf) -> AppResult<VaultInfo> {
    if !path.is_dir() {
        return Err(AppError::new(format!(
            "Couldn't open the folder {}: it isn't a folder (it may have been moved, renamed or deleted)",
            path.display()
        )));
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

    let opened_at = std::time::Instant::now();
    let index = Arc::new(Mutex::new(Index::open(&path)?));
    let index_open_ms = opened_at.elapsed().as_millis() as u64;

    // The watcher first, so nothing that changes during the rebuild below is
    // missed: its drain thread queues behind the same index lock and re-indexes
    // any file the rebuild may have seen too (idempotent).
    let watcher_started = std::time::Instant::now();
    let watcher = watcher::start(path.clone(), index.clone(), app.clone())?;
    let watcher_ms = watcher_started.elapsed().as_millis() as u64;

    let publish_started = std::time::Instant::now();
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
        // The rebuild reconciles the `files` table but extracts nothing — vault
        // open must not pay for parsing every document in the vault — so it
        // hands the stale paths to the extraction worker, which does that off
        // this thread and outside the index mutex.
        let bg_queue = watcher.extract_queue();
        std::thread::spawn(move || {
            let guard = bg_index.lock().unwrap();
            let _ = ready_tx.send(());
            let started = std::time::Instant::now();
            // A busy database is a TIMING failure, not a broken vault, and it must
            // not be permanent: this thread holds the process-wide index mutex, so
            // `SQLITE_BUSY` here means a SECOND connection to the same file is
            // mid-write — the previous open's `Index` (and its watcher drain
            // thread) still winding down after a switch back to a vault. Past the
            // 5s `busy_timeout` rusqlite surfaces that as an error, and a single
            // attempt left the index stale for the rest of the session: titles,
            // search and backlinks all answer from it, and a vault switch is
            // exactly when it has the most catching up to do.
            //
            // `rebuild` is idempotent and preserves doc_ids, so retrying is safe.
            // The sleeps deliberately keep the mutex: giving it up would let a UI
            // reader see the stale index and render wrong titles, which is the
            // thing the whole ready-handshake above exists to prevent.
            let mut result = guard.rebuild(&bg_path);
            for attempt in 1..=REBUILD_BUSY_RETRIES {
                let busy = match &result {
                    Ok(_) => false,
                    Err(e) => {
                        let m = e.to_string().to_ascii_lowercase();
                        m.contains("locked") || m.contains("busy")
                    }
                };
                if !busy {
                    break;
                }
                eprintln!(
                    "[index] rebuild found {} busy (attempt {attempt}/{REBUILD_BUSY_RETRIES}) — retrying",
                    bg_path.display()
                );
                std::thread::sleep(std::time::Duration::from_millis(
                    REBUILD_BUSY_BACKOFF_MS << (attempt - 1),
                ));
                result = guard.rebuild(&bg_path);
            }
            drop(guard);
            let ok = match result {
                Ok(pending) => {
                    bg_queue.enqueue(pending);
                    true
                }
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

    let publish_ms = publish_started.elapsed().as_millis() as u64;

    let config_started = std::time::Instant::now();
    let mut info = vault_info(&path, epoch);
    // Preserve other config keys (e.g. server_url) when updating recents.
    let mut cfg = read_config(app, state);
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
    write_config(app, state, &cfg)?;
    let config_ms = config_started.elapsed().as_millis() as u64;
    let total_ms = opened_at.elapsed().as_millis() as u64;

    info.timing = Some(OpenTiming {
        index_open_ms,
        watcher_ms,
        publish_ms,
        config_ms,
        total_ms,
    });
    // One line per open. Everything but the background rebuild used to be
    // unmeasured on a real machine, so "launching is slow" had no numbers.
    log::info!(
        "[open_vault] {} — index_open {index_open_ms}ms watcher {watcher_ms}ms publish {publish_ms}ms config {config_ms}ms total {total_ms}ms",
        path.display()
    );
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
pub async fn get_last_vault(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<VaultInfo>> {
    let cfg = read_config(&app, &state);
    let epoch = state.inner.lock().unwrap().vault_epoch;
    Ok(cfg.last_vault.and_then(|p| {
        let path = PathBuf::from(p);
        path.is_dir().then(|| vault_info(&path, epoch))
    }))
}

/// Recently opened vaults, newest first, pruned to those that still exist on
/// disk. Migrates a legacy `last_vault` into the list on first read.
#[tauri::command]
pub async fn get_recent_vaults(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<RecentVault>> {
    let mut cfg = read_config(&app, &state);

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
        let _ = write_config(&app, &state, &cfg);
    }

    Ok(cfg.recent_vaults)
}

/// Remove one vault from the recents list (welcome-screen "×").
#[tauri::command]
pub async fn remove_recent_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<()> {
    let mut cfg = read_config(&app, &state);
    cfg.recent_vaults.retain(|r| r.path != path);
    if cfg.last_vault.as_deref() == Some(path.as_str()) {
        cfg.last_vault = None;
    }
    write_config(&app, &state, &cfg)
}

/// Move a local vault's folder — and all its notes — to the OS trash, then
/// forget it from the recents list. Used by the local-vault "Delete files"
/// action. This is the only copy of a local vault (no server), so we trash
/// (recoverable) instead of hard-deleting, and the UI gates it behind a
/// two-click confirm.
#[tauri::command]
pub async fn delete_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<()> {
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
    let mut cfg = read_config(&app, &state);
    cfg.recent_vaults.retain(|r| r.path != path);
    if cfg.last_vault.as_deref() == Some(path.as_str()) {
        cfg.last_vault = None;
    }
    write_config(&app, &state, &cfg)
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
    std::fs::create_dir_all(&dir).map_err(io_ctx("create the folder", &dir))?;
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
#[tauri::command(async)]
pub fn is_vault(path: String) -> AppResult<bool> {
    Ok(crate::vault::is_vault(std::path::Path::new(&path)))
}

/// The configured sync server base URL, if the user has set one.
#[tauri::command]
pub async fn get_server_url(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    Ok(read_config(&app, &state).server_url)
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
        .map_err(|e| AppError::new(format!("Couldn't locate your home folder: {e}")))?;
    Ok(home.join("Documents").join(DEFAULT_ROOT_DIR_NAME))
}

/// The effective vaults root, auto-initialized to the default and persisted
/// on first read so the rest of the app can rely on it always existing.
#[tauri::command]
pub async fn get_vaults_root(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let mut cfg = read_config(&app, &state);
    let root = match cfg.vaults_root.clone() {
        Some(r) => PathBuf::from(r),
        None => {
            let d = default_vaults_root(&app)?;
            cfg.vaults_root = Some(d.to_string_lossy().to_string());
            d
        }
    };
    let _ = write_config(&app, &state, &cfg);
    // `Documents\Baalda Vaults` on a default install — and the second of the
    // three #128 candidates, since a redirected/OneDrive-managed Documents is
    // exactly the kind of place `create_dir_all` fails on.
    std::fs::create_dir_all(&root).map_err(io_ctx("create the vaults folder", &root))?;
    Ok(root.to_string_lossy().to_string())
}

/// Change the managed vaults root (existing vault folders keep their location;
/// only newly created ones land under the new root).
#[tauri::command]
pub async fn set_vaults_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<()> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p).map_err(io_ctx("create the vaults folder", &p))?;
    let mut cfg = read_config(&app, &state);
    cfg.vaults_root = Some(p.to_string_lossy().to_string());
    write_config(&app, &state, &cfg)
}

/// Native folder picker for the managed vaults root; persists and returns it.
#[tauri::command]
pub async fn pick_vaults_root(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::new(format!("invalid folder: {e}")))?;
    std::fs::create_dir_all(&path).map_err(io_ctx("create the vaults folder", &path))?;
    let mut cfg = read_config(&app, &state);
    cfg.vaults_root = Some(path.to_string_lossy().to_string());
    write_config(&app, &state, &cfg)?;
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
    for (path, err) in guard.index_notes(&vault, &md_paths)?.failures {
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
        // The first thing BOTH vault-setup buttons do ("Open a folder…" reaches
        // here with the folder the user picked, "Start with an empty folder"
        // with one under the vaults root) — so this is the first of the three
        // places #128 could have been failing, and it now says which.
        std::fs::create_dir_all(&folder).map_err(io_ctx("create the folder", &folder))?;
    } else if !folder.is_dir() {
        return Err(AppError::new(format!(
            "Couldn't find the vault folder {path} — it may have been moved, renamed or deleted"
        )));
    }
    if let Some(root) = read_config(&app, &state).vaults_root {
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
pub async fn clear_last_vault(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let mut cfg = read_config(&app, &state);
    cfg.last_vault = None;
    write_config(&app, &state, &cfg)
}

/// Does this absolute path exist as a directory? Lets the vault-switch flow tell
/// "bound folder moved/deleted" (rediscover it) from "folder present but failed
/// to open" (surface the error) without attempting the open.
#[tauri::command(async)]
pub fn folder_exists(path: String) -> AppResult<bool> {
    Ok(Path::new(&path).is_dir())
}

/// Which vault a folder on disk belongs to, per its own `.context/config.json`.
/// Both fields are optional: a never-synced folder has neither, and a folder
/// written before the `organizationId` stamp existed has only the collection id.
/// `Deserialize` too, so `peek_vault_stamp` can read it straight out of the file
/// and let serde discard everything else (see that command for why that matters).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStamp {
    #[serde(default)]
    pub organization_id: Option<String>,
    #[serde(default)]
    pub server_vault_id: Option<String>,
}

/// The two IDENTITY fields of a folder's `.context/config.json`, read without
/// opening the folder as the active vault (contrast `get_vault_config`, which is
/// epoch-pinned to the open one). This is the discovery probe behind
/// `store.setActiveOrganization`'s rediscovery pass and the launch path's three
/// "which vault does this folder belong to?" checks: it identifies a folder as an
/// existing local copy of a vault so a switch reopens it instead of
/// auto-creating a duplicate under the vaults root.
///
/// Parsed HERE, and streamed rather than slurped, because the rest of that file
/// is the vault's doc-id map: ~1.85 MB on a 6k-note vault, which the launch path
/// used to ship over IPC and JSON-parse in the webview three times over purely to
/// learn one string. `serde` skips the unknown members without allocating them,
/// so this stays a ~60-byte answer no matter how big the map gets.
///
/// Best-effort by design — a missing folder, a non-vault folder, an unreadable or
/// malformed config all answer None, so one bad candidate can't abort a scan.
/// `#[tauri::command(async)]` on a sync fn: it does blocking file I/O, so it runs
/// on Tauri's thread pool instead of the main thread (and unit tests can still
/// call it directly).
#[tauri::command(async)]
pub fn peek_vault_stamp(path: String) -> AppResult<Option<VaultStamp>> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(None);
    }
    let Ok(file) = std::fs::File::open(p.join(".context").join("config.json")) else {
        return Ok(None);
    };
    let reader = std::io::BufReader::new(file);
    Ok(serde_json::from_reader::<_, VaultStamp>(reader).ok())
}

/// Immediate subdirectories of the managed vaults root (absolute paths), for the
/// rediscovery candidate list — auto-created folders may have aged out of the
/// recents list. Skips dotfiles and symlinks (which also excludes `current`).
#[tauri::command]
pub async fn list_vaults_root_dirs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let Some(root) = read_config(&app, &state).vaults_root else {
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
    read_context_file(&vault, "config.json")
}

/// Read one file out of `.context/`. Absent is `None`, never an error — a vault
/// that has never synced (or never typed a property) has no such file, and that
/// is an ordinary state, not a failure.
fn read_context_file(vault: &Path, name: &str) -> AppResult<Option<String>> {
    match std::fs::read_to_string(vault.join(".context").join(name)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Replace one file in `.context/`, atomically. A bare `fs::write` truncates
/// first, so a crash (or a full disk) mid-write leaves a half-written file —
/// which for `config.json` reads as "this vault knows nothing about its notes"
/// and re-registers everything. See `notefile::write_atomic_fsync`.
fn write_context_file(vault: &Path, name: &str, content: &str) -> AppResult<()> {
    notefile::write_atomic_fsync(&vault.join(".context").join(name), content.as_bytes())
}

/// Overwrite the open vault's `.context/config.json` with `content`.
#[tauri::command]
pub async fn set_vault_config(
    state: State<'_, AppState>,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    // This file is the ONLY copy of the vault's doc-id map, and it is rewritten
    // on every registry pull — see `write_context_file` for why that is atomic.
    write_context_file(&vault, "config.json", &content)
}

/// Raw contents of the open vault's `.context/types.json`, or None if absent.
/// The Properties panel's per-vault type registry (`{version, types:{key:type}}`
/// — the TS layer owns that schema too). A dedicated pair rather than a generic
/// `.context` file API: one more file does not justify a path parameter into a
/// directory CLAUDE.md calls sacred and hidden, which would be a traversal
/// surface for the sake of twenty lines.
///
/// Epoch-pinned like `get_vault_config`, and for the same reason: the result is
/// written back to the SAME file, so reading the wrong vault's registry is how
/// two vaults' types would get merged.
#[tauri::command]
pub async fn get_vault_types(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Option<String>> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    read_context_file(&vault, "types.json")
}

/// Replace `.context/types.json`. Atomic + fsync'd like the config beside it:
/// a half-written registry would read as "this vault types nothing" and every
/// property would silently fall back to inference.
#[tauri::command]
pub async fn set_vault_types(
    state: State<'_, AppState>,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    write_context_file(&vault, "types.json", &content)
}

/// Frontmatter keys used anywhere in the vault, most-used first. Feeds the
/// Properties panel's name suggestions.
#[tauri::command]
pub async fn list_property_keys(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<crate::index::PropertyKeyCount>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let keys = index.lock().unwrap().list_property_keys()?;
    Ok(keys)
}

/// Every `#tag` in the vault, most-used first. Feeds the editor's `#`
/// completion. Capped at 500: a picker is a shortlist, and a vault with more
/// distinct tags than that is not one where scrolling to number 501 is the
/// answer.
#[tauri::command]
pub async fn list_tags(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<crate::index::TagCount>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let tags = index.lock().unwrap().list_tags(500)?;
    Ok(tags)
}

/// One note's stored editor UI state (the folded sections), as opaque JSON the
/// TS layer owns. `None` for a note that has never been folded.
#[tauri::command]
pub async fn get_note_ui_state(
    state: State<'_, AppState>,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<Option<String>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let value = index.lock().unwrap().get_note_ui_state(&doc_id)?;
    Ok(value)
}

/// Replace one note's editor UI state.
#[tauri::command]
pub async fn set_note_ui_state(
    state: State<'_, AppState>,
    doc_id: String,
    ui_state: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    index.lock().unwrap().set_note_ui_state(&doc_id, &ui_state)?;
    Ok(())
}

/// Distinct values seen for one frontmatter key (array members flattened).
#[tauri::command]
pub async fn list_property_values(
    state: State<'_, AppState>,
    key: String,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<String>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let values = index.lock().unwrap().list_property_values(&key, 200)?;
    Ok(values)
}

/// Persist the sync server base URL (app config, next to last_vault).
#[tauri::command]
pub async fn set_server_url(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
) -> AppResult<()> {
    let mut cfg = read_config(&app, &state);
    // Normalize empty string to None so the TS default kicks back in.
    cfg.server_url = url.filter(|s| !s.trim().is_empty());
    write_config(&app, &state, &cfg)
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

/// Does a note file exist on disk right now?
///
/// A DISK question, unlike `get_note_meta`, which answers from the index. The
/// sync layer re-asks it before propagating a disk-observed delete to the server:
/// the watcher's report is up to 2.5 s old by then, and in that window an editor's
/// unlink-and-rewrite save, a `git checkout`, or a re-created file all put the
/// note back. `read_note` failing is the blunt instrument this replaces — it
/// cannot tell "gone" from "unreadable", and it reads the whole file to find out.
#[tauri::command]
pub async fn note_exists(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<bool> {
    // Epoch-pinned like every other vault-relative call behind a debounce: this
    // one runs 2.5 s after the event that armed it, which is easily long enough
    // for a vault switch.
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    let abs = vault::resolve_in_vault(&vault, &path)?;
    Ok(abs.is_file())
}

/// Save a recovery copy of local text that could not be synced
/// (see `notefile::write_trash_copy`). The file itself is already gone.
#[tauri::command]
pub async fn write_trash_copy(
    state: State<'_, AppState>,
    path: String,
    stamp: String,
    content: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::write_trash_copy(&vault, &path, &stamp, &content)
}

/// Copy a local binary into `.context/trash/<stamp>/…` before the blob mirror
/// replaces it with the server's version (see `notefile::copy_to_trash`).
#[tauri::command]
pub async fn copy_to_trash(
    state: State<'_, AppState>,
    path: String,
    stamp: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::copy_to_trash(&vault, &path, &stamp)
}

/// Re-key the index row at `path` to `doc_id` after an out-of-app rename (see
/// `Index::rebind_note_id`). Returns false when there is no row there, or when
/// the id already belongs to another path.
#[tauri::command]
pub async fn rebind_note_id(
    state: State<'_, AppState>,
    path: String,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<bool> {
    // Epoch-pinned because the doc_id comes from the registry map of ONE vault;
    // writing it into another vault's index would fork that vault's note.
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let rebound = index.lock().unwrap().rebind_note_id(&path, &doc_id);
    rebound
}

#[tauri::command]
pub async fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_epoch: Option<u64>,
    doc_id: Option<String>,
) -> AppResult<()> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    notefile::write_note(&vault, &path, &content)?;
    // Re-index immediately so search/backlinks are fresh without waiting for
    // the watcher echo.
    let abs = vault::resolve_in_vault(&vault, &path)?;
    let guard = index.lock().unwrap();
    // The bridge's egest names its doc: record these bytes as the doc's disk
    // base right after they landed (#200), so a later launch can tell "the
    // file is exactly what we last wrote" from "someone edited the file".
    if let Some(doc_id) = doc_id.as_deref() {
        guard.set_disk_base(doc_id, &notefile::sha256_hex(&content))?;
    }
    guard.index_note(&vault, &abs)?;
    Ok(())
}

/// The doc's recorded disk base (sha256 of the bytes last synced between its
/// file and its CRDT), or `None` when this device never recorded one.
#[tauri::command]
pub async fn get_disk_base(
    state: State<'_, AppState>,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<Option<String>> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.get_disk_base(&doc_id)
}

/// Record a doc's disk base after the bridge read a file INTO the doc.
#[tauri::command]
pub async fn set_disk_base(
    state: State<'_, AppState>,
    doc_id: String,
    sha256: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.set_disk_base(&doc_id, &sha256)
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
) -> AppResult<bool> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    notefile::ensure_folder(&vault, &path)
}

/// Legacy helper: move a note into the vault's recovery area.
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

/// Delete a single FILE, refusing a directory (`notefile::delete_file`).
///
/// The inbound reconciler's removal for a REVOKED note, which is the one delete
/// in the app that leaves no recoverable copy. Separate from `delete_path` so
/// that path's deliberate recursion stays reachable only from the sidebar, where
/// the user picked the folder themselves.
#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    path: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let abs = vault::resolve_in_vault(&vault, &path)?;
    notefile::delete_file(&vault, &path)?;
    index.lock().unwrap().remove_note(&vault, &abs)?;
    Ok(())
}

/// A bounded local cleanup batch. Every path still goes through the file-only
/// deletion guard; this command never recursively deletes directories.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRemoval {
    path: String,
    doc_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRemovalOutcome {
    path: String,
    error: Option<String>,
}

#[cfg(test)]
fn remove_inbound_file(vault: &Path, index: &Mutex<Index>, item: &InboundRemoval) -> AppResult<()> {
    let outcomes = remove_inbound_files(vault, index, vec![InboundRemoval {
        path: item.path.clone(), doc_id: item.doc_id.clone(),
    }], || Ok(()))?;
    if let Some(error) = &outcomes[0].error {
        return Err(AppError::new(error));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn delete_files_batch(
    state: State<'_, AppState>,
    items: Vec<InboundRemoval>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<InboundRemovalOutcome>> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    remove_inbound_files(&vault, &index, items, || {
        require_vault_at(&state, expected_epoch).map(|_| ())
    })
}

fn remove_inbound_files(
    vault: &Path,
    index: &Mutex<Index>,
    items: Vec<InboundRemoval>,
    check_epoch: impl Fn() -> AppResult<()>,
) -> AppResult<Vec<InboundRemovalOutcome>> {
    if items.len() > 64 {
        return Err(AppError::new("inbound removal batch exceeds 64 files"));
    }
    let mut outcomes = Vec::with_capacity(items.len());
    let mut removed = Vec::new();
    for item in items {
        // Re-check between files so a vault switch cancels the remaining work.
        check_epoch()?;
        let result = vault::resolve_in_vault(&vault, &item.path).and_then(|abs| {
            notefile::delete_file(&vault, &item.path)?;
            removed.push((abs, item.doc_id));
            Ok(())
        });
        outcomes.push(InboundRemovalOutcome {
            path: item.path,
            error: result.err().map(|e| e.to_string()),
        });
    }
    // One index transaction and one backlink resolution pass per batch,
    // rather than rescanning the link index after every removed file.
    let guard = index.lock().unwrap();
    let paths: Vec<PathBuf> = removed.iter().map(|(path, _)| path.clone()).collect();
    let failures = guard.remove_notes(&vault, &paths)?;
    for (abs, doc_id) in removed {
        let result = if let Some((_, error)) = failures.iter().find(|(path, _)| *path == abs) {
            Err(error.to_string())
        } else if let Some(doc_id) = doc_id {
            guard.clear_yjs_doc(&doc_id).map_err(|error| error.to_string())
        } else {
            Ok(())
        };
        if let Err(error) = result {
            if let Some(outcome) = outcomes.iter_mut().find(|outcome| vault.join(&outcome.path) == abs) {
                outcome.error = Some(error);
            }
        }
    }
    Ok(outcomes)
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

/// Search the vault: notes AND the tree binaries whose text was extracted, as
/// one ranked list. The command keeps its name (it is the front-end's
/// `ipc.searchNotes`) but the answer has covered both tiers since PR3 — see
/// `Index::search_all` for the merge rule.
#[tauri::command]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: String,
) -> AppResult<Vec<SearchResult>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.search_all(&query)
}

/// The extracted plain text of one tree binary, by vault-relative path.
///
/// `None` when the path has no `files` row (a note, an attachment, something the
/// walk ignores, or a file the index has not reached yet). The text is a DERIVED
/// cache — never the file, never authoritative — which is exactly what makes it
/// safe for the sync layer to upload as `blob_text` instead of re-extracting the
/// bytes in Node.
#[tauri::command]
pub async fn get_file_text(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<FileText>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.file_text(&path)
}

/// Every tier-2 `files` row: id, path, ext, kind, size, text status.
///
/// The sync layer's half of the ACL fix — a tree binary is registered on the
/// server under THIS id, so the two sides name one identity and the blob's
/// `doc_id` resolves through `shares` like a note's. One call rather than a
/// `get_file_text` per path: the binary walk asks about every file it found.
#[tauri::command]
pub async fn list_file_rows(state: State<'_, AppState>) -> AppResult<Vec<FileRow>> {
    let (_, index) = require_vault(&state)?;
    let guard = index.lock().unwrap();
    guard.file_rows()
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
// The TS bridge owns all Yjs semantics; these commands are a thin durable store.
//
// Reads answer with RAW BYTES (`tauri::ipc::Response`), framed by the encoders
// below and decoded by `src/lib/ipcCodec.ts`. They used to answer with
// serde-serialized `Vec<u8>`, i.e. JSON number arrays: the largest doc on the
// vault this was measured against holds 17.7 MB of CRDT, which is ≈62 MB of
// JSON text for the webview to parse before a character of the note is on
// screen, and ~40 docs there are over 1 MB. The frame formats are pinned by
// `encode_yjs_state_round_trips` / `encode_state_vectors_round_trips` here and
// by `src/lib/__tests__/ipcCodec.test.ts` against the same byte fixtures.

/// Split the `[u32 meta_len][meta JSON][payload]` frame the binary-inbound
/// commands take (see `ipcCodec.ts` `frame`).
///
/// The command args ride INSIDE the frame because a raw `invoke` payload is the
/// whole body: Tauri sends `application/octet-stream` only when the entire
/// payload is bytes, and with a raw body every ordinary deserialize-arg fails
/// by design. Not `options.headers` either — the postMessage fallback transport
/// re-encodes the payload as JSON and treats headers differently, so a
/// header-based design would work until the day the custom protocol is blocked.
///
/// A `Raw` body borrows, so the normal path copies nothing. The `Json` arm is
/// not dead code: that same fallback transport JSON-encodes the payload into a
/// number array, and accepting both is what keeps it from turning into "saving
/// silently stopped working".
fn raw_frame<'a, M: serde::de::DeserializeOwned>(
    body: &'a tauri::ipc::InvokeBody,
) -> AppResult<(M, std::borrow::Cow<'a, [u8]>)> {
    use std::borrow::Cow;
    use tauri::ipc::InvokeBody;
    let bytes: Cow<'a, [u8]> = match body {
        InvokeBody::Raw(b) => Cow::Borrowed(b.as_slice()),
        InvokeBody::Json(v) => Cow::Owned(
            serde_json::from_value::<Vec<u8>>(v.clone())
                .map_err(|e| AppError::new(format!("binary ipc: bad json payload: {e}")))?,
        ),
    };
    if bytes.len() < 4 {
        return Err(AppError::new("binary ipc: truncated frame"));
    }
    let meta_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let head = 4usize
        .checked_add(meta_len)
        .filter(|h| *h <= bytes.len())
        .ok_or_else(|| AppError::new("binary ipc: meta length past end of frame"))?;
    let meta: M = serde_json::from_slice(&bytes[4..head])?;
    Ok(match bytes {
        Cow::Borrowed(b) => (meta, Cow::Borrowed(&b[head..])),
        Cow::Owned(b) => (meta, Cow::Owned(b[head..].to_vec())),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendUpdateMeta {
    doc_id: String,
    expected_epoch: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSnapshotMeta {
    doc_id: String,
    expected_epoch: Option<u64>,
    /// Where the snapshot ends and the state vector begins in the payload.
    snapshot_len: usize,
    /// The COMPACTION WATERMARK: the last `yjs_updates.id` this snapshot folds
    /// in. Absent ⇒ delete nothing (see `Index::save_yjs_snapshot`).
    #[serde(default)]
    up_to: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveVectorsMeta {
    expected_epoch: Option<u64>,
    /// `(doc_id, state_vector byte length)`, in payload order.
    entries: Vec<(String, usize)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBinaryMeta {
    rel_path: String,
    expected_epoch: Option<u64>,
}

/// Frame a doc's CRDT state as raw bytes — see `ipcCodec.ts` `decodeYjsState`:
///
/// ```text
/// [u8  has_snapshot]  1 when a snapshot row exists
/// [u32 snapshot_len]  0 when has_snapshot == 0
/// [snapshot bytes]
/// [u32 update_count]
/// update_count × ([u32 len][bytes])
/// [u8  has_last_id]   1 when the log was non-empty        ─┐ trailer
/// [i64 last_update_id] 0 when has_last_id == 0            ─┘ (9 bytes)
/// ```
///
/// Little-endian throughout. An explicit flag byte rather than a length
/// sentinel, because a zero-length snapshot and a missing snapshot are
/// genuinely different states here: `save_yjs_state_vectors` creates rows with a
/// NULL snapshot, and `Index::load_yjs_state` goes out of its way to keep the
/// two apart.
///
/// **Why the watermark is a TRAILER and not a header.** It is the
/// `yjs_updates.id` of the last update in this frame, which a bridge needs so a
/// load-time compaction can truncate exactly the rows it just read (see
/// `YjsState::last_update_id`). Appending it leaves every existing byte at the
/// offset it was at, so `ipcCodec.ts decodeYjsState` — which stops after
/// `update_count` updates and never looks further — keeps working untouched,
/// and `ipc.ts loadYjsState` reads the 9 bytes at the end. A header would have
/// cost a `buf.slice()` copy of the whole frame (17.7 MB on the largest doc
/// measured) purely to re-align the payload, which is the cost this format
/// exists to avoid.
fn encode_yjs_state(state: &YjsState) -> Vec<u8> {
    let snapshot_len = state.snapshot.as_ref().map_or(0, |s| s.len());
    let mut out = Vec::with_capacity(
        1 + 4
            + snapshot_len
            + 4
            + state.updates.iter().map(|u| 4 + u.len()).sum::<usize>()
            + YJS_STATE_TRAILER_BYTES,
    );
    out.push(u8::from(state.snapshot.is_some()));
    out.extend_from_slice(&(snapshot_len as u32).to_le_bytes());
    if let Some(s) = &state.snapshot {
        out.extend_from_slice(s);
    }
    out.extend_from_slice(&(state.updates.len() as u32).to_le_bytes());
    for u in &state.updates {
        out.extend_from_slice(&(u.len() as u32).to_le_bytes());
        out.extend_from_slice(u);
    }
    out.push(u8::from(state.last_update_id.is_some()));
    out.extend_from_slice(&state.last_update_id.unwrap_or(0).to_le_bytes());
    out
}

/// The byte width of `encode_yjs_state`'s trailer. `ipc.ts loadYjsState` reads
/// the same nine bytes off the end of the buffer.
const YJS_STATE_TRAILER_BYTES: usize = 9;

/// Frame the state-vector manifest — see `ipcCodec.ts` `decodeStateVectors`:
///
/// ```text
/// [u32 count]
/// count × ([u32 id_len][id utf8][u32 sv_len][sv bytes])
/// ```
///
/// `u32` for the id length too, not `u16`: doc ids are UUIDs today, but the
/// framing must not carry that assumption, and four bytes per row is nothing
/// against the 6,283 rows one launch reads.
fn encode_state_vectors(rows: &[YjsStateVector]) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        4 + rows
            .iter()
            .map(|r| 8 + r.doc_id.len() + r.state_vector.len())
            .sum::<usize>(),
    );
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for r in rows {
        let id = r.doc_id.as_bytes();
        out.extend_from_slice(&(id.len() as u32).to_le_bytes());
        out.extend_from_slice(id);
        out.extend_from_slice(&(r.state_vector.len() as u32).to_le_bytes());
        out.extend_from_slice(&r.state_vector);
    }
    out
}

/// Append one Yjs update to a doc's log. Takes a raw frame — see `raw_frame`.
///
/// Answers with the row's `yjs_updates.id`: the caller tracks the highest one it
/// has seen and hands it back as `save_yjs_snapshot`'s `upTo`, so a snapshot can
/// only ever truncate the log it actually covers (desktop-audit #4).
///
/// `#[tauri::command(async)]` on a SYNC fn (Tauri's own `sync_threadpool`
/// mode): the body runs to completion before the future is built, so the
/// `Request` borrow never crosses an await, and it still runs off the main
/// thread.
#[tauri::command(async)]
pub fn append_yjs_update(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<i64> {
    let (meta, update) = raw_frame::<AppendUpdateMeta>(request.body())?;
    // The CRDT log lives in the vault's own `.context/index.sqlite`, so an
    // epoch-less append that crossed a switch would file vault A's doc history
    // under vault B.
    let (_, index) = require_vault_at(&state, meta.expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.append_yjs_update(&meta.doc_id, &update)
}

#[tauri::command]
pub async fn load_yjs_state(
    state: State<'_, AppState>,
    doc_id: String,
    expected_epoch: Option<u64>,
) -> AppResult<tauri::ipc::Response> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let started = std::time::Instant::now();
    let loaded = {
        let guard = index.lock().unwrap();
        guard.load_yjs_state(&doc_id)?
    };
    let updates = loaded.updates.len();
    let bytes = encode_yjs_state(&loaded);
    if bytes.len() >= LARGE_DOC_LOG_BYTES {
        log::info!(
            "[yjs] load {doc_id}: {} B in {updates} updates, framed in {} ms",
            bytes.len(),
            started.elapsed().as_millis()
        );
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write a doc's merged snapshot + state vector. Raw frame: the payload is the
/// snapshot followed by the state vector, split at `snapshotLen`.
///
/// `upTo` is the watermark the log is truncated to; omitting it writes the
/// snapshot and deletes NOTHING.
#[tauri::command(async)]
pub fn save_yjs_snapshot(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let (meta, body) = raw_frame::<SaveSnapshotMeta>(request.body())?;
    if meta.snapshot_len > body.len() {
        return Err(AppError::new(
            "binary ipc: snapshot length past end of frame",
        ));
    }
    let (snapshot, state_vector) = body.split_at(meta.snapshot_len);
    let (_, index) = require_vault_at(&state, meta.expected_epoch)?;
    let guard = index.lock().unwrap();
    guard.save_yjs_snapshot(&meta.doc_id, snapshot, state_vector, meta.up_to)
}

/// Persist a batch of per-doc Yjs state vectors (the durable sync manifest).
///
/// Batched on purpose: the vault-wide background feed touches many docs, and one
/// IPC round trip + one SQLite transaction for the batch is what keeps that off
/// the hot path. Epoch-pinned like every other CRDT write — the manifest lives in
/// the vault's own `.context/index.sqlite`.
#[tauri::command(async)]
pub fn save_yjs_state_vectors(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let (meta, body) = raw_frame::<SaveVectorsMeta>(request.body())?;
    // The vectors are concatenated in `entries` order; the meta carries only
    // their lengths, so a short body is a malformed frame, never a silent
    // truncation of somebody's manifest.
    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(meta.entries.len());
    let mut off = 0usize;
    for (doc_id, len) in meta.entries {
        let end = off
            .checked_add(len)
            .filter(|e| *e <= body.len())
            .ok_or_else(|| AppError::new("binary ipc: state vector past end of frame"))?;
        entries.push((doc_id, body[off..end].to_vec()));
        off = end;
    }
    let (_, index) = require_vault_at(&state, meta.expected_epoch)?;
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
) -> AppResult<tauri::ipc::Response> {
    let (_, index) = require_vault_at(&state, expected_epoch)?;
    let rows = {
        let guard = index.lock().unwrap();
        guard.list_yjs_state_vectors()?
    };
    Ok(tauri::ipc::Response::new(encode_state_vectors(&rows)))
}

// ---- Bulk sync: bootstrap pages + batched materialize ---------------------
//
// Two batch commands that replace the per-note IPC storm of a cold join. Both
// are epoch-pinned, both are idempotent, and neither can write over content.

/// The vault-root store `attachments.rs` owns. Content-addressed bytes, hidden
/// from the sidebar, never a note and never in the CRDT pipeline.
const ATTACHMENTS_PREFIX: &str = "attachments/";
const MAX_SEGMENT_BYTES: usize = 255;
const MAX_PATH_BYTES: usize = 1024;

/// The Rust twin of `src/lib/sync/inbound.ts`'s path allowlist. `Some(reason)`
/// when the path is refused.
///
/// Why an allowlist and not just `resolve_in_vault`: that one blocks `..` and
/// absolute paths but deliberately PERMITS `.context/`, because that is how the
/// vault's own config is read. A server row saying `rel_path =
/// ".context/config.json"` — and `rel_path` is whatever string MCP's
/// `create_note` was handed — would otherwise be "write the server's bytes over
/// this vault's doc-id map". Dot-prefixed segments are refused wholesale for the
/// same reason `vault.rs is_ignored_name` skips them: a file the walk and the
/// watcher ignore is a file this app can never see again.
fn refuse_bulk_note_path(rel: &str) -> Option<String> {
    if rel.is_empty() || rel.len() > MAX_PATH_BYTES {
        return Some("path is empty or too long".into());
    }
    if rel.starts_with('/') || rel.contains('\\') {
        return Some("absolute or backslash paths are not allowed".into());
    }
    if rel.chars().any(|c| c.is_control()) {
        return Some("path contains control characters".into());
    }
    if rel.to_ascii_lowercase().starts_with(ATTACHMENTS_PREFIX) {
        return Some("attachments/ is not a note path".into());
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Some("path has an empty or traversal segment".into());
        }
        if seg.len() > MAX_SEGMENT_BYTES {
            return Some("path segment is too long".into());
        }
        // Covers `.context`, `.git` and every hidden directory the walker skips.
        if vault::is_ignored_name(seg) {
            return Some(format!("'{seg}' is an ignored or denied directory"));
        }
    }
    let ext = rel.rsplit_once('.').map(|(stem, e)| {
        (
            !stem.is_empty() && !stem.ends_with('/'),
            e.to_ascii_lowercase(),
        )
    });
    match ext {
        // `vault::NOTE_EXTS` itself, not a copy: that list, `src/lib/formats.ts`,
        // `sync/registry.ts` and `sync/inbound.ts` are ONE contract, pinned by
        // `formatsLockstep.test.ts`, and a fourth literal here could drift.
        Some((true, e)) if vault::NOTE_EXTS.contains(&e.as_str()) => None,
        _ => Some("not a note extension".into()),
    }
}

/// One doc of a bootstrap page, decoded from the frame.
#[derive(Debug, Clone)]
pub struct BootstrapEntry {
    pub doc_id: String,
    pub rel_path: String,
    /// The markdown the server's Y.Doc serializes to.
    pub content: String,
    /// That doc's merged Yjs update (its snapshot), verbatim.
    pub snapshot: Vec<u8>,
    pub state_vector: Vec<u8>,
}

/// What the batch did with one doc. `written`/`unchanged` mean the CRDT rows are
/// stored and the TS side may `markPushed`; `conflict` and `rejected` mean the
/// doc still needs the slow path (a `DocSync`, or a cold apply through
/// `VaultDocStore`, which MERGES).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapOutcome {
    pub doc_id: String,
    /// `written` | `unchanged` | `conflict` | `rejected`.
    pub status: String,
    pub reason: Option<String>,
}

impl BootstrapOutcome {
    fn new(doc_id: &str, status: &str, reason: Option<String>) -> Self {
        Self {
            doc_id: doc_id.to_string(),
            status: status.to_string(),
            reason,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapEntryMeta {
    doc_id: String,
    rel_path: String,
    content_len: usize,
    snapshot_len: usize,
    state_vector_len: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapBatchMeta {
    expected_epoch: Option<u64>,
    entries: Vec<BootstrapEntryMeta>,
}

/// Apply one bootstrap page: N docs' markdown + CRDT, in one IPC and one
/// SQLite transaction.
///
/// ## The eligibility rule (this is `startup.ts decideSeed`, for the bulk case)
///
/// | local CRDT rows | local file | outcome |
/// |---|---|---|
/// | none | missing or 0 bytes | `written` — file + snapshot + state vector |
/// | none | non-empty, sha256 == content | `unchanged` — **still writes the CRDT rows** |
/// | none | non-empty, differs | `conflict` — writes NOTHING |
/// | any | any | `rejected` — the TS side cold-applies, which merges |
///
/// `unchanged` is what makes a crash mid-page idempotent: the files are written
/// before the transaction commits, so a killed process can leave files with no
/// CRDT rows, and a re-apply must still be allowed to write them — otherwise
/// those docs are stranded and the vault channel re-backfills them forever.
/// Re-applying a page that DID commit is a no-op: every entry then has CRDT rows
/// and comes back `rejected`, having written nothing.
///
/// ## What it is not
///
/// Not all-or-nothing across files, and it does not need to be: each file is
/// atomic on its own (`write_note`'s temp + rename), every outcome is
/// idempotent, and the caller's page cursor only advances after this returns.
///
/// ## Watcher interaction — deliberately no suppression set
///
/// The rows are written INSIDE this call's transaction, so when the
/// 150 ms-debounced watcher drains these paths, `index_one`'s hash gate
/// (`index.rs`, "The hash gate") finds `notes.sha256` already equal to the bytes
/// on disk, returns `IndexedNote::Unchanged`, and `watcher.rs mark_unchanged`
/// flags each `files-changed` entry `unchanged: true` — which the TS side
/// already drops. A Rust-side suppression set would be a second, weaker copy of
/// a guarantee the hash gate already gives.
pub fn apply_bootstrap_entries(
    vault: &Path,
    index: &Index,
    entries: &[BootstrapEntry],
) -> AppResult<Vec<BootstrapOutcome>> {
    let mut outcomes: Vec<BootstrapOutcome> = Vec::with_capacity(entries.len());
    let mut rows: Vec<BootstrapRow> = Vec::with_capacity(entries.len());
    // Where each queued row's outcome sits, so a transaction-level refusal can
    // correct it in place rather than guessing later.
    let mut row_slots: Vec<usize> = Vec::with_capacity(entries.len());

    for entry in entries {
        if let Some(reason) = refuse_bulk_note_path(&entry.rel_path) {
            outcomes.push(BootstrapOutcome::new(
                &entry.doc_id,
                "rejected",
                Some(reason),
            ));
            continue;
        }
        // Any local CRDT at all and the fast path is off: this device holds ops
        // the page does not contain, and a snapshot write would drop them.
        match index.has_local_crdt(&entry.doc_id) {
            Ok(true) => {
                outcomes.push(BootstrapOutcome::new(
                    &entry.doc_id,
                    "rejected",
                    Some("the doc already has local CRDT state".into()),
                ));
                continue;
            }
            Ok(false) => {}
            Err(e) => {
                outcomes.push(BootstrapOutcome::new(&entry.doc_id, "rejected", Some(e.0)));
                continue;
            }
        }
        match notefile::write_note_if_absent_or_empty(vault, &entry.rel_path, &entry.content) {
            Ok(WriteOutcome::Conflict) => {
                outcomes.push(BootstrapOutcome::new(
                    &entry.doc_id,
                    "conflict",
                    Some("the file on disk has different content".into()),
                ));
            }
            Ok(outcome) => {
                row_slots.push(outcomes.len());
                outcomes.push(BootstrapOutcome::new(
                    &entry.doc_id,
                    if outcome == WriteOutcome::Written {
                        "written"
                    } else {
                        "unchanged"
                    },
                    None,
                ));
                rows.push(BootstrapRow {
                    doc_id: entry.doc_id.clone(),
                    rel_path: entry.rel_path.clone(),
                    snapshot: entry.snapshot.clone(),
                    state_vector: entry.state_vector.clone(),
                    content_sha: notefile::sha256_hex(&entry.content),
                });
            }
            Err(e) => {
                outcomes.push(BootstrapOutcome::new(&entry.doc_id, "rejected", Some(e.0)));
            }
        }
    }

    // ONE transaction for the whole page: index + rebind + snapshot upserts.
    let failures = index.commit_bootstrap_rows(vault, &rows)?;
    for (doc_id, err) in failures {
        if let Some(slot) = row_slots
            .iter()
            .find(|i| outcomes[**i].doc_id == doc_id)
            .copied()
        {
            outcomes[slot].status = "rejected".to_string();
            outcomes[slot].reason = Some(err.0);
        }
    }
    Ok(outcomes)
}

/// Apply one bootstrap page. Raw frame: the payload is every entry's
/// `content || snapshot || stateVector`, concatenated in `entries` order —
/// the shape `save_yjs_state_vectors` already uses.
///
/// `#[tauri::command(async)]` on a SYNC fn, like the other framed commands: the
/// body runs to completion before the future is built, so the `Request` borrow
/// never crosses an await, and it still runs off the main thread.
///
/// The index mutex is held across the file writes as well as the transaction.
/// That is deliberate: it keeps the watcher's own index pass from landing
/// between a write and the row that makes it `unchanged`, and a page is bounded
/// (256 docs server-side).
#[tauri::command(async)]
pub fn apply_bootstrap_batch(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<Vec<BootstrapOutcome>> {
    let (meta, body) = raw_frame::<BootstrapBatchMeta>(request.body())?;
    // Epoch FIRST: these are one vault's doc ids and one vault's paths, and a
    // page applied across a vault switch would write vault A's notes into B.
    let (vault, index) = require_vault_at(&state, meta.expected_epoch)?;

    let mut entries: Vec<BootstrapEntry> = Vec::with_capacity(meta.entries.len());
    let mut off = 0usize;
    // The meta carries only lengths, so a short body is a malformed frame,
    // never a silently truncated note.
    let mut take = |len: usize| -> AppResult<&[u8]> {
        let end = off
            .checked_add(len)
            .filter(|e| *e <= body.len())
            .ok_or_else(|| AppError::new("binary ipc: bootstrap entry past end of frame"))?;
        let slice = &body[off..end];
        off = end;
        Ok(slice)
    };
    for e in &meta.entries {
        let content = std::str::from_utf8(take(e.content_len)?)
            .map_err(|_| AppError::new("binary ipc: note content is not valid utf-8"))?
            .to_string();
        let snapshot = take(e.snapshot_len)?.to_vec();
        let state_vector = take(e.state_vector_len)?.to_vec();
        entries.push(BootstrapEntry {
            doc_id: e.doc_id.clone(),
            rel_path: e.rel_path.clone(),
            content,
            snapshot,
            state_vector,
        });
    }

    let guard = index.lock().unwrap();
    apply_bootstrap_entries(&vault, &guard, &entries)
}

/// One server-only note to materialize as a local placeholder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeItem {
    pub rel_path: String,
    /// The server's doc id for this path. `None` leaves the index row on
    /// whatever id it already has.
    pub doc_id: Option<String>,
}

/// What the batch did with one path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeOutcome {
    pub rel_path: String,
    /// The file did not exist and was created EMPTY. False means it was already
    /// there and was left byte-for-byte alone.
    pub created: bool,
    /// The index row at this path now carries the server's `doc_id`.
    pub rebound: bool,
}

/// Materialize N server-only notes as create-only placeholders, then index and
/// re-key them in ONE transaction with ONE link pass.
///
/// This is the registry's join loop, batched: it used to be 2-3 IPC round trips
/// per note, each with its own transaction, and each `rebind_note_id` carried a
/// `LinkScope::All` pass — a whole-`links` scan per note, which was the single
/// largest cost of joining a vault.
///
/// Every write is `write_note_if_missing`: create-only, never an overwrite. That
/// guard is why the 428-note incident (a lazily-loaded tree mistaken for the
/// whole vault) cost nothing, and the batching must not weaken it.
pub fn materialize_notes(
    vault: &Path,
    index: &Index,
    items: &[MaterializeItem],
) -> AppResult<Vec<MaterializeOutcome>> {
    let mut outcomes: Vec<MaterializeOutcome> = Vec::with_capacity(items.len());
    // (rel_path, doc_id) for the rows that exist on disk, plus where each one's
    // outcome sits.
    let mut rows: Vec<(String, Option<String>)> = Vec::with_capacity(items.len());
    let mut row_slots: Vec<usize> = Vec::with_capacity(items.len());

    for item in items {
        if let Some(reason) = refuse_bulk_note_path(&item.rel_path) {
            log::warn!(
                "[materialize] refusing {}: {reason}",
                item.rel_path
            );
            outcomes.push(MaterializeOutcome {
                rel_path: item.rel_path.clone(),
                created: false,
                rebound: false,
            });
            continue;
        }
        let created = match notefile::write_note_if_missing(vault, &item.rel_path, "") {
            Ok(made) => made,
            Err(e) => {
                // Per-path and non-fatal: one unwritable placeholder must not
                // cost the rest of the join.
                log::warn!("[materialize] {}: {}", item.rel_path, e.0);
                outcomes.push(MaterializeOutcome {
                    rel_path: item.rel_path.clone(),
                    created: false,
                    rebound: false,
                });
                continue;
            }
        };
        row_slots.push(outcomes.len());
        outcomes.push(MaterializeOutcome {
            rel_path: item.rel_path.clone(),
            created,
            rebound: false,
        });
        rows.push((item.rel_path.clone(), item.doc_id.clone()));
    }

    let rebound = index.commit_materialized(vault, &rows)?;
    for (slot, ok) in row_slots.into_iter().zip(rebound) {
        outcomes[slot].rebound = ok;
    }
    Ok(outcomes)
}

/// Materialize a batch of server-only notes. Plain JSON — no bytes cross here,
/// these placeholders are empty by construction.
#[tauri::command]
pub async fn materialize_notes_batch(
    state: State<'_, AppState>,
    items: Vec<MaterializeItem>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<MaterializeOutcome>> {
    // Epoch-pinned like `rebind_note_id`: the doc ids come from ONE vault's
    // registry map, and writing them into another vault's index forks its notes.
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    materialize_notes(&vault, &guard, &items)
}

// ---- Attachment I/O (Phase 3 blob store, spec 02 §2) ----------------------
//
// Reads answer with raw bytes (`tauri::ipc::Response`) like the CRDT reads
// above — no framing needed, the whole body is the file. Every path is
// validated to stay inside the vault. These never touch the note/CRDT pipeline.

#[tauri::command]
pub async fn read_binary_file(
    state: State<'_, AppState>,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<tauri::ipc::Response> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    let bytes = attachments::read_binary_file(&vault, &rel_path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Size + mtime of one vault file, without reading it. The file card prints a
/// size for every non-note format, and a 25 MB video is not worth a round trip
/// through the IPC bridge to learn how big it is.
#[tauri::command]
pub async fn file_stat(
    state: State<'_, AppState>,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<FileStat> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::file_stat(&vault, &rel_path)
}

/// Disk-truth for the binary delete queue — see `attachments::binary_exists`.
#[tauri::command]
pub async fn binary_exists(
    state: State<'_, AppState>,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<bool> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::binary_exists(&vault, &rel_path)
}

#[tauri::command(async)]
pub fn write_binary_file(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let (meta, bytes) = raw_frame::<WriteBinaryMeta>(request.body())?;
    let (vault, _) = require_vault_at(&state, meta.expected_epoch)?;
    attachments::write_binary_file(&vault, &meta.rel_path, &bytes)
}

/// Materialize a binary that lives in the TREE — a `.docx` a teammate dropped
/// into `Team/`, arriving on this device as a blob with that rel_path.
///
/// A second command rather than a looser `write_binary_file`: the
/// `attachments/` guard still bounds every write aimed at the hidden store, and
/// this one accepts exactly what the binary walk produces (see
/// `attachments.rs ensure_tree_binary_rel`). Notes are refused here as firmly
/// as `.context/` is — a blob must never be able to overwrite a CRDT note.
#[tauri::command(async)]
pub fn write_tree_binary(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let (meta, bytes) = raw_frame::<WriteBinaryMeta>(request.body())?;
    let (vault, _) = require_vault_at(&state, meta.expected_epoch)?;
    attachments::write_tree_binary(&vault, &meta.rel_path, &bytes)
}

/// The attachment listing the sync diff runs on — path, size and sha256 for
/// every file under `attachments/`.
///
/// Hashes come from the index's `attachment_hashes` cache whenever the file's
/// `(size, mtime)` is unchanged, so a reconcile triggered by an unrelated
/// watcher event costs a `stat` per file instead of re-reading every byte in
/// the store. The lock is taken twice and briefly — read the cache, walk and
/// hash outside it, write back only when something moved — because hashing a
/// large video while holding the index lock would stall every other query.
#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<AttachmentMeta>> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let cached = {
        let guard = index.lock().unwrap();
        // A cache read that fails is not a reason to fail the listing: the
        // worst case is that we hash everything, which is what we did before.
        guard.attachment_hash_cache().unwrap_or_default()
    };
    let listing = attachments::list_attachments_cached(&vault, &cached)?;
    save_hash_cache(&index, &listing);
    Ok(listing.items)
}

/// The same listing over the WHOLE vault: `attachments/` plus every tree binary
/// (a `.docx` in `Team/`, a `.mp4` in `Media/`). This is what the sync diff
/// runs on since tree binaries became `files` rows — `list_attachments` stays
/// for callers that want only the hidden store.
///
/// Same two brief lock takes as `list_attachments`, and the same cache: the
/// binary walk is a superset of the attachment walk, so writing its cache back
/// prunes nothing the other one wants.
#[tauri::command]
pub async fn list_binaries(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<AttachmentMeta>> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let cached = {
        let guard = index.lock().unwrap();
        guard.attachment_hash_cache().unwrap_or_default()
    };
    let listing = attachments::list_binaries_cached(&vault, &cached)?;
    save_hash_cache(&index, &listing);
    Ok(listing.items)
}

/// Persist a walk's hash cache, if it moved. A failure here costs a re-hash
/// next pass and nothing else, so it is logged rather than returned.
fn save_hash_cache(
    index: &std::sync::Mutex<crate::index::Index>,
    listing: &attachments::AttachmentListing,
) {
    if !listing.changed {
        return;
    }
    let guard = index.lock().unwrap();
    if let Err(e) = guard.save_attachment_hash_cache(&listing.cache) {
        log::warn!("[attachments] hash cache write failed: {e}");
    }
}

/// Stream one attachment (or one multipart part of it) to a presigned URL.
///
/// See `attachments.rs` for why the bytes go through Rust instead of the
/// webview, and why NOTHING here adds an `Authorization` header: the URL
/// carries its own credential, and S3 rejects a request that has both.
#[tauri::command]
pub async fn upload_attachment(
    state: State<'_, AppState>,
    rel_path: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    range: Option<attachments::ByteRange>,
    expected_epoch: Option<u64>,
) -> AppResult<attachments::UploadOutcome> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::upload_file(
        &vault,
        &rel_path,
        &url,
        method.as_deref().unwrap_or("PUT"),
        &headers.unwrap_or_default(),
        range,
    )
    .await
}

/// Stream a URL into `attachments/<…>`, verifying the sha256 before the rename.
///
/// Epoch-pinned like every other vault-relative write: a download that started
/// before a vault switch must not land in the vault the user moved to.
#[tauri::command]
pub async fn download_attachment(
    state: State<'_, AppState>,
    url: String,
    rel_path: String,
    headers: Option<HashMap<String, String>>,
    expected_sha256: Option<String>,
    tree: Option<bool>,
    expected_epoch: Option<u64>,
) -> AppResult<attachments::DownloadOutcome> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    attachments::download_file(
        &vault,
        &rel_path,
        &url,
        &headers.unwrap_or_default(),
        expected_sha256.as_deref(),
        // Absent means the hidden store, which is what every caller meant
        // before tree binaries existed.
        tree.unwrap_or(false),
    )
    .await
}

/// A one-shot census of the open vault for Vault Settings → Health: what is in
/// it, what the local CRDT store costs, and what is recently touched. See
/// `stats.rs` for the ignore rules and `src/lib/health/types.ts` for the shape.
///
/// Epoch-pinned like `list_note_titles`: the page reports paths and doc_ids, and
/// a census that crossed a vault switch would describe the wrong vault's disk.
/// One walk plus four aggregate queries; it reads no file contents.
#[tauri::command]
pub async fn vault_stats(
    state: State<'_, AppState>,
    live_docs: std::collections::HashMap<String, String>,
    today_start_ms: Option<i64>,
    expected_epoch: Option<u64>,
) -> AppResult<VaultStats> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    stats::collect(&vault, &guard, &live_docs, today_start_ms)
}

/// The integrity half of the Health page: fifteen checks over the same vault,
/// each with a true count and up to 25 example rows. See `checks.rs` for every
/// rule and `src/lib/health/types.ts` for the shape.
///
/// Epoch-pinned and `live_docs`-taking for the same reasons as `vault_stats`:
/// the results name paths and doc ids, and `orphan-history` uses the registry
/// map so it agrees with what the sweep would actually reclaim.
///
/// Heavier than `vault_stats` — it reads note contents — but bounded: nothing at
/// or above the server's 10 MB cap is read, and embed scanning stops at 2 MB.
#[tauri::command]
pub async fn vault_checks(
    state: State<'_, AppState>,
    live_docs: std::collections::HashMap<String, String>,
    expected_epoch: Option<u64>,
) -> AppResult<VaultChecks> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let guard = index.lock().unwrap();
    checks::collect(&vault, &guard, &live_docs)
}

/// Delete every recovery copy under `<vault>/.context/trash`.
///
/// The one destructive command that never touches a note: the files it removes
/// are copies the app made of things already deleted, and the directory itself
/// survives so the next delete has somewhere to go. The path is derived from the
/// vault root alone — no caller-supplied component — and a symlinked trash
/// directory is refused rather than followed.
#[tauri::command]
pub async fn empty_trash(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<EmptyTrashReport> {
    let (vault, _) = require_vault_at(&state, expected_epoch)?;
    checks::empty_trash(&vault)
}

/// Re-reconcile the index against the `.md` files on disk — the remedy for the
/// `stale-index` and `unindexed-markdown` checks.
///
/// `Index::rebuild` is incremental and preserves every doc_id (and never touches
/// the CRDT tables), so this is safe to run at any time; it is not a "drop and
/// recreate". Emits `index-ready`, the same event the background rebuild at vault
/// open emits, so titles, backlinks and the graph catch up exactly as they do
/// then. Synchronous on purpose: the caller is a button that shows a spinner, and
/// holding the index lock is what makes "done" mean done.
#[tauri::command]
pub async fn rebuild_index(
    app: AppHandle,
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let (vault, index) = require_vault_at(&state, expected_epoch)?;
    let (epoch, queue) = {
        let inner = state.inner.lock().unwrap();
        (
            inner.vault_epoch,
            inner.watcher.as_ref().map(|w| w.extract_queue()),
        )
    };
    let started = std::time::Instant::now();
    let result = {
        let guard = index.lock().unwrap();
        guard.rebuild(&vault)
    };
    let ok = result.is_ok();
    // Same hand-off as vault open: the rows are reconciled here, the text is
    // extracted on the worker thread.
    if let (Ok(pending), Some(queue)) = (&result, queue) {
        queue.enqueue(pending.clone());
    }
    let _ = app.emit(
        "index-ready",
        IndexReady {
            path: vault.to_string_lossy().to_string(),
            epoch,
            ok,
            ms: started.elapsed().as_millis() as u64,
        },
    );
    result.map(|_| ())
}

/// Read an arbitrary host file the user just dropped/picked (absolute path).
/// Unlike `read_binary_file` this is NOT vault-scoped — the bytes are on their
/// way into an attachment; the path came from a user drag-drop, not the tree.
#[tauri::command]
pub async fn read_external_file(path: String) -> AppResult<tauri::ipc::Response> {
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::new(format!("read external file failed: {e}")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbound_batch_file_removal_preserves_directories_and_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let index = Mutex::new(Index::open_in_memory().unwrap());
        std::fs::create_dir(tmp.path().join("Docs")).unwrap();
        std::fs::create_dir(tmp.path().join(".context")).unwrap();
        std::fs::write(tmp.path().join("Docs/n.md"), "note").unwrap();
        std::fs::write(tmp.path().join(".context/config.json"), "{}").unwrap();
        index.lock().unwrap().append_yjs_update("d1", &[1]).unwrap();
        for path in ["Docs", ".context/config.json", "../outside.md"] {
            assert!(remove_inbound_file(tmp.path(), &index, &InboundRemoval {
                path: path.into(), doc_id: Some("d1".into()),
            }).is_err());
        }
        assert!(tmp.path().join("Docs/n.md").exists());
        assert!(tmp.path().join(".context/config.json").exists());
        assert_eq!(index.lock().unwrap().load_yjs_state("d1").unwrap().update_count, 1);
        remove_inbound_file(tmp.path(), &index, &InboundRemoval {
            path: "Docs/n.md".into(), doc_id: Some("d1".into()),
        }).unwrap();
        assert!(!tmp.path().join("Docs/n.md").exists());
        assert!(tmp.path().join("Docs").exists());
        assert_eq!(index.lock().unwrap().load_yjs_state("d1").unwrap().update_count, 0);
    }


    /// The decision behind `config_path`'s fallback (#128). `config_path` itself
    /// needs an `AppHandle`, so the part that is actually testable is the probe:
    /// it must accept a directory it can create AND write in, and reject one it
    /// cannot — otherwise the fallback either never fires or always does.
    #[test]
    fn prepare_config_dir_accepts_a_writable_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // Nested, because `app_config_dir()` on a fresh install does not exist yet.
        let dir = tmp.path().join("com.baalda.context");
        prepare_config_dir(&dir).expect("a fresh writable dir must be usable");
        assert!(dir.is_dir());
        // The probe cleans up after itself — a `.write-test` left behind would
        // sit next to the user's settings forever.
        assert!(!dir.join(".write-test").exists());
    }

    #[test]
    fn prepare_config_dir_rejects_a_path_blocked_by_a_file() {
        // A FILE where the directory should be is the one unusable-path case
        // that behaves the same on every platform (making a directory
        // unwritable needs chmod, which is a no-op for root and absent on
        // Windows — so that case is deliberately not tested here).
        let tmp = tempfile::tempdir().unwrap();
        let blocked = tmp.path().join("not-a-dir");
        std::fs::write(&blocked, b"x").unwrap();
        let err = prepare_config_dir(&blocked).unwrap_err().to_string();
        // The whole point of the change: the message names the operation AND
        // the path, so support can tell it from the other two os-error-2 sites.
        assert!(err.starts_with("Couldn't create the settings folder "), "{err}");
        assert!(err.contains("not-a-dir"), "{err}");
    }

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

    /// The rediscovery/launch probe must identify a vault folder without opening
    /// it, must return only the identity fields (never the doc map beside them),
    /// and must answer None — never an error — for everything that isn't a vault
    /// folder: a scan over recents can't have one bad candidate abort the pass.
    #[test]
    fn peek_vault_stamp_reads_identity_without_opening() {
        let dir = tempfile::tempdir().unwrap();

        // A stamped config, with a doc map beside the identity fields (the real
        // shape — on a big vault that map is megabytes). Only the two fields
        // come back.
        let vault = dir.path().join("my-vault");
        std::fs::create_dir_all(vault.join(".context")).unwrap();
        std::fs::write(
            vault.join(".context").join("config.json"),
            r#"{"organizationId":"org-1","serverVaultId":"col-1","docs":{"a.md":"d1"},"pushed":["d1"]}"#,
        )
        .unwrap();
        let got = peek_vault_stamp(vault.to_string_lossy().to_string())
            .unwrap()
            .expect("stamped config");
        assert_eq!(got.organization_id.as_deref(), Some("org-1"));
        assert_eq!(got.server_vault_id.as_deref(), Some("col-1"));

        // A legacy (pre-stamp) config: the collection id alone, which is what
        // heals such a folder in place. Some(stamp) with a None org, NOT None —
        // the caller distinguishes "not a vault" from "vault, org unknown".
        let legacy = dir.path().join("legacy");
        std::fs::create_dir_all(legacy.join(".context")).unwrap();
        std::fs::write(
            legacy.join(".context").join("config.json"),
            r#"{"serverVaultId":"col-9"}"#,
        )
        .unwrap();
        let got = peek_vault_stamp(legacy.to_string_lossy().to_string())
            .unwrap()
            .expect("legacy config");
        assert_eq!(got.organization_id, None);
        assert_eq!(got.server_vault_id.as_deref(), Some("col-9"));

        // Malformed JSON: None, not an error.
        let broken = dir.path().join("broken");
        std::fs::create_dir_all(broken.join(".context")).unwrap();
        std::fs::write(broken.join(".context").join("config.json"), "{not json").unwrap();
        assert!(peek_vault_stamp(broken.to_string_lossy().to_string())
            .unwrap()
            .is_none());

        // A plain folder (no .context): None.
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(peek_vault_stamp(plain.to_string_lossy().to_string())
            .unwrap()
            .is_none());

        // A path that doesn't exist / isn't a directory: None, not an error.
        let missing = dir.path().join("gone");
        assert!(peek_vault_stamp(missing.to_string_lossy().to_string())
            .unwrap()
            .is_none());
        let file = dir.path().join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(peek_vault_stamp(file.to_string_lossy().to_string())
            .unwrap()
            .is_none());
    }

    /// The `ipcCodec.ts` `frame` encoder, in Rust, for the inbound tests.
    fn frame(meta: serde_json::Value, payload: &[u8]) -> Vec<u8> {
        let meta = serde_json::to_vec(&meta).unwrap();
        let mut out = Vec::with_capacity(4 + meta.len() + payload.len());
        out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        out.extend_from_slice(&meta);
        out.extend_from_slice(payload);
        out
    }

    #[derive(Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TestMeta {
        doc_id: String,
        expected_epoch: Option<u64>,
    }

    /// The normal (custom-protocol) transport: one raw body, meta prefix and
    /// payload split without copying the payload.
    #[test]
    fn raw_frame_splits_meta_and_body() {
        let buf = frame(
            serde_json::json!({ "docId": "d1", "expectedEpoch": 7 }),
            &[1, 2, 3],
        );
        let body = tauri::ipc::InvokeBody::Raw(buf);
        let (meta, payload) = raw_frame::<TestMeta>(&body).unwrap();
        assert_eq!(
            meta,
            TestMeta {
                doc_id: "d1".to_string(),
                expected_epoch: Some(7)
            }
        );
        assert_eq!(&*payload, &[1, 2, 3]);

        // An empty payload is legal (a zero-byte attachment, an empty vector).
        let body = tauri::ipc::InvokeBody::Raw(frame(
            serde_json::json!({ "docId": "d1", "expectedEpoch": null }),
            &[],
        ));
        let (meta, payload) = raw_frame::<TestMeta>(&body).unwrap();
        assert_eq!(meta.expected_epoch, None);
        assert!(payload.is_empty());
    }

    /// The postMessage fallback transport, which JSON-encodes the payload as a
    /// number array. If this arm ever goes, saving stops working on any install
    /// where the custom-protocol IPC is blocked — silently.
    #[test]
    fn raw_frame_accepts_a_json_payload() {
        let buf = frame(
            serde_json::json!({ "docId": "d2", "expectedEpoch": null }),
            &[9, 8],
        );
        let body = tauri::ipc::InvokeBody::Json(serde_json::to_value(&buf).unwrap());
        let (meta, payload) = raw_frame::<TestMeta>(&body).unwrap();
        assert_eq!(meta.doc_id, "d2");
        assert_eq!(&*payload, &[9, 8]);
    }

    /// A frame too short to hold its own length prefix must be an error, not a
    /// panic on a slice index.
    #[test]
    fn raw_frame_rejects_a_truncated_frame() {
        for bytes in [vec![], vec![0u8], vec![0u8, 0, 0]] {
            let body = tauri::ipc::InvokeBody::Raw(bytes);
            assert!(raw_frame::<TestMeta>(&body).is_err());
        }
    }

    /// A meta length that runs past the buffer (corruption, or a mismatched
    /// encoder) must be rejected rather than slicing out of bounds.
    #[test]
    fn raw_frame_rejects_a_meta_length_past_the_end() {
        let mut buf = frame(
            serde_json::json!({ "docId": "d3", "expectedEpoch": null }),
            &[1],
        );
        buf[0] = 0xff;
        buf[1] = 0xff;
        let body = tauri::ipc::InvokeBody::Raw(buf);
        let err = raw_frame::<TestMeta>(&body).unwrap_err();
        assert!(err.0.contains("binary ipc"), "{}", err.0);
    }

    /// The `ipcCodec.ts` decoder, in Rust, so a round trip pins the frame
    /// format from this side too. `src/lib/__tests__/ipcCodec.test.ts` asserts
    /// the same byte fixtures from the TS side.
    fn decode_yjs_state(buf: &[u8]) -> (Option<Vec<u8>>, Vec<Vec<u8>>, Option<i64>) {
        let mut off = 0usize;
        let has_snapshot = buf[off] == 1;
        off += 1;
        let take_u32 = |buf: &[u8], off: &mut usize| -> usize {
            let n = u32::from_le_bytes([buf[*off], buf[*off + 1], buf[*off + 2], buf[*off + 3]]);
            *off += 4;
            n as usize
        };
        let snapshot_len = take_u32(buf, &mut off);
        let snapshot = if has_snapshot {
            Some(buf[off..off + snapshot_len].to_vec())
        } else {
            None
        };
        off += snapshot_len;
        let count = take_u32(buf, &mut off);
        let mut updates = Vec::with_capacity(count);
        for _ in 0..count {
            let len = take_u32(buf, &mut off);
            updates.push(buf[off..off + len].to_vec());
            off += len;
        }
        let has_last_id = buf[off] == 1;
        off += 1;
        let raw = i64::from_le_bytes(buf[off..off + 8].try_into().unwrap());
        off += 8;
        assert_eq!(off, buf.len(), "frame must be consumed exactly");
        (snapshot, updates, has_last_id.then_some(raw))
    }

    fn yjs_state(snapshot: Option<Vec<u8>>, updates: Vec<Vec<u8>>) -> YjsState {
        let update_count = updates.len() as i64;
        let last_update_id = (update_count > 0).then_some(update_count * 10);
        YjsState {
            snapshot,
            updates,
            update_count,
            last_update_id,
        }
    }

    /// The Rust half of the path allowlist must refuse exactly what
    /// `src/lib/sync/inbound.ts` refuses, plus `attachments/`. `resolve_in_vault`
    /// is NOT a substitute: it permits `.context/`, which is how the vault's own
    /// config is read.
    #[test]
    fn bulk_path_allowlist_is_the_twin_of_inbound_ts() {
        for ok in [
            "Note.md",
            "Folder/Sub/Note.markdown",
            "a/b/c.txt",
            "Canvas.canvas",
            "page.html",
        ] {
            assert!(
                refuse_bulk_note_path(ok).is_none(),
                "{ok} should be allowed"
            );
        }
        for bad in [
            "",
            "../escape.md",
            "/abs/note.md",
            "C:\\note.md",
            ".context/config.json",
            ".context/trash/x.md",
            ".git/HEAD.md",
            "Notes/.hidden/x.md",
            ".hidden.md",
            "attachments/abcdef01.md",
            "Attachments/abcdef01.md",
            "node_modules/pkg/readme.md",
            "dist/out.md",
            "Notes//double.md",
            "Notes/report.pdf",
            "Notes/image.png",
            "noextension",
            "trailing/.md",
            "with\u{0}null.md",
        ] {
            assert!(
                refuse_bulk_note_path(bad).is_some(),
                "{bad:?} should be refused"
            );
        }
        // Long paths and segments.
        assert!(refuse_bulk_note_path(&format!("{}.md", "x".repeat(300))).is_some());
        assert!(refuse_bulk_note_path(&format!("{}/a.md", "d/".repeat(600))).is_some());
    }

    /// The bootstrap frame is the same `[u32 metaLen][meta JSON][payload]` shape
    /// `ipcCodec.ts frame()` builds, with each entry's three parts concatenated
    /// in `entries` order. Pinned here so a change on either side fails a test
    /// rather than silently splitting a note in the wrong place.
    #[test]
    fn bootstrap_frame_splits_each_entry_into_its_three_parts() {
        let meta = serde_json::json!({
            "expectedEpoch": 4,
            "entries": [
                { "docId": "d1", "relPath": "A.md", "contentLen": 5, "snapshotLen": 3, "stateVectorLen": 2 },
                { "docId": "d2", "relPath": "B.md", "contentLen": 0, "snapshotLen": 1, "stateVectorLen": 0 },
            ],
        });
        let meta_bytes = serde_json::to_vec(&meta).unwrap();
        let mut framed = Vec::new();
        framed.extend_from_slice(&(meta_bytes.len() as u32).to_le_bytes());
        framed.extend_from_slice(&meta_bytes);
        framed.extend_from_slice(b"alpha"); // d1 content
        framed.extend_from_slice(&[1, 2, 3]); // d1 snapshot
        framed.extend_from_slice(&[7, 7]); // d1 state vector
        framed.extend_from_slice(&[9]); // d2 snapshot (empty content + sv)

        let body = tauri::ipc::InvokeBody::Raw(framed);
        let (parsed, payload) = raw_frame::<BootstrapBatchMeta>(&body).unwrap();
        assert_eq!(parsed.expected_epoch, Some(4));
        assert_eq!(parsed.entries.len(), 2);

        let mut off = 0usize;
        let mut take = |n: usize| {
            let s = payload[off..off + n].to_vec();
            off += n;
            s
        };
        let e0 = &parsed.entries[0];
        assert_eq!(take(e0.content_len), b"alpha".to_vec());
        assert_eq!(take(e0.snapshot_len), vec![1, 2, 3]);
        assert_eq!(take(e0.state_vector_len), vec![7, 7]);
        let e1 = &parsed.entries[1];
        assert!(take(e1.content_len).is_empty(), "a 0-length part is legal");
        assert_eq!(take(e1.snapshot_len), vec![9]);
        assert!(take(e1.state_vector_len).is_empty());
        assert_eq!(off, payload.len(), "the payload is exactly consumed");
    }

    /// `upTo` is optional on the wire: an older caller that omits it must still
    /// deserialize, and must mean "delete nothing" rather than "delete all".
    #[test]
    fn save_snapshot_meta_defaults_its_watermark_to_none() {
        let with: SaveSnapshotMeta =
            serde_json::from_str(r#"{"docId":"d","snapshotLen":2,"upTo":41}"#).unwrap();
        assert_eq!(with.up_to, Some(41));
        let without: SaveSnapshotMeta =
            serde_json::from_str(r#"{"docId":"d","snapshotLen":2}"#).unwrap();
        assert_eq!(without.up_to, None);
    }

    /// Both bulk commands must resolve the vault (and its epoch) BEFORE they
    /// touch anything — a page applied across a vault switch would write vault
    /// A's notes into vault B. Source-level, like `formatsLockstep.test.ts`:
    /// the ordering is the invariant and there is no Tauri `State` to build in
    /// a unit test.
    #[test]
    fn the_bulk_commands_pin_the_vault_epoch_first() {
        let src = include_str!("commands.rs");
        for (cmd, pin, work) in [
            (
                "pub fn apply_bootstrap_batch",
                "require_vault_at(&state, meta.expected_epoch)?",
                "apply_bootstrap_entries(&vault, &guard, &entries)",
            ),
            (
                "pub async fn materialize_notes_batch",
                "require_vault_at(&state, expected_epoch)?",
                "materialize_notes(&vault, &guard, &items)",
            ),
        ] {
            let body = &src[src.find(cmd).unwrap_or_else(|| panic!("{cmd} is gone"))..];
            let pin_at = body.find(pin).unwrap_or_else(|| panic!("{cmd} lost its epoch pin"));
            let work_at = body.find(work).unwrap_or_else(|| panic!("{cmd} lost its body"));
            assert!(pin_at < work_at, "{cmd} must pin the epoch before it works");
        }
    }

    /// The four shapes a doc's persisted state actually takes, byte-for-byte.
    /// A missing snapshot and an empty snapshot are different states (a state
    /// vector recorded for a never-snapshotted doc leaves a NULL snapshot), so
    /// the flag byte has to survive the round trip on its own.
    #[test]
    fn encode_yjs_state_round_trips() {
        let cases = vec![
            yjs_state(None, vec![]),
            yjs_state(None, vec![vec![1, 2], vec![3], vec![4, 5, 6]]),
            yjs_state(Some(vec![9, 9, 9]), vec![]),
            // Includes a zero-length update: a length prefix of 0 must not read
            // as "end of frame".
            yjs_state(Some(vec![7]), vec![vec![], vec![255, 0, 128]]),
        ];
        for state in &cases {
            let (snapshot, updates, last_update_id) =
                decode_yjs_state(&encode_yjs_state(state));
            assert_eq!(snapshot, state.snapshot);
            assert_eq!(updates, state.updates);
            // The compaction watermark rides in the trailer, and `None` (an
            // empty log) must not decode as 0 — 0 is a legal rowid.
            assert_eq!(last_update_id, state.last_update_id);
        }

        // The empty state is the shortest legal frame: flag + len + count, then
        // the 9-byte trailer with its flag clear.
        assert_eq!(encode_yjs_state(&yjs_state(None, vec![])), vec![0; 18]);
        // An EMPTY snapshot still sets the flag byte, so it cannot be confused
        // with a doc that has none.
        assert_eq!(
            encode_yjs_state(&yjs_state(Some(vec![]), vec![]))[0],
            1,
            "an empty snapshot is not a missing snapshot"
        );
    }

    /// Doc ids are UUIDs today; the framing must not depend on that, hence the
    /// multi-byte id (its byte length and its char count differ).
    #[test]
    fn encode_state_vectors_round_trips() {
        let rows = vec![
            YjsStateVector {
                doc_id: "doc-1".to_string(),
                state_vector: vec![1, 2, 3],
            },
            YjsStateVector {
                doc_id: "notité-🔒".to_string(),
                state_vector: vec![],
            },
        ];
        let buf = encode_state_vectors(&rows);

        let mut off = 0usize;
        let take_u32 = |buf: &[u8], off: &mut usize| -> usize {
            let n = u32::from_le_bytes([buf[*off], buf[*off + 1], buf[*off + 2], buf[*off + 3]]);
            *off += 4;
            n as usize
        };
        let count = take_u32(&buf, &mut off);
        assert_eq!(count, 2);
        for expected in &rows {
            let id_len = take_u32(&buf, &mut off);
            let id = std::str::from_utf8(&buf[off..off + id_len]).unwrap();
            off += id_len;
            let sv_len = take_u32(&buf, &mut off);
            let sv = buf[off..off + sv_len].to_vec();
            off += sv_len;
            assert_eq!(id, expected.doc_id);
            assert_eq!(sv, expected.state_vector);
        }
        assert_eq!(off, buf.len(), "frame must be consumed exactly");

        // An empty manifest is a bare count of zero, not an empty body.
        assert_eq!(encode_state_vectors(&[]), vec![0, 0, 0, 0]);
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

    /// `.context/types.json` (the Properties panel's per-vault type registry)
    /// and `config.json` share one reader/writer pair. Absent must be None, not
    /// an error — a vault that has never typed a property has no such file, and
    /// the panel would otherwise show a failure on every note. The epoch pin
    /// itself is `check_epoch`'s, covered above.
    #[test]
    fn context_files_round_trip_and_report_absence() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join(".context")).unwrap();

        assert_eq!(read_context_file(vault, "types.json").unwrap(), None);

        let body = r#"{"version":1,"types":{"due":"date"}}"#;
        write_context_file(vault, "types.json", body).unwrap();
        assert_eq!(
            read_context_file(vault, "types.json").unwrap().as_deref(),
            Some(body)
        );

        // A rewrite replaces, never appends — and it must not disturb the doc-id
        // map living beside it.
        write_context_file(vault, "config.json", r#"{"serverVaultId":"col-1"}"#).unwrap();
        write_context_file(vault, "types.json", r#"{"version":1,"types":{}}"#).unwrap();
        assert_eq!(
            read_context_file(vault, "types.json").unwrap().as_deref(),
            Some(r#"{"version":1,"types":{}}"#)
        );
        assert_eq!(
            read_context_file(vault, "config.json").unwrap().as_deref(),
            Some(r#"{"serverVaultId":"col-1"}"#)
        );
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
