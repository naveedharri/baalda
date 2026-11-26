//! Windows: keep the WebView2 page alive across long stretches in the background.
//!
//! Reported: after Baalda sat in the background for a while on Windows, coming
//! back showed a blank window. WebView2 runs the page in a separate renderer
//! process; when Windows ends that process (memory pressure, sleep, a GPU reset)
//! the window keeps its frame but the page is gone, and nothing in Tauri or wry
//! brings it back: `ProcessFailed` had no handler, so the app stayed blank
//! until it was quit and reopened.
//!
//! Here: a renderer that exited reloads the page (the app starts again from
//! its local files and sync state; the renderer was already gone, so nothing in
//! memory is lost by reloading); a browser process that exited restarts the app;
//! a GPU process that exited, and every return of focus, asks WebView2 to
//! re-place its surface. Every event is logged, so a user's log says what
//! happened. Reloads and restarts are rate-limited so a page that keeps crashing
//! can never loop.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewWindow, WindowEvent};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;

/// At most this many automatic reloads inside `RELOAD_WINDOW`.
const MAX_RELOADS: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(10 * 60);
/// A browser-process exit restarts the app only after it ran this long, so a
/// webview that dies at startup can never restart-loop.
const MIN_UPTIME_FOR_RESTART: Duration = Duration::from_secs(60);

static RELOADS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

/// Whether another automatic reload is allowed now (and records it if so).
pub(crate) fn allow_reload(now: Instant, history: &mut Vec<Instant>) -> bool {
    history.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
    if history.len() >= MAX_RELOADS {
        return false;
    }
    history.push(now);
    true
}

fn kind_name(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match kind.0 {
        0 => "browser process exited",
        1 => "renderer exited",
        2 => "renderer unresponsive",
        3 => "frame renderer exited",
        4 => "utility process exited",
        5 => "sandbox helper exited",
        6 => "GPU process exited",
        7 | 8 => "plugin process exited",
        _ => "other process exited",
    }
}

pub fn install(win: &WebviewWindow) {
    let started = Instant::now();
    let app = win.app_handle().clone();
    let result = win.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        let core: ICoreWebView2 = match controller.CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                log::warn!("[webview] recovery not installed: no CoreWebView2 ({e})");
                return;
            }
        };
        let handler_controller = controller.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(
            move |sender: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                log::warn!("[webview] WebView2 {} (kind {})", kind_name(kind), kind.0);
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    let allowed = RELOADS.lock().map(|mut h| allow_reload(Instant::now(), &mut h)).unwrap_or(false);
                    if !allowed {
                        log::warn!("[webview] page gone again; not reloading (limit reached)");
                    } else if let Some(webview) = sender {
                        log::warn!("[webview] reloading the page");
                        if let Err(e) = webview.Reload() {
                            log::warn!("[webview] reload failed: {e}");
                        }
                    }
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    if started.elapsed() >= MIN_UPTIME_FOR_RESTART {
                        log::warn!("[webview] restarting Baalda to bring the window back");
                        app.restart();
                    }
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED {
                    let _ = handler_controller.NotifyParentWindowPositionChanged();
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                    // Busy, not gone: a long sync can do this. Reloading would cut it off.
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            log::warn!("[webview] recovery not installed: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("[webview] recovery not installed: {e}");
    }

    // Coming back to the window: ask WebView2 to re-place its surface. Cheap,
    // and it repaints a surface that went stale while the window was away.
    let nudged = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(true) = event {
            let _ = nudged.with_webview(|platform| unsafe {
                let _ = platform.controller().NotifyParentWindowPositionChanged();
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_are_capped_per_window() {
        let t0 = Instant::now();
        let mut h = Vec::new();
        assert!(allow_reload(t0, &mut h));
        assert!(allow_reload(t0 + Duration::from_secs(1), &mut h));
        assert!(allow_reload(t0 + Duration::from_secs(2), &mut h));
        assert!(!allow_reload(t0 + Duration::from_secs(3), &mut h));
        assert!(allow_reload(t0 + RELOAD_WINDOW + Duration::from_secs(1), &mut h));
    }
}
