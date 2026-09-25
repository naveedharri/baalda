//! Binary attachment I/O under the vault's `attachments/` dir (spec 02 §2).
//! Path-validated (traversal-rejected) like all other disk access; writes are
//! atomic (temp file + rename). Attachments are NEVER fed into the note/CRDT
//! pipeline — this module only reads/writes raw bytes and lists metadata.

use crate::error::{AppError, AppResult};
use crate::notefile::sha256_file;
use crate::vault::{
    is_allowed_file, is_ignored_name, is_note_file, rel_path_is_ignored, require_vault_root,
    resolve_in_vault,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Metadata for one attachment file (vault-relative), used by the sync diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    /// Vault-relative, forward-slash path (e.g. "attachments/img.png").
    pub rel_path: String,
    pub size: u64,
    /// Hex-encoded SHA-256 of the file contents.
    pub sha256: String,
}

/// Size + mtime of one vault file, for the file card's header. Deliberately
/// cheap: the card wants "4.2 MB, yesterday", and reading 25 MB of video
/// through the IPC bridge to learn that would be absurd.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    /// Milliseconds since the Unix epoch, or `None` when the OS won't say.
    pub modified: Option<i64>,
}

/// Stat a vault-relative file. Read-scoped like `read_binary_file` (the whole
/// vault, not just `attachments/`) — the card opens for tree files too.
pub fn file_stat(vault: &Path, rel: &str) -> AppResult<FileStat> {
    let abs = resolve_in_vault(vault, rel)?;
    let meta = std::fs::metadata(&abs)?;
    if !meta.is_file() {
        return Err(AppError::new("not a file"));
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    Ok(FileStat { size: meta.len(), modified })
}

/// Is there a FILE at this vault-relative path?
///
/// `Ok(false)` only for a definite answer — nothing there, or something that is
/// not a file. Every other failure (a permission error, an interrupted call) is
/// an `Err`, never a `false`: the disk-delete queue deletes the server's copy of
/// whatever this calls absent, so "couldn't look" must not read as "gone".
pub fn binary_exists(vault: &Path, rel: &str) -> AppResult<bool> {
    let abs = resolve_in_vault(vault, rel)?;
    match std::fs::metadata(&abs) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        // A component of the path that is a file, not a directory: nothing can
        // exist below it, which is as definite as NotFound.
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Hex SHA-256 over raw bytes.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Read a binary file at ANY vault-relative path.
///
/// The read/write asymmetry here is deliberate, not an oversight: writes are
/// confined to `attachments/` (`ensure_attachment_rel`, so nothing can drop
/// bytes next to a user's notes), while reads answer for the whole vault. Every
/// viewer needs that — a PDF, a CSV, a `.docx` or a video imported into
/// `Projects/` is a tree file, not an attachment, and refusing to read it would
/// make the sidebar list files nothing can open. `resolve_in_vault` is still
/// what bounds the path, so `..`/absolute escapes are rejected either way.
pub fn read_binary_file(vault: &Path, rel: &str) -> AppResult<Vec<u8>> {
    let abs = resolve_in_vault(vault, rel)?;
    Ok(std::fs::read(&abs)?)
}

/// A binary write may only target the `attachments/` subtree — never a note
/// path, the hidden `.context/` store, or any ignored/dotfile segment.
/// Server-supplied blob `rel_path`s flow into `write_binary_file`, so this
/// bounds an attacker-chosen path. Defence in depth behind the TS
/// `isSafeAttachmentRelPath` download filter and `resolve_in_vault`'s traversal
/// check.
fn ensure_attachment_rel(rel: &str) -> AppResult<()> {
    let mut segs = rel.split('/');
    if segs.next() != Some("attachments") {
        return Err(AppError::new("attachment path must be under attachments/"));
    }
    let mut named = false;
    for seg in segs {
        named = true;
        if seg.is_empty() || seg == "." || seg == ".." || is_ignored_name(seg) {
            return Err(AppError::new("invalid attachment path segment"));
        }
    }
    if !named {
        return Err(AppError::new("attachment path must name a file"));
    }
    Ok(())
}

/// The write guard for a binary that lives in the TREE rather than in
/// `attachments/` — a `.docx` a teammate dropped into `Team/`, which another
/// device has to materialise at that same path.
///
/// Deliberately a SECOND guard rather than a relaxation of
/// {@link ensure_attachment_rel}: that one still bounds every
/// `attachments/`-targeted write, and widening it would hand a member who sets
/// a blob's `rel_path` the whole vault. What this one accepts is exactly the set
/// the binary walk produces — a surfaced, non-note extension outside `.context`,
/// `.git`, dotfiles and `DENIED_DIRS` — so a server-supplied path can name a
/// file the user could have dropped there themselves and nothing else. Notes
/// are refused because they belong to the CRDT pipeline; a blob must never be
/// able to overwrite one.
fn ensure_tree_binary_rel(rel: &str) -> AppResult<()> {
    if rel.is_empty() || rel_path_is_ignored(rel) {
        return Err(AppError::new("invalid tree binary path"));
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if !is_allowed_file(name) || is_note_file(name) {
        return Err(AppError::new("not a syncable binary file type"));
    }
    Ok(())
}

/// Atomic write of raw bytes to a TREE binary path (see
/// {@link ensure_tree_binary_rel}). Same temp+rename as `write_binary_file`,
/// different accepted set.
pub fn write_tree_binary(vault: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    ensure_tree_binary_rel(rel)?;
    write_bytes_atomic(vault, rel, bytes)
}

/// Atomic write of raw bytes: temp file in the same dir, then rename over the
/// target so readers never observe a half-written file. Creates parent dirs.
pub fn write_binary_file(vault: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    ensure_attachment_rel(rel)?;
    write_bytes_atomic(vault, rel, bytes)
}

/// The write itself, once a caller's guard has accepted the path. Private, so
/// nothing can reach it without passing one of the two guards above.
fn write_bytes_atomic(vault: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    let abs = resolve_in_vault(vault, rel)?;
    require_vault_root(vault)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("attachment has no parent directory"))?;
    std::fs::create_dir_all(parent)?;

    let file_name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    // Unique per call, never one shared `.{name}.tmp`: two writers of the same
    // path would otherwise interleave into it (see `notefile::temp_sibling`).
    let tmp = crate::notefile::temp_sibling(parent, file_name);

    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &abs)?;
    Ok(())
}

/// One cached hash: what a file looked like the last time we hashed it.
///
/// `(size, mtime_ns)` is the validity key — the same pair the `files` table
/// uses to decide a note/binary is unchanged. Not a perfect change detector in
/// theory (a same-size write inside one filesystem timestamp tick), but the
/// files under `attachments/` are content-addressed and never edited in place,
/// so in practice a changed file is a NEW path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashEntry {
    pub size: u64,
    pub mtime_ns: i64,
    pub sha256: String,
}

