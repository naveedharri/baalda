//! Loopback listener for desktop Google sign-in (spec 04 §7).
//!
//! Google consent can't redirect into the Tauri webview, so it runs in the
//! system browser and lands on a short-lived `http://127.0.0.1:<port>/…` URL
//! this module serves. The two commands split the flow so the TS layer can slot
//! the server round-trip in between:
//!
//!   1. `google_oauth_listen` binds an ephemeral loopback port, spawns a thread
//!      that waits for the single browser redirect, and returns the port. The TS
//!      layer then asks the server for the Google authorize URL (embedding this
//!      port in the callback) and opens it in the browser.
//!   2. `google_oauth_await` blocks until the redirect arrives (or times out)
//!      and returns the one-time `code` (or the OAuth `error`).
//!
//! Everything stays on 127.0.0.1, so the token handoff never leaves the machine
//! and no OS firewall prompt is triggered.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::State;

/// Ok(code) on a successful redirect, Err(message) on an OAuth error or a
/// malformed/absent redirect.
pub type OauthResult = Result<String, String>;

/// How long the browser flow may take before we give up waiting.
const FLOW_TIMEOUT: Duration = Duration::from_secs(180);

/// Bind a loopback listener and start waiting for the OAuth redirect in the
/// background. Returns the chosen port for the caller to build the callback URL.
#[tauri::command]
pub fn google_oauth_listen(state: State<AppState>) -> AppResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::new(format!("oauth: bind loopback: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::new(format!("oauth: local addr: {e}")))?
        .port();

    let (tx, rx) = mpsc::channel::<OauthResult>();
    *state
        .oauth_rx
        .lock()
        .map_err(|_| AppError::new("oauth: state poisoned"))? = Some(rx);

    std::thread::spawn(move || {
        // Non-blocking accept so the thread can honour the deadline and never
        // lingers forever if the user abandons the browser.
        if listener.set_nonblocking(true).is_err() {
            let _ = tx.send(Err("could not arm loopback listener".into()));
            return;
        }
        let deadline = Instant::now() + FLOW_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = tx.send(handle_connection(stream));
                    return;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        let _ = tx.send(Err("timed out waiting for sign-in".into()));
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("loopback accept failed: {e}")));
                    return;
                }
            }
        }
    });

    Ok(port)
}

/// Wait for the redirect and return the one-time code. Errors if the flow
/// returned an OAuth error, timed out, or `listen` was never called.
///
/// `async` + `spawn_blocking` is load-bearing: the receive blocks for up to the
/// flow timeout, and a *synchronous* command would run that on the main thread
/// and freeze the whole webview until it returns (so nothing — not even a Cancel
/// button — could respond). Off the main thread the UI stays live throughout.
#[tauri::command]
pub async fn google_oauth_await(state: State<'_, AppState>) -> AppResult<String> {
    // Take the receiver out (dropping the guard) before we await — a MutexGuard
    // can't be held across an await point, and the receiver moves into the task.
    let rx = {
        let mut guard = state
            .oauth_rx
            .lock()
            .map_err(|_| AppError::new("oauth: state poisoned"))?;
        guard
            .take()
            .ok_or_else(|| AppError::new("oauth: no listen in progress"))?
    };

    // A hair longer than the listener's own deadline so we surface its message
    // rather than a bare channel timeout.
    let recv = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(FLOW_TIMEOUT + Duration::from_secs(5))
    })
    .await
    .map_err(|e| AppError::new(format!("oauth: await task failed: {e}")))?;

    match recv {
        Ok(Ok(code)) => Ok(code),
        Ok(Err(msg)) => Err(AppError::new(format!("Google sign-in failed: {msg}"))),
        Err(RecvTimeoutError::Timeout) => Err(AppError::new("Google sign-in timed out")),
        Err(RecvTimeoutError::Disconnected) => {
            Err(AppError::new("Google sign-in was interrupted"))
        }
    }
}

/// The Baalda wordmark (ink version — the "BAALDA" lettering with the neural
/// connection forming the second A), pre-encoded as a `data:` URI so the loopback
/// page is fully self-contained. Mirrors `apps/desktop/src/assets/
/// baalda-wordmark-ink.png`; regenerate with `base64` if the asset changes.
const WORDMARK: &str = include_str!("assets/wordmark-ink.datauri");

