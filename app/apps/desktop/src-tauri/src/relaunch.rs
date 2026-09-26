//! Background relaunch after a silent update.
//!
//! An auto-update restarts the app. When Baalda was behind another app at that
//! moment, the new process must not jump in front of it — but on macOS tao
//! calls `activateIgnoringOtherApps(true)` in `applicationDidFinishLaunching`,
//! and Tauri exposes no way to turn that off. So the old process leaves a
//! marker just before it restarts, and the new one reads it in `setup` (which
//! runs AFTER that activation) and hides itself again, handing focus back to
//! the app the user was in. The main window is still hidden at that point
//! (`visible: false`), so nothing flashes; clicking the Dock icon brings it back
//! with the What's New modal already waiting.
//!
//! The marker carries a timestamp and is honoured only while fresh: a restart
//! that never happened must not make some later, manual launch hide itself.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime, State};

use crate::error::AppError;

const MARKER: &str = "background-relaunch";

/// How long a marker stays valid. Long enough for a Windows installer (the
/// marker is written before the download there, because the process exits
/// inside `install`), short enough that a failed restart is forgotten.
pub const MARKER_TTL_MS: u64 = 10 * 60 * 1000;

/// Whether THIS process was started by a background relaunch. Read by the
/// frontend (so its first reveal does not take focus) and by the reveal
/// backstop in `lib.rs`.
#[derive(Default)]
pub struct BackgroundLaunch(AtomicBool);

impl BackgroundLaunch {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn marker_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(MARKER))
}

/// True when a marker written at `written_ms` still applies at `now_ms`.
pub fn marker_is_fresh(written_ms: u64, now_ms: u64) -> bool {
    now_ms >= written_ms && now_ms - written_ms <= MARKER_TTL_MS
}

/// Consume the marker (always deleting it) and report whether it applies.
pub fn take_marker<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(path) = marker_path(app) else { return false };
    let Ok(raw) = std::fs::read_to_string(&path) else { return false };
    let _ = std::fs::remove_file(&path);
    raw.trim()
        .parse::<u64>()
        .map(|written| marker_is_fresh(written, now_ms()))
        .unwrap_or(false)
}

/// Called by `setup`: if this launch is a background relaunch, remember it and
/// give focus back to whatever the user was using.
pub fn apply_on_launch<R: Runtime>(app: &AppHandle<R>) {
    if !take_marker(app) {
        return;
    }
    app.state::<BackgroundLaunch>().0.store(true, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    if let Err(e) = app.hide() {
        log::warn!("[relaunch] could not hide after a background relaunch: {e}");
    }
}

/// Write (`background: true`) or clear the marker for the next launch.
#[tauri::command]
pub fn set_background_relaunch<R: Runtime>(
    app: AppHandle<R>,
    background: bool,
) -> Result<(), AppError> {
    let Some(path) = marker_path(&app) else { return Ok(()) };
    if !background {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError(e.to_string()))?;
    }
    std::fs::write(&path, now_ms().to_string()).map_err(|e| AppError(e.to_string()))
}

/// Was this process started by a background relaunch?
#[tauri::command]
pub fn launched_in_background(state: State<'_, BackgroundLaunch>) -> bool {
    state.get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_marker_applies() {
        assert!(marker_is_fresh(1_000, 1_000));
        assert!(marker_is_fresh(1_000, 1_000 + MARKER_TTL_MS));
    }

    #[test]
    fn stale_or_future_marker_is_ignored() {
        assert!(!marker_is_fresh(1_000, 1_001 + MARKER_TTL_MS));
        // A clock that went backwards must not make a marker live forever.
        assert!(!marker_is_fresh(5_000, 1_000));
    }
}