/// What one `attachments/` walk produced.
pub struct AttachmentListing {
    /// The listing itself, sorted by path.
    pub items: Vec<AttachmentMeta>,
    /// The cache as it should now be persisted: exactly the files that exist,
    /// so writing it back is also the prune.
    pub cache: HashMap<String, HashEntry>,
    /// How many files actually had to be read+hashed this pass (0 = all cached).
    pub hashed: usize,
    /// Whether `cache` differs from what was passed in (nothing to write if not).
    pub changed: bool,
}

/// List every file under the vault's `attachments/` dir (recursively), skipping
/// dotfiles/dotfolders. Returns an empty list if the dir is absent.
///
/// Uncached: hashes every file. Kept for callers (and tests) that have no index
/// to cache into — {@link list_attachments_cached} is what the sync path uses.
pub fn list_attachments(vault: &Path) -> AppResult<Vec<AttachmentMeta>> {
    Ok(list_attachments_cached(vault, &HashMap::new())?.items)
}

/// The same walk, but reusing a previously-computed sha256 whenever the file's
/// `(size, mtime)` is unchanged.
///
/// This is the difference between an attachment reconcile that costs a `stat`
/// per file and one that re-reads every byte in `attachments/` — which the
/// watcher can fire every few seconds, and which on a vault holding a few
/// hundred megabytes of images and video is seconds of disk I/O for an answer
/// that never changes. Files that DO need hashing are streamed
/// (`notefile::sha256_file`), so a 500 MB video costs a 64 KB buffer rather
/// than a 500 MB allocation.
pub fn list_attachments_cached(
    vault: &Path,
    cached: &HashMap<String, HashEntry>,
) -> AppResult<AttachmentListing> {
    let root = vault.join(ATTACHMENTS_DIR);
    let mut found: Vec<(String, PathBuf, u64, i64)> = Vec::new();
    if root.is_dir() {
        walk(vault, &root, &|_| true, &mut found)?;
    }
    hash_listing(found, cached)
}

/// The vault-root store for content-addressed attachments (editor drops).
/// Mirrors `vault.rs`'s own constant and `stats.rs ATTACHMENTS_DIR`.
pub const ATTACHMENTS_DIR: &str = "attachments";
/// The same, as a path prefix — compared per file, so it is a constant rather
/// than a `format!` per candidate.
const ATTACHMENTS_PREFIX: &str = "attachments/";