/// Brand-styled CSS for the callback page — light baalda.com aesthetic: airy
/// off-white canvas, soft signature-green glow, the Baalda wordmark as the mark,
/// Radio Canada Big display + Inter body. The `__ACCENT__` token is swapped per
/// outcome (green success, warm red failure). No user input is ever interpolated
/// into the page.
const PAGE_CSS: &str = r#":root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
color:#14141a;-webkit-font-smoothing:antialiased;
font-family:"Radio Canada Big",-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
background:radial-gradient(760px 460px at 50% -12%,rgba(87,189,156,.16),transparent 60%),
radial-gradient(620px 420px at 92% 114%,rgba(87,189,156,.08),transparent 60%),#f6f7f9}
.card{text-align:center;padding:2.75rem 1.75rem;max-width:27rem;
animation:rise .6s cubic-bezier(.16,1,.3,1) both}
.wordmark{width:190px;max-width:66%;height:auto;display:block;margin:0 auto 30px;
filter:drop-shadow(0 10px 24px rgba(20,20,26,.12))}
h1{display:flex;align-items:center;justify-content:center;gap:10px;
margin:0 0 12px;font-size:1.4rem;font-weight:700;letter-spacing:-.02em;color:#14141a}
.pip{width:24px;height:24px;border-radius:999px;display:inline-grid;place-items:center;
background:__ACCENT__;color:#fff;flex:none;box-shadow:0 3px 9px color-mix(in srgb,__ACCENT__ 45%,transparent)}
.pip svg{width:14px;height:14px}
p{margin:0 auto;max-width:23rem;font-size:.97rem;line-height:1.55;color:#5f5f6b;
font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}"#;

/// Build the full callback page. `ok` selects the accent + status pip; the Baalda
/// wordmark is the mark. `title`/`body` are static copy (never user-supplied), so
/// the page is XSS-free by construction.
fn render_page(ok: bool, title: &str, body: &str) -> String {
    let accent = if ok { "#57bd9c" } else { "#dd6a52" };
    let pip = if ok {
        r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>"#
    } else {
        r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 16.6v.3"/></svg>"#
    };
    let css = PAGE_CSS.replace("__ACCENT__", accent);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title} · Baalda</title><style>{css}</style></head>\
         <body><main class=\"card\">\
         <img class=\"wordmark\" src=\"{wordmark}\" alt=\"Baalda\">\
         <h1><span class=\"pip\">{pip}</span>{title}</h1><p>{body}</p>\
         </main></body></html>",
        wordmark = WORDMARK,
    )
}

/// Read the request line, extract `code`/`error` from the query, and reply with
/// a small "you can close this" page.
fn handle_connection(mut stream: std::net::TcpStream) -> OauthResult {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("clone stream: {e}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| format!("read request: {e}"))?;

    // "GET /cb?code=… HTTP/1.1"
    let target = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut code: Option<String> = None;
    let mut error: Option<String> = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("code", v)) => code = Some(v.to_string()),
            Some(("error", v)) => error = Some(v.to_string()),
            _ => {}
        }
    }

    let (ok, title, body, result) = match (&code, &error) {
        (Some(c), _) => (
            true,
            "Signed in",
            "You're all set — close this tab and head back to Baalda.",
            Ok(c.clone()),
        ),
        (None, Some(e)) => (
            false,
            "Sign-in failed",
            "That didn't go through. Close this tab and try again from the app.",
            Err(e.clone()),
        ),
        (None, None) => (
            false,
            "Sign-in failed",
            "That didn't go through. Close this tab and try again from the app.",
            Err("missing authorization code".to_string()),
        ),
    };

    let html = render_page(ok, title, body);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpStream;

    /// Drive a full listen → browser-redirect → await cycle over a real socket.
    #[test]
    fn round_trips_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<OauthResult>();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = tx.send(handle_connection(stream));
        });

        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(b"GET /cb?code=abc123&scope=email HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        // Drain the response so the server-side write doesn't error.
        let mut buf = String::new();
        let _ = stream.read_to_string(&mut buf);

        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok("abc123".into()));
        assert!(buf.contains("Signed in"));
    }

    #[test]
    fn surfaces_oauth_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<OauthResult>();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = tx.send(handle_connection(stream));
        });

        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(b"GET /cb?error=access_denied HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut buf = String::new();
        let _ = stream.read_to_string(&mut buf);

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err("access_denied".into())
        );
    }
}
