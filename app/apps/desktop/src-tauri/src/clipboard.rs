//! Write-only native clipboard, always on the MAIN thread.
//!
//! `NSPasteboard` is not thread-safe. WebKit writes it on the main thread (every
//! copy event's `clipboardData`), while `tauri-plugin-clipboard-manager` runs its
//! async commands on a tokio worker. A rich note copy does both back to back, and
//! the two writes racing inside AppKit crashed the app (SIGSEGV in
//! `_NSPasteboardDeclareTypes`, 0.1.68). Hopping onto the main thread serialises
//! our write with WebKit's.
//!
//! One `arboard::Clipboard` lives for the whole process: on Linux the selection
//! is served by that instance, so dropping it after each write would lose the
//! contents. It is only ever touched from the main thread.

use crate::error::{AppError, AppResult};
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Default)]
pub struct ClipboardState(Mutex<Option<arboard::Clipboard>>);

fn write(state: &ClipboardState, text: &str, html: Option<&str>) -> AppResult<()> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| AppError(e.to_string()))?);
    }
    let clipboard = slot.as_mut().expect("clipboard initialised above");
    match html {
        Some(html) => clipboard.set_html(html, Some(text)),
        None => clipboard.set_text(text),
    }
    .map_err(|e| AppError(e.to_string()))
}

/// Put `text` (and optionally `html`, with `text` as its plain alternative) on
/// the system clipboard. There is deliberately no read command.
#[tauri::command]
pub async fn clipboard_write(app: AppHandle, text: String, html: Option<String>) -> AppResult<()> {
    use tauri::Manager;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<ClipboardState>();
        let _ = tx.send(write(&state, &text, html.as_deref()));
    })
    .map_err(|e| AppError(e.to_string()))?;
    rx.await.map_err(|_| AppError("clipboard write was dropped".into()))?
}

fn clear_if(state: &ClipboardState, expected_sha256: &str) -> AppResult<bool> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| AppError(e.to_string()))?);
    }
    let clipboard = slot.as_mut().expect("clipboard initialised above");
    // Not text (an image, a file, empty): someone copied something else since.
    let Ok(current) = clipboard.get_text() else { return Ok(false) };
    if crate::notefile::sha256_hex(&current) != expected_sha256.to_ascii_lowercase() {
        return Ok(false);
    }
    clipboard.clear().map_err(|e| AppError(e.to_string()))?;
    Ok(true)
}

/// Clear the clipboard only if it still holds the text whose sha256 (hex) is
/// `expected_sha256`: the timed wipe after copying a vault key. Answers only
/// whether it cleared; the clipboard's contents never reach the webview, so
/// this is still no read command. Main thread, like `clipboard_write`.
#[tauri::command]
pub async fn clipboard_clear_if(app: AppHandle, expected_sha256: String) -> AppResult<bool> {
    use tauri::Manager;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<ClipboardState>();
        let _ = tx.send(clear_if(&state, &expected_sha256));
    })
    .map_err(|e| AppError(e.to_string()))?;
    rx.await.map_err(|_| AppError("clipboard clear was dropped".into()))?
}