/// Does the binary sync mirror this vault-relative path?
///
/// Two sets, deliberately: everything under the root `attachments/` store (its
/// files are content-addressed and hidden, and the names are ours, so the
/// extension is not a question anyone asked), plus every TREE binary — a
/// surfaced, non-note extension anywhere else in the vault. `.context/`,
/// `.git`, dotfiles and `DENIED_DIRS` are out of both, and notes are out of the
/// second: they ride the CRDT bridge, not the blob store.
pub fn is_syncable_binary(rel: &str) -> bool {
    if rel.is_empty() || rel_path_is_ignored(rel) {
        return false;
    }
    if rel.starts_with(ATTACHMENTS_PREFIX) {
        return true;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    is_allowed_file(name) && !is_note_file(name)
}

/// The same listing over the WHOLE vault: `attachments/` plus every tree binary
/// (see {@link is_syncable_binary}).
///
/// A strict superset of {@link list_attachments_cached}, which is why the two
/// share one hash cache: the binary walk re-states every attachment entry, so
/// writing its cache back prunes nothing the attachment walk still wants. (The
/// reverse is not true — an `attachments/`-only walk would prune the tree
/// entries — which is why `list_attachments` has no caller left in the sync
/// path.)
pub fn list_binaries_cached(
    vault: &Path,
    cached: &HashMap<String, HashEntry>,
) -> AppResult<AttachmentListing> {
    let mut found: Vec<(String, PathBuf, u64, i64)> = Vec::new();
    if vault.is_dir() {
        walk(vault, vault, &is_syncable_binary, &mut found)?;
    }
    hash_listing(found, cached)
}

/// Every syncable binary in the vault, hashed. The uncached twin of
/// {@link list_binaries_cached}, for callers and tests with no index.
pub fn list_binaries(vault: &Path) -> AppResult<Vec<AttachmentMeta>> {
    Ok(list_binaries_cached(vault, &HashMap::new())?.items)
}

/// Hash what a walk found, reusing a cached sha wherever `(size, mtime)` says
/// the bytes cannot have moved. Shared by both walks — the only difference
/// between them is which files reach here.
fn hash_listing(
    mut found: Vec<(String, PathBuf, u64, i64)>,
    cached: &HashMap<String, HashEntry>,
) -> AppResult<AttachmentListing> {
    // Deterministic order (stable diffs, stable tests).
    found.sort_by(|a, b| a.0.cmp(&b.0));

    let mut items = Vec::with_capacity(found.len());
    let mut cache: HashMap<String, HashEntry> = HashMap::with_capacity(found.len());
    let mut hashed = 0usize;
    for (rel, abs, size, mtime_ns) in found {
        let hit = cached
            .get(&rel)
            .filter(|e| e.size == size && e.mtime_ns == mtime_ns)
            .map(|e| e.sha256.clone());
        let sha = match hit {
            Some(sha) => sha,
            None => {
                hashed += 1;
                sha256_file(&abs)?
            }
        };
        cache.insert(
            rel.clone(),
            HashEntry { size, mtime_ns, sha256: sha.clone() },
        );
        items.push(AttachmentMeta { rel_path: rel, size, sha256: sha });
    }
    // A prune is just "the new map has fewer/other keys", so one comparison
    // covers both a vanished file and a re-hashed one.
    let changed = cache != *cached;
    Ok(AttachmentListing { items, cache, hashed, changed })
}

/// Collect `(rel_path, abs, size, mtime_ns)` for every non-ignored file under
/// `dir` that `keep` accepts. Deliberately reads no contents — hashing is the
/// caller's decision, because the cache may already know the answer.
///
/// `keep` is asked about the vault-relative PATH, not the name: "is this under
/// `attachments/`" is the one question the whole-vault walk cannot answer from
/// a file name alone.
fn walk(
    vault: &Path,
    dir: &Path,
    keep: &dyn Fn(&str) -> bool,
    out: &mut Vec<(String, PathBuf, u64, i64)>,
) -> AppResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue; // skip dotfiles / .context / .git / node_modules and our .*.tmp writes
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk(vault, &path, keep, out)?;
        } else if file_type.is_file() {
            let rel = rel_from(vault, &path);
            if !keep(&rel) {
                continue;
            }
            let meta = entry.metadata()?;
            out.push((rel, path, meta.len(), mtime_ns(&meta)));
        }
    }
    Ok(())
}

/// A file's mtime in nanoseconds since the Unix epoch, or 0 when the OS won't
/// say. Nanoseconds (not the millis `file_stat` reports) because this is a
/// change DETECTOR: a rewrite inside the same millisecond is exactly the case
/// a coarser stamp misses.
fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

