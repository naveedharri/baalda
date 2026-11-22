// SPDX-License-Identifier: Apache-2.0
//! Isolated HTML runtime. Vault resources carry their epoch in the URL path,
//! so relative requests from a surviving iframe cannot enter the next vault.

use crate::error::{AppError, AppResult};
use crate::index::{DashboardNote, Index, NoteQuery, PropertyFilter};
use crate::state::AppState;
use crate::vault;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    http::{Request, Response, StatusCode},
    Manager, State,
};

/// Parent scripts remain restricted to 'self'; only the isolated document gets
/// the script allowance. Fetch, nested frames, forms and remote image beacons
/// cannot leave the document through this policy.
pub const DASHBOARD_CSP: &str = "default-src 'none'; script-src 'self' baalda-view: http://baalda-view.localhost https://baalda-view.localhost 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' baalda-view: http://baalda-view.localhost https://baalda-view.localhost 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' baalda-view: http://baalda-view.localhost https://baalda-view.localhost data: blob:; media-src 'self' baalda-view: http://baalda-view.localhost https://baalda-view.localhost data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";
const ASSET_CSP: &str = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' baalda-view: http://baalda-view.localhost https://baalda-view.localhost data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
const MAX_RESOURCE_BYTES: u64 = 10 * 1024 * 1024;
const SDK: &[u8] = include_bytes!("../../src/lib/dashboard/sdk.js");
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

struct RequestSlot;
pub(crate) struct DashboardViewLease {
    epoch: u64,
    path: String,
}
impl Drop for RequestSlot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn handle_request<R: tauri::Runtime>(
    context: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if IN_FLIGHT.fetch_add(1, Ordering::Relaxed) >= 16 {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
        responder.respond(response(
            StatusCode::TOO_MANY_REQUESTS,
            "text/plain",
            b"Too many view requests".to_vec(),
        ));
        return;
    }
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = RequestSlot;
        let state = app.state::<AppState>();
        let result = if let Some(id) = request.uri().path().strip_prefix("/__baalda/template/") {
            serve_template(&app, id, request.method().as_str())
        } else { serve(&state, &request) };
        responder.respond(result.unwrap_or_else(|_| {
            response(
                StatusCode::NOT_FOUND,
                "text/plain",
                b"View resource unavailable".to_vec(),
            )
        }));
    });
}

const TEMPLATE_IDS: &[&str] = &[
    "orbit-agentic-os",
    "waystation-agentic-os",
    "meridian-agentic-os",
    "cosmos-agentic-os",
    "sales-os",
    "marketing-os",
    "startbootstrap-sb-admin",
    "material-dashboard-v3",
    "mazer",
    "corona-free-dark-bootstrap-admin-template",
    "StarAdmin-Free-Bootstrap-Admin-Template",
    "materio-bootstrap-html-admin-template-free",
    "sneat-html-admin-template-free",
    "PurpleAdmin-Free-Admin-Template",
    "startbootstrap-sb-admin-2",
    "light-bootstrap-dashboard",
    "AdminLTE",
    "plainadmin",
    "argon-dashboard",
    "tabler",
    "now-ui-dashboard",
    "paper-dashboard",
    "adminkit",
    "MajesticAdmin-Free-Bootstrap-Admin-Template",
    "soft-ui-dashboard",
    "black-dashboard"
];

fn serve_template<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, method: &str) -> AppResult<Response<Vec<u8>>> {
    if method != "GET" || !TEMPLATE_IDS.contains(&id) { return Err(AppError::new("unknown template")); }
    let path = format!("dashboard-templates/{id}.html");
    #[cfg(debug_assertions)]
    let body = { let _ = app; std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public").join(&path))
        .map_err(|_| AppError::new("template unavailable"))? };
    #[cfg(not(debug_assertions))]
    let body = app.asset_resolver().get(path).ok_or_else(|| AppError::new("template unavailable"))?.bytes;
    Ok(response(StatusCode::OK, "text/html; charset=utf-8", body))
}