/// Vault-relative forward-slash path of `abs` under `root`.
fn rel_from(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

// ---- Transport: bytes move through Rust, not the webview -------------------
//
// The webview can PUT to a presigned URL, but every part of doing so is worse:
// the bucket then needs CORS for a `tauri://localhost` Origin, the CSP's
// `connect-src` has to permit whatever plain-http MinIO a self-hoster runs, and
// a 500 MB video has to exist in the JS heap first. These two commands stream
// straight from/to disk instead. `lib/api.ts` keeps a webview fallback for the
// cases where an invoke is not available.
//
// AUTH IS THE CALLER'S BUSINESS, deliberately. Upload URLs carry their own
// credential — an S3 signature, or our own route's `?t=` upload token — and S3
// REJECTS a request that presents both a presign and an `Authorization` header,
// so nothing here adds one. The only headers sent are the ones passed in.

/// How long a connection gets to be established before we give up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on ONE transfer. Generous because the whole point is large files on
/// slow links (500 MB over a hotel wifi is not a pathology), but bounded: a
/// stalled socket must not hold a reconcile open forever.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Cap on how much of a failed response we quote back to the TS layer.
const ERROR_BODY_MAX: usize = 2048;

/// Truncate to at most `max` BYTES, backing up to the nearest char boundary.
///
/// `String::truncate` panics when the index splits a multibyte char, and the
/// only caller is an error path — an S3/MinIO XML fault naming a non-ASCII key,
/// or a proxy's localized HTML — so the crash would arrive exactly when the
/// transport was already failing. (`str::floor_char_boundary` is still
/// unstable, hence the hand-rolled walk.)
fn truncate_at_char_boundary(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
}

/// One shared client, built once.
///
/// `redirect(none)` is a SECURITY setting, not a preference: reqwest forwards
/// `Authorization` across a redirect, and `GET /api/blobs/:id` answers 302 to a
/// presigned S3 URL — which rejects a request carrying both a signature and a
/// bearer. The desktop therefore asks `GET /api/blobs/:id/url` for the target
/// and fetches THAT; a 3xx arriving here is a bug or a hostile server, and is
/// surfaced as the status rather than followed.
///
/// The crypto provider is INSTALLED here, not left to a crate feature: reqwest
/// is built with `rustls-no-provider` (matching what `tauri-plugin-updater`
/// already turns on, so there is one copy of reqwest), and rustls 0.23 wants a
/// process-default provider before ANY `ClientConfig` exists — without one,
/// `build()` panics from inside rather than returning an error, which is how a
/// dropped PDF turned into "No rustls crypto provider is configured" the first
/// time the transport ran. It lives next to the client rather than in `lib.rs`
/// setup for two reasons: this transport is the only consumer, so a `setup`
/// hook would be action-at-a-distance for a panic that happens here; and the
/// updater installs its own provider on its own path, so there is no single
/// startup point that owns the choice. `install_default` returns `Err` when one
/// is ALREADY installed (the updater got there first, or a second `Lazy` init
/// raced) — that is the success case too, so the result is deliberately
/// ignored. `ring` is the same backend hyper-rustls already compiles in.
///
/// The build error is mapped rather than unwrapped so a future misconfiguration
/// surfaces as a command error instead of killing the invoke.
static HTTP: Lazy<Result<reqwest::Client, String>> = Lazy::new(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TRANSFER_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
});

fn client() -> AppResult<reqwest::Client> {
    match HTTP.as_ref() {
        Ok(c) => Ok(c.clone()),
        Err(e) => Err(AppError::new(format!("HTTP client unavailable: {e}"))),
    }
}

/// Half-open byte range `[start, end)` of the file to send — one multipart part.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// What an upload PUT answered. The STATUS is returned rather than turned into
/// an error because the TS flow branches on it (an expired presign is a 403 to
/// re-mint, a 409 is "retry the PUT", a 5xx is "next pass").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    pub status: u16,
    /// S3's part receipt; `complete` replays it back. Absent on our own route.
    pub etag: Option<String>,
    /// A truncated body, only when the status was not 2xx.
    pub error: Option<String>,
}

/// What a download wrote. `bytes` is what landed on disk; `sha256` is what it
/// hashes to, already checked against the expected value when one was given.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub status: u16,
    pub bytes: u64,
    pub sha256: String,
}

/// Turn a plain string map into request headers, refusing anything malformed
/// rather than silently dropping it — a presign that loses its `content-length`
/// fails in a much more confusing place.
fn header_map(headers: &HashMap<String, String>) -> AppResult<reqwest::header::HeaderMap> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut out = HeaderMap::with_capacity(headers.len());
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| AppError::new(format!("invalid header name: {k}")))?;
        let value = HeaderValue::from_str(v)
            .map_err(|_| AppError::new(format!("invalid value for header {k}")))?;
        out.insert(name, value);
    }
    Ok(out)
}

fn method_of(method: &str) -> AppResult<reqwest::Method> {
    reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| AppError::new(format!("invalid HTTP method: {method}")))
}

/// Stream a vault file (or one byte range of it) to `url`.
///
/// READ scope is the whole vault, like `read_binary_file` — the sync layer only
/// ever passes `attachments/…`, but an imported binary living in a note folder
/// is a legitimate upload source. `resolve_in_vault` is still what bounds it.
///
/// The body is a `ReaderStream`, so the file is read in chunks as the socket
/// drains. `content-length` comes from the caller's headers (the presign SIGNS
/// it), which is also what keeps hyper from falling back to chunked encoding —
/// S3 rejects a chunked presigned PUT.
pub async fn upload_file(
    vault: &Path,
    rel: &str,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    range: Option<ByteRange>,
) -> AppResult<UploadOutcome> {
    let abs = resolve_in_vault(vault, rel)?;
    let meta = std::fs::metadata(&abs)?;
    if !meta.is_file() {
        return Err(AppError::new("not a file"));
    }
    let (start, len) = match range {
        Some(r) => {
            if r.end < r.start || r.end > meta.len() {
                return Err(AppError::new(format!(
                    "range {}..{} is outside {rel} ({} bytes)",
                    r.start,
                    r.end,
                    meta.len()
                )));
            }
            (r.start, r.end - r.start)
        }
        None => (0, meta.len()),
    };

    let mut file = tokio::fs::File::open(&abs).await?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await?;
    }
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file.take(len)));

    let mut req = client()?
        .request(method_of(method)?, url)
        .headers(header_map(headers)?)
        .body(body);
    // Belt and braces: if the server's presign did not name a length, supply
    // the one we are actually sending so the request never goes out chunked.
    if !headers.keys().any(|k| k.eq_ignore_ascii_case("content-length")) {
        req = req.header(reqwest::header::CONTENT_LENGTH, len);
    }

    let res = req
        .send()
        .await
        .map_err(|e| AppError::new(format!("upload failed: {e}")))?;
    let status = res.status().as_u16();
    let etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let error = if (200..300).contains(&status) {
        None
    } else {
        let mut body = res.text().await.unwrap_or_default();
        truncate_at_char_boundary(&mut body, ERROR_BODY_MAX);
        Some(body)
    };
    Ok(UploadOutcome { status, etag, error })
}