fn serve(state: &AppState, request: &Request<Vec<u8>>) -> AppResult<Response<Vec<u8>>> {
    if request.method() != "GET" {
        return Err(AppError::new("unsupported view method"));
    }
    if request
        .uri()
        .query()
        .is_some_and(|query| query.len() > 2048)
    {
        return Err(AppError::new("view query too long"));
    }
    let path = decode_path(request.uri().path())?;
    if path == "/__baalda/sdk.js" {
        return Ok(response(
            StatusCode::OK,
            "application/javascript; charset=utf-8",
            SDK.to_vec(),
        ));
    }
    let (epoch, rel) = resource_path(&path)?;
    // The URL surface is presentation assets, never a second raw note API.
    // Markdown/JSON/link content is available only through the checked bridge.
    if !is_view_asset(rel) {
        return Err(AppError::new("not a view asset"));
    }
    let lease = if is_html(rel) {
        Some(
            request
                .uri()
                .query()
                .and_then(|query| {
                    query
                        .split('&')
                        .find_map(|part| part.strip_prefix("lease="))
                })
                .ok_or_else(|| AppError::new("missing view lease"))?
                .to_string(),
        )
    } else {
        None
    };
    if let Some(token) = &lease {
        require_view_lease(state, token, epoch, rel)?;
    }
    let root = {
        let inner = state.inner.lock().unwrap();
        if inner.vault_epoch != epoch {
            return Err(AppError::new("vault changed"));
        }
        inner
            .vault
            .clone()
            .ok_or_else(|| AppError::new("no vault is open"))?
    };
    let file = resolve_resource(&root, rel)?;
    let mut body = read_resource(&file)?;
    if is_html(rel) {
        if let Ok(html) = std::str::from_utf8(&body) {
            if html.contains("baalda-template-credit") {
                body = html.replacen("</head>", "<style>.baalda-template-credit{display:none!important}</style></head>", 1).into_bytes();
            }
        }
    }
    if is_html(rel) {
        if let Ok(html) = std::str::from_utf8(&body) {
            body = template_spacing(html).into_bytes();
        }
    }
    // A request that was already on disk during a switch must not answer after
    // the switch. Nothing resolves against the global vault outside this guard.
    let inner = state.inner.lock().unwrap();
    if inner.vault_epoch != epoch || inner.vault.as_ref() != Some(&root) {
        return Err(AppError::new("vault changed"));
    }
    if let Some(token) = &lease {
        require_view_lease(state, token, epoch, rel)?;
    }
    Ok(response(StatusCode::OK, content_type(rel), body))
}

// Keep existing saved templates comfortable without rewriting the user's file.
fn template_spacing(html: &str) -> String {
    if !html.contains("name=\"baalda-template\"") {
        return html.to_owned();
    }
    let css = include_str!("../../public/dashboard-template-spacing.css");
    let style = format!("<style id=\"baalda-template-spacing\">{css}</style>");
    if let Some(start) = html.find("<style id=\"baalda-template-spacing\">") {
        if let Some(end) = html[start..].find("</style>") {
            return format!("{}{}{}", &html[..start], style, &html[start + end + 8..]);
        }
        return html.to_owned();
    }
    html.replacen("</head>", &format!("{style}</head>"), 1)
}

fn response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header(
            "Content-Security-Policy",
            if !mime.starts_with("text/html") {
                ASSET_CSP
            } else {
                DASHBOARD_CSP
            },
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .expect("constant response headers are valid")
}

fn resource_path(path: &str) -> AppResult<(u64, &str)> {
    let tail = path
        .strip_prefix("/__baalda/vault/")
        .ok_or_else(|| AppError::new("missing view epoch"))?;
    let (epoch, rel) = tail
        .split_once('/')
        .ok_or_else(|| AppError::new("missing view path"))?;
    if epoch.is_empty() || !epoch.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::new("invalid view epoch"));
    }
    let epoch = epoch
        .parse()
        .map_err(|_| AppError::new("invalid view epoch"))?;
    Ok((epoch, rel))
}

fn decode_path(path: &str) -> AppResult<String> {
    if path.len() > 16384 {
        return Err(AppError::new("view path too long"));
    }
    let mut bytes = Vec::with_capacity(path.len());
    let mut iter = path.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let a = iter.next().and_then(|v| (v as char).to_digit(16));
            let b = iter.next().and_then(|v| (v as char).to_digit(16));
            let (Some(a), Some(b)) = (a, b) else {
                return Err(AppError::new("invalid URL encoding"));
            };
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(b);
        }
    }
    let decoded = String::from_utf8(bytes).map_err(|_| AppError::new("invalid URL path"))?;
    if decoded.chars().any(|c| c.is_control()) {
        return Err(AppError::new("invalid URL path"));
    }
    Ok(decoded)
}

fn resolve_resource(root: &Path, rel: &str) -> AppResult<PathBuf> {
    // Backslash/drive/stream names must be rejected on every OS, not just when
    // the local Path implementation happens to interpret them specially.
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.contains(':')
        || rel
            .split('/')
            .any(|s| s.is_empty() || vault::is_hidden_name_strict(s))
        || !vault::is_allowed_file(rel)
    {
        return Err(AppError::new("invalid view resource"));
    }
    let path = vault::resolve_in_vault(root, rel)?;
    if vault::vault_path_state(root, rel) != vault::PathState::Regular {
        return Err(AppError::new("view resource is not a regular file"));
    }
    let root = root.canonicalize()?;
    let path = path.canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(AppError::new("view resource escapes vault"));
    }
    Ok(path)
}

fn is_view_asset(rel: &str) -> bool {
    matches!(
        rel.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "html"
            | "htm"
            | "png"
            | "jpg"
            | "jpeg"
            | "jfif"
            | "gif"
            | "webp"
            | "svg"
            | "bmp"
            | "ico"
            | "avif"
            | "heic"
            | "heif"
            | "tiff"
            | "tif"
            | "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "mp3"
            | "wav"
            | "m4a"
            | "ogg"
            | "aac"
            | "flac"
    )
}

fn is_html(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "html" | "htm"
    )
}

fn require_view_lease(state: &AppState, token: &str, epoch: u64, path: &str) -> AppResult<()> {
    let views = state.dashboard_views.lock().unwrap();
    if views
        .get(token)
        .is_some_and(|view| view.epoch == epoch && view.path == path)
    {
        Ok(())
    } else {
        Err(AppError::new("view is not mounted"))
    }
}

/// Only the trusted host mounts a page after its normal note access checks.
/// The guest's sandbox and CSP prohibit Tauri IPC and cannot issue leases.
#[tauri::command]
pub async fn dashboard_mount_view(
    state: State<'_, AppState>,
    path: String,
    epoch: u64,
) -> AppResult<String> {
    if !is_html(&path) {
        return Err(AppError::new("not an HTML view"));
    }
    let root = {
        let inner = state.inner.lock().unwrap();
        if inner.vault_epoch != epoch {
            return Err(AppError::new("vault changed"));
        }
        inner
            .vault
            .clone()
            .ok_or_else(|| AppError::new("no vault is open"))?
    };
    resolve_resource(&root, &path)?;
    let inner = state.inner.lock().unwrap();
    if inner.vault_epoch != epoch || inner.vault.as_ref() != Some(&root) {
        return Err(AppError::new("vault changed"));
    }
    let mut views = state.dashboard_views.lock().unwrap();
    views.retain(|_, view| view.epoch == epoch);
    if views.len() >= 16 {
        return Err(AppError::new("too many mounted HTML views"));
    }
    let token = uuid::Uuid::new_v4().to_string();
    views.insert(token.clone(), DashboardViewLease { epoch, path });
    Ok(token)
}

#[tauri::command]
pub async fn dashboard_unmount_view(
    state: State<'_, AppState>,
    lease: String,
    epoch: u64,
) -> AppResult<()> {
    revoke_view_lease(&state, &lease, epoch);
    Ok(())
}

fn revoke_view_lease(state: &AppState, lease: &str, epoch: u64) {
    let mut views = state.dashboard_views.lock().unwrap();
    if views.get(lease).is_some_and(|view| view.epoch == epoch) {
        views.remove(lease);
    }
}