/// Stream `url` into a vault-relative binary path, atomically.
///
/// WRITE scope is one of the two guards, never `resolve_in_vault` alone: the
/// path comes from the SERVER, so a member who set a blob's `rel_path` to
/// `.context/…` or to a note must not be able to make every teammate's client
/// overwrite it. `tree: false` is the `attachments/` store
/// (`ensure_attachment_rel`); `tree: true` is a binary that lives in the tree
/// (`ensure_tree_binary_rel`) — a surfaced non-note extension outside the
/// ignored dirs, and nothing else.
///
/// Bytes land in `.<name>.tmp` beside the target and are hashed as they are
/// written; the rename only happens once the digest matches `expected_sha256`.
/// A mismatch (or any non-2xx) deletes the temp file and fails — half a file
/// under the real name would look like a valid attachment to the next diff.
pub async fn download_file(
    vault: &Path,
    rel: &str,
    url: &str,
    headers: &HashMap<String, String>,
    expected_sha256: Option<&str>,
    tree: bool,
) -> AppResult<DownloadOutcome> {
    if tree {
        ensure_tree_binary_rel(rel)?;
    } else {
        ensure_attachment_rel(rel)?;
    }
    let abs = resolve_in_vault(vault, rel)?;
    require_vault_root(vault)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("attachment has no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let file_name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    // Unique per call, never one shared `.{name}.tmp`: two writers of the same
    // path would otherwise interleave into it (see `notefile::temp_sibling`).
    let tmp = crate::notefile::temp_sibling(parent, file_name);

    let mut res = client()?
        .get(url)
        .headers(header_map(headers)?)
        .send()
        .await
        .map_err(|e| AppError::new(format!("download failed: {e}")))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let mut body = res.text().await.unwrap_or_default();
        truncate_at_char_boundary(&mut body, ERROR_BODY_MAX);
        // A 3xx lands here too: see `HTTP`'s redirect policy for why we refuse
        // to follow one rather than leak the bearer to a presigned host.
        return Err(AppError::new(format!("download failed: HTTP {status} {body}")));
    }

    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let outcome: AppResult<()> = async {
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| AppError::new(format!("download failed: {e}")))?
        {
            hasher.update(&chunk);
            written += chunk.len() as u64;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = outcome {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    let digest = hasher.finalize();
    let mut sha256 = String::with_capacity(64);
    for b in digest {
        sha256.push_str(&format!("{b:02x}"));
    }
    if let Some(expected) = expected_sha256 {
        if !expected.is_empty() && !expected.eq_ignore_ascii_case(&sha256) {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::new(format!(
                "downloaded bytes hash to {sha256}, expected {expected}"
            )));
        }
    }
    std::fs::rename(&tmp, &abs)?;
    Ok(DownloadOutcome { status, bytes: written, sha256 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run one future to completion. A hand-rolled `#[tokio::test]`, so the
    /// test build does not pull a proc-macro crate for two async cases.
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn write_read_roundtrip_is_byte_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x42];
        write_binary_file(tmp.path(), "attachments/logo.png", &bytes).unwrap();
        let got = read_binary_file(tmp.path(), "attachments/logo.png").unwrap();
        assert_eq!(got, bytes);
        // No leftover temp file.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path().join("attachments"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_creates_nested_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/sub/deep/file.bin", &[1, 2, 3]).unwrap();
        assert!(tmp.path().join("attachments/sub/deep/file.bin").is_file());
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_binary_file(tmp.path(), "../escape.bin", &[1]).is_err());
        assert!(read_binary_file(tmp.path(), "../../etc/passwd").is_err());
        assert!(write_binary_file(tmp.path(), "attachments/../../x.bin", &[1]).is_err());
    }

    #[test]
    fn write_confined_to_attachments_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        // A server-supplied rel_path targeting a note or the hidden .context
        // store must be refused even though it does not escape the vault.
        assert!(write_binary_file(tmp.path(), ".context/index.sqlite", &[1]).is_err());
        assert!(write_binary_file(tmp.path(), "Team Plans.md", &[1]).is_err());
        assert!(write_binary_file(tmp.path(), "attachments/.context/x", &[1]).is_err());
        assert!(write_binary_file(tmp.path(), "attachments/.hidden", &[1]).is_err());
        assert!(write_binary_file(tmp.path(), "attachments", &[1]).is_err());
        // Legitimate attachment paths still work.
        assert!(write_binary_file(tmp.path(), "attachments/ok.png", &[1]).is_ok());
        assert!(write_binary_file(tmp.path(), "attachments/sub/ok.pdf", &[1]).is_ok());
    }

    #[test]
    fn rejects_absolute_paths() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_binary_file(tmp.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn file_stat_reports_size_and_refuses_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/clip.mp4", &[7u8; 2048]).unwrap();
        let stat = file_stat(tmp.path(), "attachments/clip.mp4").unwrap();
        assert_eq!(stat.size, 2048);
        assert!(stat.modified.unwrap_or(0) > 0);

        // Same path rules as every other disk read: no traversal, no absolute
        // path, and a directory is not a file.
        assert!(file_stat(tmp.path(), "../../etc/passwd").is_err());
        assert!(file_stat(tmp.path(), "/etc/passwd").is_err());
        assert!(file_stat(tmp.path(), "attachments").is_err());
        assert!(file_stat(tmp.path(), "attachments/missing.png").is_err());
    }

    /// Walk once, then walk again with the cache the first walk produced —
    /// with a DELIBERATELY WRONG sha in it. Getting the wrong sha back proves
    /// the second walk trusted the cache instead of re-reading the file.
    #[test]
    fn cached_hash_is_reused_when_size_and_mtime_match() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1, 2, 3]).unwrap();

        let first = list_attachments_cached(tmp.path(), &HashMap::new()).unwrap();
        assert_eq!(first.hashed, 1);
        assert!(first.changed);

        let mut poisoned = first.cache.clone();
        poisoned.get_mut("attachments/a.png").unwrap().sha256 = "cafebabe".into();
        let second = list_attachments_cached(tmp.path(), &poisoned).unwrap();
        assert_eq!(second.hashed, 0, "unchanged file must not be re-hashed");
        assert_eq!(second.items[0].sha256, "cafebabe");

        // A clean second pass agrees with the first and has nothing to write.
        let third = list_attachments_cached(tmp.path(), &first.cache).unwrap();
        assert_eq!(third.hashed, 0);
        assert!(!third.changed);
        assert_eq!(third.items[0].sha256, first.items[0].sha256);
    }

    #[test]
    fn a_changed_file_is_re_hashed() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1, 2, 3]).unwrap();
        let first = list_attachments_cached(tmp.path(), &HashMap::new()).unwrap();

        // Same path, different bytes AND a different mtime — the pair is the
        // validity key, and a rewrite moves both.
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_binary_file(tmp.path(), "attachments/a.png", &[9, 9, 9, 9]).unwrap();
        let second = list_attachments_cached(tmp.path(), &first.cache).unwrap();
        assert_eq!(second.hashed, 1);
        assert!(second.changed);
        assert_eq!(second.items[0].sha256, sha256_bytes(&[9, 9, 9, 9]));
    }

    #[test]
    fn cache_prunes_paths_that_vanished() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1]).unwrap();
        write_binary_file(tmp.path(), "attachments/b.pdf", &[2]).unwrap();
        let first = list_attachments_cached(tmp.path(), &HashMap::new()).unwrap();
        assert_eq!(first.cache.len(), 2);

        std::fs::remove_file(tmp.path().join("attachments/b.pdf")).unwrap();
        let second = list_attachments_cached(tmp.path(), &first.cache).unwrap();
        assert!(second.changed);
        assert_eq!(second.items.len(), 1);
        // The map handed back IS the new cache, so writing it back is the prune.
        assert!(!second.cache.contains_key("attachments/b.pdf"));
        assert!(second.cache.contains_key("attachments/a.png"));
    }

    /// The hash cache round-trips through the index the way the command uses
    /// it: read → walk → write back, with the write doubling as the prune.
    #[test]
    fn index_round_trips_and_prunes_the_hash_cache() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1]).unwrap();
        write_binary_file(tmp.path(), "attachments/b.pdf", &[2]).unwrap();
        let index = crate::index::Index::open_in_memory().unwrap();
        assert!(index.attachment_hash_cache().unwrap().is_empty());

        let first = list_attachments_cached(tmp.path(), &HashMap::new()).unwrap();
        index.save_attachment_hash_cache(&first.cache).unwrap();
        let stored = index.attachment_hash_cache().unwrap();
        assert_eq!(stored, first.cache);

        std::fs::remove_file(tmp.path().join("attachments/b.pdf")).unwrap();
        let second = list_attachments_cached(tmp.path(), &stored).unwrap();
        assert_eq!(second.hashed, 0, "the surviving file was already cached");
        index.save_attachment_hash_cache(&second.cache).unwrap();
        let after = index.attachment_hash_cache().unwrap();
        assert_eq!(after.len(), 1);
        assert!(!after.contains_key("attachments/b.pdf"));
    }

    /// The download side is the one that takes a SERVER-supplied path, so it
    /// refuses anything outside `attachments/` before it opens a socket.
    #[test]
    fn download_refuses_paths_outside_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let headers = HashMap::new();
        for rel in [
            ".context/index.sqlite",
            "Team Plans.md",
            "attachments/../escape.bin",
            "attachments/.hidden",
            "attachments",
        ] {
            let err = block_on(download_file(
                tmp.path(),
                rel,
                "http://127.0.0.1:9/never-reached",
                &headers,
                None,
                false,
            ));
            assert!(err.is_err(), "{rel} must be refused");
        }
        // Nothing was created on the way to those refusals.
        assert!(!tmp.path().join("attachments").exists());
    }

    /// The tree-scoped download takes a server path too, and its accepted set
    /// is exactly `write_tree_binary`'s — notes and the hidden store included in
    /// what it refuses.
    #[test]
    fn tree_download_refuses_everything_write_tree_binary_refuses() {
        let tmp = tempfile::tempdir().unwrap();
        let headers = HashMap::new();
        for rel in [
            ".context/index.sqlite",
            "Team/Plans.md",
            "Team/../../escape.png",
            "Team/.hidden/x.png",
            "node_modules/pkg/logo.png",
            "Team/Makefile",
        ] {
            let err = block_on(download_file(
                tmp.path(),
                rel,
                "http://127.0.0.1:9/never-reached",
                &headers,
                None,
                true,
            ));
            assert!(err.is_err(), "{rel} must be refused");
        }
    }

    /// `write_tree_binary` is the materialize guard: a surfaced non-note
    /// extension anywhere the walk would have found it, and nothing else.
    #[test]
    fn write_tree_binary_accepts_only_tree_binaries() {
        let tmp = tempfile::tempdir().unwrap();
        for rel in ["Team/report.docx", "Media/clip.mp4", "attachments/x.png", "top.csv"] {
            write_tree_binary(tmp.path(), rel, &[1, 2, 3]).unwrap_or_else(|e| panic!("{rel}: {e:?}"));
            assert!(tmp.path().join(rel).is_file());
        }
        for rel in [
            "Notes/Plan.md",          // a note: the CRDT pipeline owns it
            "Notes/page.html",        // ditto (NOTE_EXTS is wider than markdown)
            ".context/config.json",   // the hidden store, never writable
            "../escape.png",          // traversal
            "/etc/evil.png",          // absolute
            "Team/.hidden/x.png",     // dotfile segment
            "node_modules/a/logo.png",// a denied dir
            "Notes/script.js",        // not a surfaced extension
            "Notes/x.txt",            // a note extension, despite looking inert
        ] {
            assert!(
                write_tree_binary(tmp.path(), rel, &[1]).is_err(),
                "{rel} must be refused"
            );
        }
    }

    /// The whole-vault walk: every tree binary plus the `attachments/` store,
    /// and nothing the tree walk itself ignores.
    #[test]
    fn binary_walk_covers_the_tree_and_skips_notes_and_ignored_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let write = |rel: &str| {
            let abs = tmp.path().join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, rel.as_bytes()).unwrap();
        };
        write("Team/report.docx");
        write("Team/Notes.md");
        write("Media/clip.mp4");
        write("attachments/abc123.png");
        write("attachments/no-extension");
        write(".context/index.sqlite");
        write(".hidden/secret.png");
        write("node_modules/pkg/logo.png");
        write("Team/script.js");
        write("Team/notes.txt");

        let items = list_binaries(tmp.path()).unwrap();
        let paths: Vec<_> = items.iter().map(|i| i.rel_path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "Media/clip.mp4",
                "Team/report.docx",
                // The store is listed whatever the file is called — its names
                // are ours, and an extension-less blob still has to sync.
                "attachments/abc123.png",
                "attachments/no-extension",
            ]
        );
        // Every entry carries a real hash (the diff is keyed by it).
        assert!(items.iter().all(|i| i.sha256.len() == 64));
    }

    /// The binary walk is a superset of the attachment walk, which is what lets
    /// the two share one hash cache.
    #[test]
    fn binary_walk_is_a_superset_of_the_attachment_walk() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1, 2, 3]).unwrap();
        write_tree_binary(tmp.path(), "Team/report.docx", &[4, 5]).unwrap();
        let attachments = list_attachments(tmp.path()).unwrap();
        let binaries = list_binaries(tmp.path()).unwrap();
        for a in &attachments {
            assert!(
                binaries.iter().any(|b| b.rel_path == a.rel_path && b.sha256 == a.sha256),
                "{} missing from the binary walk",
                a.rel_path
            );
        }
        assert_eq!(binaries.len(), attachments.len() + 1);
    }

    /// A part upload names a byte range; one outside the file is a bug in the
    /// caller's arithmetic, not something to send a truncated part for.
    #[test]
    fn upload_refuses_a_range_past_the_end_of_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/clip.mp4", &[7u8; 64]).unwrap();
        let headers = HashMap::new();
        let err = block_on(upload_file(
            tmp.path(),
            "attachments/clip.mp4",
            "http://127.0.0.1:9/never-reached",
            "PUT",
            &headers,
            Some(ByteRange { start: 0, end: 65 }),
        ));
        assert!(err.is_err());
        // An escaping read path is refused by `resolve_in_vault` just the same.
        assert!(block_on(upload_file(
            tmp.path(),
            "../../etc/passwd",
            "http://127.0.0.1:9/never-reached",
            "PUT",
            &headers,
            None,
        ))
        .is_err());
    }

    /// The client is built lazily on the FIRST transfer, and with
    /// `rustls-no-provider` that build panics unless a crypto provider was
    /// installed as the process default — which is exactly what shipped: every
    /// unit test stopped short of building a client, so a dropped PDF was the
    /// first thing to find out. Constructing it here is the regression test.
    #[test]
    fn http_client_builds_with_a_crypto_provider() {
        let c = client().expect("shared HTTP client must build");
        // A second call takes the same `Lazy`, and installing the provider
        // again must not turn into an error either.
        let _ = client().expect("shared HTTP client must stay available");
        // Building a request off it exercises the TLS config the panic came
        // from, without opening a socket.
        assert!(c
            .get("https://example.invalid/never-fetched")
            .build()
            .is_ok());
    }

    /// The error path quotes a failed response back to TS, and a body whose
    /// 2048th byte lands mid-character used to panic `String::truncate`.
    #[test]
    fn error_body_truncation_survives_multibyte_characters() {
        // 1000 × 3 bytes = 3000 bytes, and NO char boundary at 2048 (2048 is
        // not a multiple of 3), which is the case that panicked.
        let mut body = "字".repeat(1000);
        assert_eq!(body.len(), 3000);
        truncate_at_char_boundary(&mut body, ERROR_BODY_MAX);
        assert!(body.len() <= ERROR_BODY_MAX);
        assert_eq!(body.len(), 2046, "backs up to the nearest char boundary");
        assert!(body.chars().all(|c| c == '字'));

        // Shorter than the cap, exactly on it, and empty are all no-ops.
        let mut short = "ok".to_string();
        truncate_at_char_boundary(&mut short, ERROR_BODY_MAX);
        assert_eq!(short, "ok");
        let mut exact = "a".repeat(ERROR_BODY_MAX);
        truncate_at_char_boundary(&mut exact, ERROR_BODY_MAX);
        assert_eq!(exact.len(), ERROR_BODY_MAX);
        // A single char wider than the cap truncates to nothing rather than
        // splitting it.
        let mut wide = "😀".to_string();
        truncate_at_char_boundary(&mut wide, 2);
        assert_eq!(wide, "");
    }

    #[test]
    fn list_is_empty_without_attachments_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_attachments(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn lists_files_recursively_and_skips_dotfiles() {
        let tmp = tempfile::tempdir().unwrap();
        write_binary_file(tmp.path(), "attachments/a.png", &[1, 2, 3]).unwrap();
        write_binary_file(tmp.path(), "attachments/sub/b.pdf", &[4, 5]).unwrap();
        // A dotfile should be skipped.
        std::fs::write(tmp.path().join("attachments/.DS_Store"), b"junk").unwrap();

        let list = list_attachments(tmp.path()).unwrap();
        let paths: Vec<_> = list.iter().map(|a| a.rel_path.clone()).collect();
        assert_eq!(paths, vec!["attachments/a.png", "attachments/sub/b.pdf"]);

        let a = list.iter().find(|m| m.rel_path == "attachments/a.png").unwrap();
        assert_eq!(a.size, 3);
        assert_eq!(a.sha256, sha256_bytes(&[1, 2, 3]));
    }
}