fn read_resource(path: &Path) -> AppResult<Vec<u8>> {
    let file = open_resource(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_RESOURCE_BYTES {
        return Err(AppError::new("view resource too large"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_RESOURCE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RESOURCE_BYTES {
        return Err(AppError::new("view resource too large"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_resource(path: &Path) -> AppResult<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    // Anchor each component to the already-open directory. This closes the
    // symlink-swap gap between path validation and the actual read, including
    // for an intermediate directory replaced while a page is loading.
    let mut handle = std::fs::File::open("/")?;
    let parts = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect::<Vec<_>>();
    for (i, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_bytes()).map_err(|_| AppError::new("invalid view path"))?;
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if i + 1 < parts.len() {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: handle owns a live directory descriptor, and name is a
        // terminated single component. Successful openat returns an owned fd.
        let fd = unsafe { libc::openat(handle.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        handle = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(handle)
}

#[cfg(windows)]
fn open_resource(path: &Path) -> AppResult<std::fs::File> {
    use std::ffi::{c_void, OsString};
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    // This API is part of kernel32 on every supported Windows version. A tiny
    // declaration keeps the reader independent of the runner's Win32 features.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            capacity: u32,
            flags: u32,
        ) -> u32;
    }
    let file = std::fs::File::open(path)?;
    let mut name = vec![0_u16; 32768];
    // SAFETY: file owns a live handle and name owns capacity writable UTF-16
    // elements. Flags 0 request the normalized DOS path, as canonicalize does.
    let len = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            0,
        )
    };
    if len == 0 || len as usize >= name.len() {
        return Err(AppError::new("could not validate opened view resource"));
    }
    let opened_path = PathBuf::from(OsString::from_wide(&name[..len as usize]));
    // `resolve_resource` returned the canonical path BEFORE the open. Comparing
    // the actual handle catches a symlink/junction swap in any component.
    if opened_path != path {
        return Err(AppError::new("view resource changed during read"));
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_resource(path: &Path) -> AppResult<std::fs::File> {
    Ok(std::fs::File::open(path)?)
}

fn content_type(rel: &str) -> &'static str {
    match rel
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "json" | "canvas" => "application/json",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "md" | "markdown" | "mdx" | "txt" | "csv" | "tsv" | "yaml" | "yml" | "toml" | "xml"
        | "py" | "rs" | "go" | "sh" | "sql" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn query_index(state: &AppState, epoch: u64) -> AppResult<Arc<Mutex<Index>>> {
    let inner = state.inner.lock().unwrap();
    if inner.vault_epoch != epoch || inner.vault.is_none() {
        return Err(AppError::new("vault changed or closed"));
    }
    inner
        .index
        .clone()
        .ok_or_else(|| AppError::new("index not initialized"))
}

/// The dashboard bridge uses this reader instead of the editor's general file
/// command: a page is untrusted and must not follow links or private paths.
#[tauri::command]
pub async fn dashboard_read_note(
    state: State<'_, AppState>,
    path: String,
    epoch: u64,
) -> AppResult<String> {
    if !vault::is_note_file(&path) {
        return Err(AppError::new("not a note"));
    }
    let root = {
        let inner = state.inner.lock().unwrap();
        if inner.vault_epoch != epoch {
            return Err(AppError::new("vault changed"));
        }
        inner
            .vault
            .clone()
            .ok_or_else(|| AppError::new("no vault is open"))?
    };
    let text = String::from_utf8(read_resource(&resolve_resource(&root, &path)?)?)
        .map_err(|_| AppError::new("note is not UTF-8"))?;
    let inner = state.inner.lock().unwrap();
    if inner.vault_epoch != epoch || inner.vault.as_ref() != Some(&root) {
        return Err(AppError::new("vault changed"));
    }
    Ok(text)
}

#[tauri::command]
pub async fn query_notes(
    state: State<'_, AppState>,
    query: NoteQuery,
    epoch: u64,
) -> AppResult<Vec<DashboardNote>> {
    let index = query_index(&state, epoch)?;
    let result = index.lock().unwrap().query_notes(&query)?;
    Ok(result)
}

#[tauri::command]
pub async fn list_notes_by_tag(
    state: State<'_, AppState>,
    tag: String,
    limit: Option<usize>,
    epoch: u64,
) -> AppResult<Vec<DashboardNote>> {
    query_notes(
        state,
        NoteQuery {
            tag: Some(tag),
            limit,
            ..Default::default()
        },
        epoch,
    )
    .await
}

#[tauri::command]
pub async fn list_notes_by_property(
    state: State<'_, AppState>,
    property: PropertyFilter,
    limit: Option<usize>,
    epoch: u64,
) -> AppResult<Vec<DashboardNote>> {
    query_notes(
        state,
        NoteQuery {
            property: Some(property),
            limit,
            ..Default::default()
        },
        epoch,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_template_spacing_is_scoped_and_idempotent() {
        let plain = "<html><head></head><body>Custom dashboard</body></html>";
        assert_eq!(template_spacing(plain), plain);
        let paper = "<head><meta name=\"baalda-template\" content=\"paper-dashboard\"></head>";
        let padded = template_spacing(paper);
        assert!(padded.contains("padding-top:24px"));
        assert_eq!(template_spacing(&padded), padded);
        let older = paper.replace("</head>", "<style id=\"baalda-template-spacing\">old spacing</style></head>");
        let refreshed = template_spacing(&older);
        assert!(!refreshed.contains("old spacing"));
        assert!(refreshed.contains("padding-inline:clamp(16px, 2vw, 24px)"));
        assert_eq!(refreshed.matches("id=\"baalda-template-spacing\"").count(), 1);
    }

    #[test]
    fn rejects_private_traversal_unsupported_and_windows_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Home.html"), "<h1>Home</h1>").unwrap();
        assert!(resolve_resource(dir.path(), "Home.html").is_ok());
        for rel in [
            "../Home.html",
            "/Home.html",
            ".context/config.json",
            "x/.secret.html",
            "C:/Home.html",
            "x\\Home.html",
            "Home.html:secret",
            "x.js",
            "",
        ] {
            assert!(resolve_resource(dir.path(), rel).is_err(), "{rel}");
        }
        assert_eq!(
            decode_path("/%2e%2e/%2Econtext/a").unwrap(),
            "/../.context/a"
        );
        assert!(decode_path("/%00").is_err());
        assert!(decode_path("/%GG").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_and_directory_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.html"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.html"),
            dir.path().join("Link.html"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("Links")).unwrap();
        assert!(resolve_resource(dir.path(), "Link.html").is_err());
        assert!(resolve_resource(dir.path(), "Links/secret.html").is_err());
        // Even after a prior validation result, the final open refuses a link.
        assert!(read_resource(&dir.path().join("Link.html")).is_err());
        assert!(read_resource(&dir.path().join("Links/secret.html")).is_err());
    }

    #[test]
    fn requires_epoch_and_refuses_old_vault() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Home.html"), "home").unwrap();
        let state = AppState::default();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.vault = Some(dir.path().into());
            inner.vault_epoch = 2;
        }
        let request = |path| Request::builder().uri(path).body(Vec::new()).unwrap();
        assert!(serve(&state, &request("/__baalda/vault/1/Home.html")).is_err());
        assert!(serve(&state, &request("/Home.html")).is_err());
        state.dashboard_views.lock().unwrap().insert(
            "test-lease".into(),
            DashboardViewLease {
                epoch: 2,
                path: "Home.html".into(),
            },
        );
        assert!(serve(&state, &request("/__baalda/vault/2/Home.html")).is_err());
        let response = serve(
            &state,
            &request("/__baalda/vault/2/Home.html?lease=test-lease"),
        )
        .unwrap();
        assert_eq!(response.body(), b"home");
        assert_eq!(response.headers()["content-security-policy"], DASHBOARD_CSP);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(serve(&state, &request("/__baalda/vault/2/%2e%2e/Home.html")).is_err());
        assert!(serve(&state, &request("/__baalda/sdk.js")).is_ok());
    }

    #[test]
    fn bounds_resource_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.html");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_RESOURCE_BYTES + 1).unwrap();
        assert!(read_resource(&path).is_err());
    }

    #[test]
    fn html_leases_are_exact_and_late_unmount_keeps_the_new_frame() {
        let state = AppState::default();
        for token in ["old", "new"] {
            state.dashboard_views.lock().unwrap().insert(
                token.into(),
                DashboardViewLease {
                    epoch: 2,
                    path: "Home.html".into(),
                },
            );
        }
        assert!(require_view_lease(&state, "new", 2, "Other.html").is_err());
        assert!(require_view_lease(&state, "new", 3, "Home.html").is_err());
        revoke_view_lease(&state, "old", 2);
        assert!(require_view_lease(&state, "old", 2, "Home.html").is_err());
        assert!(require_view_lease(&state, "new", 2, "Home.html").is_ok());
        assert!(!is_view_asset("Private.md"));
        assert!(!is_view_asset("private.json"));
        assert!(!is_view_asset("Link.url"));
        assert!(is_view_asset("Images/a.svg"));
        for mime in [
            "image/svg+xml",
            "image/png",
            "video/mp4",
            "application/javascript; charset=utf-8",
            "text/plain",
        ] {
            let asset = response(StatusCode::OK, mime, b"asset".to_vec());
            assert_eq!(asset.headers()["content-security-policy"], ASSET_CSP);
        }
        assert!(!ASSET_CSP.contains("allow-scripts"));
    }

    #[test]
    fn isolated_policy_keeps_network_frames_and_ipc_closed() {
        let directives = DASHBOARD_CSP.split(';').map(str::trim).collect::<Vec<_>>();
        for guard in [
            "default-src 'none'",
            "connect-src 'none'",
            "frame-src 'none'",
            "object-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ] {
            assert!(directives.contains(&guard), "{guard}");
        }
        assert!(!DASHBOARD_CSP.contains("allow-same-origin"));
        assert!(!DASHBOARD_CSP.contains("allow-top-navigation"));
        assert!(!DASHBOARD_CSP.contains("ipc:"));
        assert!(!DASHBOARD_CSP.contains("'unsafe-eval'"));
    }
}
