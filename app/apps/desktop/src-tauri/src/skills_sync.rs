// SPDX-License-Identifier: Apache-2.0
//! Team AI skills on this machine (`docs/SKILLS.md` §4). Rust resolves the two
//! target roots itself — `<claude config dir>/skills` and `~/.agents/skills` —
//! and only ever writes folders that carry our `.baalda-managed.json` marker.
//! A folder without one belongs to the user and is never touched; a managed
//! folder the user edited is left alone until "Use team version" (backup first).
//! Installs stage in a sibling folder, verify every hash, then swap by rename.

use crate::agent_runner::trusted_window;
use crate::attachments::sha256_bytes;
use crate::error::{AppError, AppResult};
use crate::notefile::write_atomic_fsync;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, Webview};
use walkdir::WalkDir;

const MARKER: &str = ".baalda-managed.json";
const STAGING_PREFIX: &str = ".baalda-staging-";
const OLD_PREFIX: &str = ".baalda-old-";
const LEFTOVER_AGE: Duration = Duration::from_secs(60 * 60);
/// OS and tool droppings that are not a local edit: Finder and Explorer write
/// the first two by browsing, Python the third by running a skill's script.
const DRIFT_JUNK: [&str; 3] = [".DS_Store", "Thumbs.db", "__pycache__"];

// §1.3 caps — the server enforces them too; these keep a bad payload off disk.
const MAX_FILES: usize = 1000;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 25 * 1024 * 1024;
const MAX_MARKER_BYTES: u64 = 1_048_576;
/// A zip's central directory can list far more entries than a skill may hold
/// (skipped `node_modules` included); past this it is not a skill upload.
const MAX_ZIP_ENTRIES: usize = 20_000;

const WINDOWS_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
/// Folder names an upload leaves out (§4.5), beside every dot-name.
const SKIP_DIRS: [&str; 8] = [
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    "__MACOSX",
];

/// Installs and removals of one name must not interleave; the UI runs one
/// sync at a time, this makes that a guarantee rather than a habit.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillTarget {
    Claude,
    Agents,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFilePayload {
    pub path: String,
    pub content_base64: String,
    pub sha256: String,
    pub executable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarker {
    pub skill_id: String,
    pub org_id: String,
    pub server_url: String,
    /// The signed-in user who installed this copy. `None` only in markers
    /// written before the field existed; those count as this user's.
    #[serde(default)]
    pub user_id: Option<String>,
    pub name: String,
    pub version: u32,
    pub bundle_sha256: String,
    /// relPath → sha256.
    pub files: BTreeMap<String, String>,
    /// RFC3339; the webview may omit it, Rust always sets it on install.
    #[serde(default)]
    pub installed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOwner {
    pub skill_id: String,
    pub org_id: String,
    pub server_url: String,
    pub user_id: String,
}

/// `skills_remove`'s `mode`: `Release` drops only the marker, handing the
/// folder to the user as their own unmanaged skill.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoveMode {
    #[default]
    Delete,
    Release,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub target: SkillTarget,
    pub root: String,
    pub root_exists: bool,
    pub tool_installed: bool,
    pub detected_tools: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstalledStatus {
    Managed,
    Edited,
    Unmanaged,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    pub status: InstalledStatus,
    pub marker: Option<SkillMarker>,
    pub edited_files: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallStatus {
    Installed,
    Unchanged,
    Conflict,
    Edited,
    /// An unmanaged folder already held exactly these files: only the marker was written.
    Adopted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub status: InstallStatus,
    pub backup_path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoveStatus {
    Removed,
    Released,
    NotFound,
    Conflict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub status: RemoveStatus,
    pub backup_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundle {
    pub suggested_name: String,
    pub files: Vec<SkillFilePayload>,
    pub skipped: Vec<String>,
}

// ---- Validation (§1.1, §1.2) ----------------------------------------------

fn is_reserved_stem(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    WINDOWS_RESERVED.contains(&stem.as_str())
}

/// §1.1: `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64, not a Windows device name.
pub fn validate_name(name: &str) -> AppResult<()> {
    let shape_ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if shape_ok && !WINDOWS_RESERVED.contains(&name) {
        Ok(())
    } else {
        Err(AppError::new(format!("invalid skill name: {name}")))
    }
}

/// §1.2. `Err` carries the reason a person reads in the upload's skipped list.
pub fn validate_rel_path(path: &str) -> Result<(), &'static str> {
    let len = path.chars().count();
    if len == 0 || len > 240 {
        return Err("path must be 1–240 characters");
    }
    if path.starts_with('/') {
        return Err("absolute path");
    }
    if path.contains('\\') {
        return Err("backslash in path");
    }
    for component in path.split('/') {
        let n = component.chars().count();
        if n == 0 {
            return Err("empty path component");
        }
        if n > 100 {
            return Err("path component over 100 characters");
        }
        if component == "." || component == ".." {
            return Err("relative path component");
        }
        if component.starts_with('.') {
            return Err("hidden file or folder");
        }
        if component
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err("character not allowed on every system");
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err("name ends in a dot or space");
        }
        if is_reserved_stem(component) {
            return Err("reserved Windows device name");
        }
    }
    Ok(())
}

/// A payload whose path, caps and sha256 have all been checked.
#[derive(Debug)]
struct Decoded {
    rel: String,
    bytes: Vec<u8>,
    sha: String,
    executable: bool,
}

fn too_large(path: &str) -> AppError {
    AppError::new(format!("file too large: {path} (max 5 MiB)"))
}

/// Decode and verify webview payloads; nothing reaches the disk unless every
/// one of them passes (§4.4 step 1).
fn decode_payloads(files: &[SkillFilePayload]) -> AppResult<Vec<Decoded>> {
    if files.len() > MAX_FILES {
        return Err(AppError::new(format!("too many files (max {MAX_FILES})")));
    }
    let mut seen = HashSet::new();
    let mut total = 0usize;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        validate_rel_path(&f.path)
            .map_err(|r| AppError::new(format!("invalid skill path: {} ({r})", f.path)))?;
        if !seen.insert(f.path.to_lowercase()) {
            return Err(AppError::new(format!("duplicate skill path: {}", f.path)));
        }
        // Refuse an oversized string before decoding it into memory.
        if f.content_base64.len() / 4 * 3 > MAX_FILE_BYTES + 3 {
            return Err(too_large(&f.path));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(f.content_base64.as_bytes())
            .map_err(|_| AppError::new(format!("invalid base64: {}", f.path)))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(too_large(&f.path));
        }
        total += bytes.len();
        if total > MAX_TOTAL_BYTES {
            return Err(AppError::new("skill too large (max 25 MiB)"));
        }
        let sha = sha256_bytes(&bytes);
        if sha != f.sha256 {
            return Err(AppError::new(format!("sha mismatch: {}", f.path)));
        }
        out.push(Decoded {
            rel: f.path.clone(),
            bytes,
            sha,
            executable: f.executable,
        });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

// ---- Target roots (§4.1) ----------------------------------------------------

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn home_or_err() -> AppResult<PathBuf> {
    home().ok_or_else(|| AppError::new("Couldn't locate the home folder"))
}

/// An env override counts only when set, non-empty and absolute.
fn absolute_env(value: Option<OsString>) -> Option<PathBuf> {
    value
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn claude_config_dir(home: &Path, env_claude_config_dir: Option<OsString>) -> PathBuf {
    absolute_env(env_claude_config_dir).unwrap_or_else(|| home.join(".claude"))
}

fn target_root(
    target: SkillTarget,
    home: &Path,
    env_claude_config_dir: Option<OsString>,
) -> PathBuf {
    match target {
        SkillTarget::Claude => claude_config_dir(home, env_claude_config_dir).join("skills"),
        SkillTarget::Agents => home.join(".agents").join("skills"),
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// The root, or any existing folder between `home` and it, must not be a
/// symlink: a link would let a write land somewhere neither the UI nor the
/// user sees. A root outside home (an absolute `CLAUDE_CONFIG_DIR`) is checked
/// from the config dir down.
fn ensure_root_safe(root: &Path, home: &Path) -> AppResult<()> {
    let stop = if root.starts_with(home) {
        Some(home)
    } else {
        root.parent().and_then(Path::parent)
    };
    let mut cur = Some(root);
    while let Some(p) = cur {
        if Some(p) == stop {
            break;
        }
        if is_symlink(p) {
            return Err(AppError::new("skills root is a symlink"));
        }
        cur = p.parent();
    }
    Ok(())
}

fn checked_root(
    target: SkillTarget,
    home: &Path,
    env_claude_config_dir: Option<OsString>,
) -> AppResult<PathBuf> {
    let root = target_root(target, home, env_claude_config_dir);
    ensure_root_safe(&root, home)?;
    Ok(root)
}

fn resolve_root(target: SkillTarget) -> AppResult<PathBuf> {
    checked_root(
        target,
        &home_or_err()?,
        std::env::var_os("CLAUDE_CONFIG_DIR"),
    )
}

fn targets_info(
    home: &Path,
    env_claude_config_dir: Option<OsString>,
    env_codex_home: Option<OsString>,
) -> Vec<TargetInfo> {
    let claude_dir = claude_config_dir(home, env_claude_config_dir.clone());
    let claude_root = target_root(SkillTarget::Claude, home, env_claude_config_dir);
    let agents_root = target_root(SkillTarget::Agents, home, None);

    let codex_dir = absolute_env(env_codex_home).unwrap_or_else(|| home.join(".codex"));
    let tools: [(&str, PathBuf); 5] = [
        ("codex", codex_dir),
        ("cursor", home.join(".cursor")),
        ("gemini", home.join(".gemini")),
        ("copilot", home.join(".copilot")),
        ("opencode", home.join(".config").join("opencode")),
    ];
    let detected: Vec<String> = tools
        .iter()
        .filter(|(_, p)| p.exists())
        .map(|(t, _)| t.to_string())
        .collect();

    vec![
        TargetInfo {
            target: SkillTarget::Claude,
            root: claude_root.display().to_string(),
            root_exists: claude_root.is_dir(),
            tool_installed: claude_dir.is_dir(),
            detected_tools: Vec::new(),
        },
        TargetInfo {
            target: SkillTarget::Agents,
            root: agents_root.display().to_string(),
            root_exists: agents_root.is_dir(),
            tool_installed: !detected.is_empty(),
            detected_tools: detected,
        },
    ]
}

// ---- Disk helpers -------------------------------------------------------------

fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, c| p.join(c))
}

fn rel_string(base: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(base).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn read_marker(dir: &Path) -> Option<SkillMarker> {
    let path = dir.join(MARKER);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MARKER_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(&path).ok()?).ok()
}

/// A folder is ours only when its marker parses and names this folder.
fn managed_marker(dir: &Path, name: &str) -> Option<SkillMarker> {
    read_marker(dir).filter(|m| m.name == name)
}

/// relPaths that differ from `expected`: changed, added, missing, unreadable,
/// or anything that is not a regular file (a symlink is reported, never
/// followed). The root marker itself is not content.
fn drifted_files(dir: &Path, expected: &BTreeMap<String, String>) -> Vec<String> {
    let mut present = BTreeSet::new();
    let mut edited = BTreeSet::new();
    let mut walk = WalkDir::new(dir)
        .follow_links(false)
        .min_depth(1)
        .into_iter();
    while let Some(entry) = walk.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                edited.insert(e.path().map_or_else(|| "?".into(), |p| rel_string(dir, p)));
                continue;
            }
        };
        let ft = entry.file_type();
        if DRIFT_JUNK.iter().any(|j| entry.file_name() == *j) {
            if ft.is_dir() {
                walk.skip_current_dir();
            }
            continue;
        }
        if ft.is_dir() {
            continue;
        }
        if entry.depth() == 1 && entry.file_name() == MARKER {
            continue;
        }
        let rel = rel_string(dir, entry.path());
        present.insert(rel.clone());
        let same = ft.is_file()
            && match expected.get(&rel) {
                Some(sha) => hash_file(entry.path()).map(|h| &h == sha).unwrap_or(false),
                None => false,
            };
        if !same {
            edited.insert(rel);
        }
    }
    for rel in expected.keys() {
        if !present.contains(rel) {
            edited.insert(rel.clone());
        }
    }
    edited.into_iter().collect()
}

#[cfg(unix)]
fn set_mode(path: &Path, executable: bool) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}
#[cfg(not(unix))]
fn set_mode(_path: &Path, _executable: bool) -> AppResult<()> {
    Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// UTC (year, month, day, hour, minute, second).
fn utc_parts(at: SystemTime) -> (i64, u32, u32, u32, u32, u32) {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400) as u32;
    (y, m, d, sod / 3600, sod / 60 % 60, sod % 60)
}

fn rfc3339(at: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(at);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn backup_stamp(at: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(at);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// Copy (never move) `src` into `backups/<name>-<stamp>/`, skipping symlinks.
fn backup_dir(src: &Path, backups: &Path, name: &str, at: SystemTime) -> AppResult<PathBuf> {
    fs::create_dir_all(backups)?;
    let stamp = backup_stamp(at);
    let mut dest = backups.join(format!("{name}-{stamp}"));
    let mut n = 2;
    while fs::symlink_metadata(&dest).is_ok() {
        dest = backups.join(format!("{name}-{stamp}-{n}"));
        n += 1;
    }
    fs::create_dir(&dest)?;
    for entry in WalkDir::new(src).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| AppError::new(format!("Couldn't back up {name}: {e}")))?;
        let ft = entry.file_type();
        let to = dest.join(entry.path().strip_prefix(src).unwrap_or(entry.path()));
        if ft.is_dir() {
            fs::create_dir_all(&to)?;
        } else if ft.is_file() {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(dest)
}

fn unique_sibling(root: &Path, prefix: &str) -> PathBuf {
    root.join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()))
}

// ---- Scan -----------------------------------------------------------------------

fn is_old_leftover(entry: &fs::DirEntry, now: SystemTime) -> bool {
    entry
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| now.duration_since(m).ok())
        .is_some_and(|age| age > LEFTOVER_AGE)
}

fn scan_root(root: &Path, now: SystemTime) -> AppResult<Vec<InstalledSkill>> {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let ft = entry.file_type()?;
        if name.starts_with('.') {
            let ours = name.starts_with(STAGING_PREFIX) || name.starts_with(OLD_PREFIX);
            if ours && ft.is_dir() && is_old_leftover(&entry, now) {
                if let Err(e) = fs::remove_dir_all(entry.path()) {
                    log::warn!(
                        "[skills] couldn't remove leftover {}: {e}",
                        entry.path().display()
                    );
                }
            }
            continue;
        }
        if ft.is_symlink() {
            out.push(InstalledSkill {
                name,
                status: InstalledStatus::Unmanaged,
                marker: None,
                edited_files: Vec::new(),
            });
            continue;
        }
        if !ft.is_dir() {
            continue;
        }
        let dir = entry.path();
        let skill = match managed_marker(&dir, &name) {
            None => InstalledSkill {
                name,
                status: InstalledStatus::Unmanaged,
                marker: None,
                edited_files: Vec::new(),
            },
            Some(marker) => {
                let edited = drifted_files(&dir, &marker.files);
                InstalledSkill {
                    name,
                    status: if edited.is_empty() {
                        InstalledStatus::Managed
                    } else {
                        InstalledStatus::Edited
                    },
                    marker: Some(marker),
                    edited_files: edited,
                }
            }
        };
        out.push(skill);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---- Install / remove (§4.4) ----------------------------------------------------

/// One skill, vault, server AND user. A marker from before `userId` existed
/// matches any user (migration); a different user's copy is never touched.
fn same_owner(marker: &SkillMarker, owner: &SkillOwner) -> bool {
    marker.skill_id == owner.skill_id
        && marker.org_id == owner.org_id
        && marker.server_url == owner.server_url
        && marker.user_id.as_ref().is_none_or(|u| *u == owner.user_id)
}

fn install_outcome(status: InstallStatus, detail: Option<&str>) -> InstallOutcome {
    InstallOutcome {
        status,
        backup_path: None,
        detail: detail.map(str::to_owned),
    }
}

fn stage(staging: &Path, decoded: &[Decoded], marker: &SkillMarker) -> AppResult<()> {
    fs::create_dir(staging)?;
    for d in decoded {
        let path = join_rel(staging, &d.rel);
        write_atomic_fsync(&path, &d.bytes)?;
        set_mode(&path, d.executable)?;
    }
    // The marker goes last: a staging folder without one is never mistaken for ours.
    write_atomic_fsync(&staging.join(MARKER), &serde_json::to_vec_pretty(marker)?)?;
    let drift = drifted_files(staging, &marker.files);
    if !drift.is_empty() {
        return Err(AppError::new(format!(
            "staged skill did not verify: {}",
            drift.join(", ")
        )));
    }
    Ok(())
}

/// Swap `staging` into `dir`. The previous folder is renamed aside first and
/// renamed back if the swap fails, so `dir` is never left half-written.
fn swap_in(root: &Path, staging: &Path, dir: &Path, replace: bool) -> AppResult<()> {
    if !replace {
        return fs::rename(staging, dir).map_err(|e| {
            let _ = fs::remove_dir_all(staging);
            e.into()
        });
    }
    let old = unique_sibling(root, OLD_PREFIX);
    if let Err(e) = fs::rename(dir, &old) {
        let _ = fs::remove_dir_all(staging);
        return Err(e.into());
    }
    if let Err(e) = fs::rename(staging, dir) {
        if let Err(back) = fs::rename(&old, dir) {
            log::error!(
                "[skills] couldn't restore {} from {}: {back}",
                dir.display(),
                old.display()
            );
        }
        let _ = fs::remove_dir_all(staging);
        return Err(e.into());
    }
    if let Err(e) = fs::remove_dir_all(&old) {
        log::warn!(
            "[skills] couldn't remove the previous copy {}: {e}",
            old.display()
        );
    }
    Ok(())
}

/// The folder's files exactly as an upload would read them (`read_folder`'s
/// skip rules), relPath → sha256. `None` when it holds something an upload
/// refuses (a symlink), cannot be read, or exceeds the file cap.
fn folder_as_read(dir: &Path) -> Option<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut walk = WalkDir::new(dir)
        .follow_links(false)
        .min_depth(1)
        .into_iter();
    while let Some(entry) = walk.next() {
        let entry = entry.ok()?;
        let ft = entry.file_type();
        let name = entry.file_name().to_str()?;
        if skipped_name(name, ft.is_dir()) {
            if ft.is_dir() {
                walk.skip_current_dir();
            }
            continue;
        }
        if ft.is_symlink() {
            return None;
        }
        if !ft.is_file() {
            continue;
        }
        let rel = rel_string(dir, entry.path());
        if validate_rel_path(&rel).is_err() || !seen.insert(rel.to_lowercase()) {
            continue;
        }
        if out.len() >= MAX_FILES {
            return None;
        }
        out.insert(rel, hash_file(entry.path()).ok()?);
    }
    Some(out)
}

#[cfg(test)]
fn install_into(
    root: &Path,
    backups: &Path,
    name: &str,
    marker: SkillMarker,
    files: &[SkillFilePayload],
    force: bool,
    now: SystemTime,
) -> AppResult<InstallOutcome> {
    install_skill(root, backups, name, marker, files, force, false, now)
}

/// §4.4, plus two answers for a folder that is not ours: one that already
/// holds exactly these files is ADOPTED (only the marker is written), and with
/// `replace_unmanaged` (the person's own "Use team version") any other one is
/// backed up and replaced, a copy marked for another owner included (another
/// vault, server or account). Only that explicit click replaces another
/// owner's copy, never a sync run, so two owners cannot keep swapping it.
/// A symlink is never adopted or replaced.
#[allow(clippy::too_many_arguments)]
fn install_skill(
    root: &Path,
    backups: &Path,
    name: &str,
    mut marker: SkillMarker,
    files: &[SkillFilePayload],
    force: bool,
    replace_unmanaged: bool,
    now: SystemTime,
) -> AppResult<InstallOutcome> {
    validate_name(name)?;
    if marker.name != name {
        return Err(AppError::new("marker name does not match the skill name"));
    }
    let owner = match &marker.user_id {
        Some(user_id)
            if !user_id.is_empty()
                && !marker.skill_id.is_empty()
                && !marker.org_id.is_empty()
                && !marker.server_url.is_empty() =>
        {
            SkillOwner {
                skill_id: marker.skill_id.clone(),
                org_id: marker.org_id.clone(),
                server_url: marker.server_url.clone(),
                user_id: user_id.clone(),
            }
        }
        _ => return Err(AppError::new("marker is missing its owner")),
    };
    let decoded = decode_payloads(files)?;
    let payload_files: BTreeMap<String, String> = decoded
        .iter()
        .map(|d| (d.rel.clone(), d.sha.clone()))
        .collect();
    if payload_files != marker.files {
        return Err(AppError::new("marker files do not match the payload"));
    }

    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = root.join(name);
    let mut backup_path = None;
    let exists = match fs::symlink_metadata(&dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Ok(install_outcome(InstallStatus::Conflict, Some("unmanaged")));
            }
            // Any marker naming another owner wins, even one copied under another name.
            let raw = read_marker(&dir);
            if raw.as_ref().is_some_and(|m| !same_owner(m, &owner)) {
                if !replace_unmanaged {
                    return Ok(install_outcome(
                        InstallStatus::Conflict,
                        Some("other_owner"),
                    ));
                }
                let saved = backup_dir(&dir, backups, name, now)?;
                backup_path = Some(saved.display().to_string());
                return finish_install(root, &dir, &decoded, marker, now, true, backup_path);
            }
            let Some(old) = raw.filter(|m| m.name == name) else {
                if folder_as_read(&dir).as_ref() == Some(&marker.files) {
                    marker.installed_at = rfc3339(now);
                    write_atomic_fsync(&dir.join(MARKER), &serde_json::to_vec_pretty(&marker)?)?;
                    return Ok(install_outcome(InstallStatus::Adopted, None));
                }
                if !replace_unmanaged {
                    return Ok(install_outcome(InstallStatus::Conflict, Some("unmanaged")));
                }
                let saved = backup_dir(&dir, backups, name, now)?;
                backup_path = Some(saved.display().to_string());
                return finish_install(root, &dir, &decoded, marker, now, true, backup_path);
            };
            let drift = drifted_files(&dir, &old.files);
            if drift.is_empty() {
                if old.bundle_sha256 == marker.bundle_sha256
                    && old.version == marker.version
                    && old.files == marker.files
                {
                    return Ok(install_outcome(InstallStatus::Unchanged, None));
                }
            } else if !force {
                return Ok(install_outcome(InstallStatus::Edited, None));
            } else {
                let saved = backup_dir(&dir, backups, name, now)?;
                backup_path = Some(saved.display().to_string());
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root)?;
            false
        }
        Err(e) => return Err(e.into()),
    };

    finish_install(root, &dir, &decoded, marker, now, exists, backup_path)
}

/// Stage, verify and swap (§4.4 steps 3–4).
fn finish_install(
    root: &Path,
    dir: &Path,
    decoded: &[Decoded],
    mut marker: SkillMarker,
    now: SystemTime,
    exists: bool,
    backup_path: Option<String>,
) -> AppResult<InstallOutcome> {
    marker.installed_at = rfc3339(now);
    let staging = unique_sibling(root, STAGING_PREFIX);
    if let Err(e) = stage(&staging, decoded, &marker) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    swap_in(root, &staging, dir, exists)?;
    Ok(InstallOutcome {
        status: InstallStatus::Installed,
        backup_path,
        detail: None,
    })
}

fn remove_from(
    root: &Path,
    backups: &Path,
    name: &str,
    owner: &SkillOwner,
    mode: RemoveMode,
    now: SystemTime,
) -> AppResult<RemoveOutcome> {
    validate_name(name)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = root.join(name);
    let outcome = |status| RemoveOutcome {
        status,
        backup_path: None,
    };
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Ok(outcome(RemoveStatus::Conflict))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(outcome(RemoveStatus::NotFound))
        }
        Err(e) => return Err(e.into()),
    }
    let Some(marker) = managed_marker(&dir, name) else {
        return Ok(outcome(RemoveStatus::Conflict));
    };
    if !same_owner(&marker, owner) {
        return Ok(outcome(RemoveStatus::Conflict));
    }
    if mode == RemoveMode::Release {
        // `managed_marker` only reads a regular file, so this never unlinks a symlink target.
        fs::remove_file(dir.join(MARKER))?;
        return Ok(outcome(RemoveStatus::Released));
    }
    let backup_path = if drifted_files(&dir, &marker.files).is_empty() {
        None
    } else {
        Some(backup_dir(&dir, backups, name, now)?.display().to_string())
    };
    // Rename aside first so tools never see a half-deleted skill; a leftover
    // `.baalda-old-*` is swept by the next scan.
    let old = unique_sibling(root, OLD_PREFIX);
    fs::rename(&dir, &old)?;
    if let Err(e) = fs::remove_dir_all(&old) {
        log::warn!("[skills] couldn't remove {}: {e}", old.display());
    }
    Ok(RemoveOutcome {
        status: RemoveStatus::Removed,
        backup_path,
    })
}

// ---- Upload reading (§4.5) ------------------------------------------------------

/// Folder name → a §1.1-shaped suggestion (lowercase, `[a-z0-9]` runs joined by `-`).
fn suggest_name(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(64);
    out.trim_end_matches('-').to_owned()
}

fn skipped_name(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && SKIP_DIRS.contains(&name))
}

/// Collects files for a [`SkillBundle`], enforcing caps and CI uniqueness.
#[derive(Default)]
struct BundleBuilder {
    files: Vec<SkillFilePayload>,
    skipped: BTreeSet<String>,
    seen: HashSet<String>,
    total: usize,
}

impl BundleBuilder {
    /// `Ok(false)` when the path is skipped, so the caller can avoid reading it.
    fn admit(&mut self, rel: &str, size: u64) -> AppResult<bool> {
        if let Err(reason) = validate_rel_path(rel) {
            self.skipped.insert(format!("{rel} ({reason})"));
            return Ok(false);
        }
        if self.seen.contains(&rel.to_lowercase()) {
            self.skipped
                .insert(format!("{rel} (duplicate name differing only in case)"));
            return Ok(false);
        }
        if size > MAX_FILE_BYTES as u64 {
            return Err(too_large(rel));
        }
        if self.files.len() >= MAX_FILES {
            return Err(AppError::new(format!("too many files (max {MAX_FILES})")));
        }
        Ok(true)
    }

    fn push(&mut self, rel: String, bytes: Vec<u8>, executable: bool) -> AppResult<()> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err(too_large(&rel));
        }
        self.total += bytes.len();
        if self.total > MAX_TOTAL_BYTES {
            return Err(AppError::new("skill too large (max 25 MiB)"));
        }
        self.seen.insert(rel.to_lowercase());
        self.files.push(SkillFilePayload {
            sha256: sha256_bytes(&bytes),
            content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            path: rel,
            executable,
        });
        Ok(())
    }

    fn finish(mut self, suggested_name: String) -> AppResult<SkillBundle> {
        if !self.files.iter().any(|f| f.path == "SKILL.md") {
            return Err(AppError::new("SKILL.md not found at the top of the folder"));
        }
        self.files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(SkillBundle {
            suggested_name,
            files: self.files,
            skipped: self.skipped.into_iter().collect(),
        })
    }
}

fn read_folder(path: &Path) -> AppResult<SkillBundle> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::new(format!(
            "symlinks are not allowed: {}",
            path.display()
        )));
    }
    if !meta.is_dir() {
        return Err(AppError::new("not a folder"));
    }
    let mut b = BundleBuilder::default();
    let mut walk = WalkDir::new(path)
        .follow_links(false)
        .sort_by_file_name()
        .min_depth(1)
        .into_iter();
    while let Some(entry) = walk.next() {
        let entry = entry.map_err(|e| AppError::new(format!("Couldn't read the folder: {e}")))?;
        let ft = entry.file_type();
        let rel = rel_string(path, entry.path());
        let Some(name) = entry.file_name().to_str() else {
            b.skipped.insert(format!("{rel} (name is not valid UTF-8)"));
            if ft.is_dir() {
                walk.skip_current_dir();
            }
            continue;
        };
        if skipped_name(name, ft.is_dir()) {
            if ft.is_dir() {
                b.skipped.insert(format!("{rel}/"));
                walk.skip_current_dir();
            } else {
                b.skipped.insert(rel);
            }
            continue;
        }
        if ft.is_symlink() {
            return Err(AppError::new(format!("symlinks are not allowed: {rel}")));
        }
        if ft.is_dir() {
            continue;
        }
        if !ft.is_file() {
            b.skipped.insert(format!("{rel} (not a regular file)"));
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| AppError::new(format!("Couldn't read {rel}: {e}")))?;
        if !b.admit(&rel, meta.len())? {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        b.push(rel, bytes, is_executable(&meta))?;
    }
    let folder = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    b.finish(suggest_name(&folder))
}

const S_IFMT: u32 = 0o170_000;
const S_IFLNK: u32 = 0o120_000;

struct ZipEntry {
    index: usize,
    components: Vec<String>,
    is_dir: bool,
    mode: Option<u32>,
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::new(format!("Couldn't read the zip: {e}"))
}

fn read_zip(path: &Path) -> AppResult<SkillBundle> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::new(format!(
            "symlinks are not allowed: {}",
            path.display()
        )));
    }
    let mut archive = zip::ZipArchive::new(fs::File::open(path)?).map_err(zip_err)?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(AppError::new(format!("too many files (max {MAX_FILES})")));
    }

    // Pass 1: names and modes only (`by_index_raw` never decompresses).
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let f = archive.by_index_raw(index).map_err(zip_err)?;
        // Some Windows tools write `\`; normalise before any safety check.
        let raw = f.name().replace('\\', "/");
        let drive = raw.as_bytes().get(1) == Some(&b':');
        let components: Vec<String> = raw
            .split('/')
            .filter(|c| !c.is_empty() && *c != ".")
            .map(str::to_owned)
            .collect();
        if raw.starts_with('/') || drive || components.iter().any(|c| c == "..") {
            return Err(AppError::new(format!("unsafe path in zip: {raw}")));
        }
        if components.is_empty() {
            continue;
        }
        entries.push(ZipEntry {
            index,
            components,
            is_dir: f.is_dir(),
            mode: f.unix_mode(),
        });
    }

    // One shared top-level folder (ignoring Finder's `__MACOSX` and dot-files
    // beside it) is the skill folder itself: strip it and suggest its name.
    let considered: Vec<&ZipEntry> = entries
        .iter()
        .filter(|e| !skipped_name(&e.components[0], true))
        .collect();
    let tops: BTreeSet<&str> = considered
        .iter()
        .map(|e| e.components[0].as_str())
        .collect();
    let single_top = tops.len() == 1
        && considered
            .iter()
            .all(|e| e.is_dir || e.components.len() >= 2);
    let (strip, suggested) = match (single_top, tops.iter().next()) {
        (true, Some(top)) => (1, suggest_name(top)),
        _ => (
            0,
            suggest_name(
                &path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
        ),
    };

    let mut b = BundleBuilder::default();
    for e in &entries {
        if e.is_dir || e.components.len() <= strip {
            continue;
        }
        let comps = &e.components[strip..];
        let last = comps.len() - 1;
        if let Some(i) = comps
            .iter()
            .enumerate()
            .position(|(i, c)| skipped_name(c, i < last))
        {
            let shown = comps[..=i].join("/");
            b.skipped
                .insert(if i < last { format!("{shown}/") } else { shown });
            continue;
        }
        let rel = comps.join("/");
        let mode = e.mode.unwrap_or(0);
        if mode & S_IFMT == S_IFLNK {
            return Err(AppError::new(format!("symlinks are not allowed: {rel}")));
        }
        let mut f = archive.by_index(e.index).map_err(zip_err)?;
        if !b.admit(&rel, f.size())? {
            continue;
        }
        // The declared size can lie; never read more than the cap allows.
        let mut bytes = Vec::new();
        (&mut f)
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|err| AppError::new(format!("Couldn't read {rel} from the zip: {err}")))?;
        b.push(rel, bytes, mode & 0o111 != 0)?;
    }
    b.finish(suggested)
}

fn export_zip(dest: &Path, name: &str, files: &[SkillFilePayload]) -> AppResult<()> {
    validate_name(name)?;
    let decoded = decode_payloads(files)?;
    if !dest.is_absolute() {
        return Err(AppError::new("export path must be absolute"));
    }
    let is_zip = dest
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err(AppError::new("export path must end in .zip"));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| AppError::new("export path has no folder"))?;
    // A unique hidden sibling: a fixed `<dest>.tmp` could clobber a real file.
    let tmp = unique_sibling(parent, ".baalda-export-");
    // `create_new`: only a file this call created is ever cleaned up below.
    let file = fs::File::create_new(&tmp)?;
    let write = || -> AppResult<()> {
        let mut zip = zip::ZipWriter::new(file);
        for d in &decoded {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(if d.executable { 0o755 } else { 0o644 });
            zip.start_file(format!("{name}/{}", d.rel), options)
                .map_err(zip_err)?;
            zip.write_all(&d.bytes)?;
        }
        zip.finish().map_err(zip_err)?.sync_all()?;
        Ok(())
    };
    if let Err(e) = write().and_then(|()| fs::rename(&tmp, dest).map_err(AppError::from)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn backups_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::new(format!("Couldn't locate the local app-data folder: {e}")))?
        .join("skill-backups");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// File work runs off the main thread; hashing a 25 MiB skill is not free.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new(format!("skills task failed: {e}")))?
}

// ---- Device scan (read-only) -----------------------------------------------------
//
// Every skill the AI tools on this machine can see, for the AI tools page.
// Strictly read-only: only SKILL.md (first 64 KiB), the two tool index files
// (Claude's installed_plugins.json, Codex's config.toml) and file metadata are
// read; nothing is written, and a symlink is followed only to read its
// SKILL.md and stat the folder it points to.

const DEVICE_MAX_ENTRIES: usize = 2000;
const DEVICE_SKILL_MD_BYTES: u64 = 64 * 1024;
const DEVICE_WALK_FILES: u64 = 200;
const DEVICE_WALK_BYTES: u64 = 10 * 1024 * 1024;
const DEVICE_INDEX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum SkillLocation {
    ClaudePersonal,
    ClaudeSynced,
    AgentsPersonal,
    CodexPersonal,
    CodexSystem,
    ClaudePlugin,
    CodexPlugin,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub real_path: String,
    pub is_symlink: bool,
    pub file_count: u64,
    pub total_bytes: u64,
    pub truncated: bool,
    pub location: SkillLocation,
    pub plugin_name: Option<String>,
    pub marketplace: Option<String>,
    pub plugin_version: Option<String>,
    /// Plugins only: whether the tool loads it. `None` for non-plugin skills,
    /// or for a Claude plugin when `settings.json` could not be read.
    pub enabled: Option<bool>,
    pub managed: Option<SkillMarker>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceScan {
    pub entries: Vec<DeviceSkill>,
    pub errors: Vec<DeviceScanError>,
}

/// One root that could not be read; the rest of the scan still answers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceScanError {
    pub root: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSkillMd {
    pub text: String,
    pub truncated: bool,
}

/// The tool folders a device scan reads, resolved by the caller.
struct DeviceRoots {
    claude_config: PathBuf,
    agents_skills: PathBuf,
    codex_home: PathBuf,
}

#[derive(Clone, Default)]
struct PluginInfo {
    name: Option<String>,
    marketplace: Option<String>,
    version: Option<String>,
    enabled: Option<bool>,
}

/// `name` + `description` from SKILL.md frontmatter, reading at most 64 KiB.
fn read_frontmatter(skill_md: &Path) -> (Option<String>, String) {
    let mut text = Vec::new();
    let read =
        fs::File::open(skill_md).and_then(|f| f.take(DEVICE_SKILL_MD_BYTES).read_to_end(&mut text));
    if read.is_err() {
        return (None, String::new());
    }
    let text = String::from_utf8_lossy(&text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, String::new());
    }
    let yaml: Vec<&str> = lines.take_while(|l| l.trim_end() != "---").collect();
    let Ok(serde_yaml::Value::Mapping(map)) =
        serde_yaml::from_str::<serde_yaml::Value>(&yaml.join("\n"))
    else {
        return (None, String::new());
    };
    let field = |k: &str| map.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    (field("name"), field("description").unwrap_or_default())
}

/// Count regular files under `dir` without following links, stopping at the caps.
fn walk_size(dir: &Path) -> (u64, u64, bool) {
    let (mut files, mut bytes) = (0u64, 0u64);
    for entry in WalkDir::new(dir).follow_links(false).min_depth(1) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if files + 1 > DEVICE_WALK_FILES || bytes + len > DEVICE_WALK_BYTES {
            return (files, bytes, true);
        }
        files += 1;
        bytes += len;
    }
    (files, bytes, false)
}

struct DeviceScanner {
    out: DeviceScan,
    full: bool,
}

impl DeviceScanner {
    fn push_error(&mut self, root: &Path, e: impl std::fmt::Display) {
        self.out.errors.push(DeviceScanError {
            root: root.display().to_string(),
            error: e.to_string(),
        });
    }

    /// One skill folder: `dir/SKILL.md` must be a regular file (through a link).
    fn add(&mut self, dir: &Path, location: SkillLocation, plugin: &PluginInfo) {
        if self.full {
            return;
        }
        let skill_md = dir.join("SKILL.md");
        // `metadata` (not open) first: opening a FIFO named SKILL.md would block.
        if !fs::metadata(&skill_md).is_ok_and(|m| m.is_file()) {
            return;
        }
        if self.out.entries.len() >= DEVICE_MAX_ENTRIES {
            self.full = true;
            let root = dir.parent().unwrap_or(dir);
            self.push_error(root, format!("stopped after {DEVICE_MAX_ENTRIES} skills"));
            return;
        }
        let real = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let (fm_name, description) = read_frontmatter(&skill_md);
        let (file_count, total_bytes, truncated) = walk_size(&real);
        let folder = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.out.entries.push(DeviceSkill {
            name: fm_name.filter(|n| !n.is_empty()).unwrap_or(folder),
            description,
            path: dir.display().to_string(),
            real_path: real.display().to_string(),
            is_symlink: is_symlink(dir),
            file_count,
            total_bytes,
            truncated,
            location,
            plugin_name: plugin.name.clone(),
            marketplace: plugin.marketplace.clone(),
            plugin_version: plugin.version.clone(),
            enabled: plugin.enabled,
            managed: read_marker(dir),
        });
    }

    /// `<root>/<name>/SKILL.md`, one level; dot-names and `skip` are left out.
    fn scan_level(
        &mut self,
        root: &Path,
        location: SkillLocation,
        plugin: &PluginInfo,
        skip: &[&str],
    ) {
        let entries = match fs::read_dir(root) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => return self.push_error(root, e),
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy();
                !n.starts_with('.') && !skip.contains(&n.as_ref())
            })
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for dir in dirs {
            self.add(&dir, location, plugin);
        }
    }

    /// `~/.claude/skills/synced/<org>/<name>`: claude.ai org copies.
    fn scan_synced(&mut self, synced: &Path) {
        let orgs = match fs::read_dir(synced) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => return self.push_error(synced, e),
        };
        let mut orgs: Vec<PathBuf> = orgs
            .flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .collect();
        orgs.sort();
        for org in orgs {
            self.scan_level(
                &org,
                SkillLocation::ClaudeSynced,
                &PluginInfo::default(),
                &[],
            );
        }
    }

    /// Installed Claude Code plugins only (`plugins/installed_plugins.json`,
    /// `{version, plugins: {"name@marketplace": [{installPath, version}]}}`).
    fn scan_claude_plugins(&mut self, claude_config: &Path) {
        let index = claude_config.join("plugins").join("installed_plugins.json");
        let Some(json) = self.read_index(&index) else {
            return;
        };
        let parsed: serde_json::Value = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(e) => return self.push_error(&index, e),
        };
        let Some(plugins) = parsed.get("plugins").and_then(|p| p.as_object()) else {
            return;
        };
        let enabled_map = if plugins.is_empty() {
            None
        } else {
            self.claude_enabled_plugins(claude_config)
        };
        let mut seen = HashSet::new();
        for (key, installs) in plugins {
            let (name, marketplace) = split_plugin_key(key);
            // No key counts as enabled: on the machine this was built against every
            // installed plugin had a key, so the absent case is a documented guess.
            let enabled = enabled_map
                .as_ref()
                .map(|m| m.get(key).and_then(|v| v.as_bool()).unwrap_or(true));
            let installs = match installs {
                serde_json::Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            for install in installs {
                let Some(path) = install.get("installPath").and_then(|p| p.as_str()) else {
                    continue;
                };
                let path = PathBuf::from(path);
                if !path.is_absolute() || !seen.insert(path.clone()) {
                    continue;
                }
                let info = PluginInfo {
                    name: Some(name.clone()),
                    marketplace: marketplace.clone(),
                    version: install
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    enabled,
                };
                self.scan_level(
                    &path.join("skills"),
                    SkillLocation::ClaudePlugin,
                    &info,
                    &[],
                );
            }
        }
    }

    /// `enabledPlugins` from Claude's `settings.json` (`"name@marketplace": bool`).
    /// `None` = unknown: the file is missing or unparseable, reported once.
    fn claude_enabled_plugins(
        &mut self,
        claude_config: &Path,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let path = claude_config.join("settings.json");
        if fs::symlink_metadata(&path).is_err() {
            self.push_error(&path, "not found; plugin enabled state unknown");
            return None;
        }
        let json = self.read_index(&path)?;
        match serde_json::from_str::<serde_json::Value>(&json) {
            Ok(serde_json::Value::Object(settings)) => Some(
                settings
                    .get("enabledPlugins")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default(),
            ),
            Ok(_) => {
                self.push_error(&path, "not a JSON object");
                None
            }
            Err(e) => {
                self.push_error(&path, e);
                None
            }
        }
    }

    /// Codex plugins enabled in `config.toml`, from
    /// `plugins/cache/<marketplace>/<plugin>/<version>/skills/*`. With several
    /// cached versions the most recently modified one is taken.
    fn scan_codex_plugins(&mut self, codex_home: &Path) {
        let config = codex_home.join("config.toml");
        let Some(toml) = self.read_index(&config) else {
            return;
        };
        let cache = codex_home.join("plugins").join("cache");
        for key in enabled_codex_plugins(&toml) {
            let (name, marketplace) = split_plugin_key(&key);
            let Some(marketplace) = marketplace else {
                continue;
            };
            // The key comes from a file: never let it climb out of the cache.
            if !is_plain_component(&name) || !is_plain_component(&marketplace) {
                continue;
            }
            let plugin_dir = cache.join(&marketplace).join(&name);
            let Ok(versions) = fs::read_dir(&plugin_dir) else {
                continue;
            };
            let newest = versions
                .flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
            let Some(version) = newest else {
                continue;
            };
            let info = PluginInfo {
                name: Some(name),
                marketplace: Some(marketplace),
                version: Some(version.file_name().to_string_lossy().into_owned()),
                // Only plugins `config.toml` enables are listed at all.
                enabled: Some(true),
            };
            self.scan_level(
                &version.path().join("skills"),
                SkillLocation::CodexPlugin,
                &info,
                &[],
            );
        }
    }

    /// A tool's own index file: missing is normal, anything else is reported.
    fn read_index(&mut self, path: &Path) -> Option<String> {
        match fs::metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                self.push_error(path, e);
                None
            }
            Ok(m) if !m.is_file() || m.len() > DEVICE_INDEX_BYTES => {
                self.push_error(path, "not a readable file");
                None
            }
            Ok(_) => match fs::read_to_string(path) {
                Ok(s) => Some(s),
                Err(e) => {
                    self.push_error(path, e);
                    None
                }
            },
        }
    }
}

fn split_plugin_key(key: &str) -> (String, Option<String>) {
    match key.rsplit_once('@') {
        Some((name, marketplace)) => (name.to_owned(), Some(marketplace.to_owned())),
        None => (key.to_owned(), None),
    }
}

fn is_plain_component(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0'])
}

/// `[plugins."name@marketplace"]` sections with `enabled = true`, by a
/// line-based read — enough for the one shape Codex writes, no TOML crate.
fn enabled_codex_plugins(toml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in toml.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            current = line
                .strip_prefix("[plugins.")
                .and_then(|r| r.strip_suffix(']'))
                .map(|k| k.trim().trim_matches(|c| c == '"' || c == '\'').to_owned());
            continue;
        }
        if let (Some(key), Some((k, v))) = (&current, line.split_once('=')) {
            if k.trim() == "enabled" && v.trim() == "true" && !out.contains(key) {
                out.push(key.clone());
            }
        }
    }
    out
}

fn device_roots() -> AppResult<DeviceRoots> {
    let home = home_or_err()?;
    Ok(DeviceRoots {
        claude_config: claude_config_dir(&home, std::env::var_os("CLAUDE_CONFIG_DIR")),
        agents_skills: target_root(SkillTarget::Agents, &home, None),
        codex_home: absolute_env(std::env::var_os("CODEX_HOME"))
            .unwrap_or_else(|| home.join(".codex")),
    })
}

const DEVICE_PREVIEW_BYTES: u64 = 256 * 1024;

/// Read `<path>/SKILL.md` when `path` sits inside a folder the scan covers
/// (the tool folders, or an installed Claude plugin's installPath). The check
/// is lexical on the path as scanned, so a symlinked skill previews through
/// its link; `.`/`..` components are refused outright.
fn read_device_skill_md(roots: &DeviceRoots, path: &Path) -> AppResult<DeviceSkillMd> {
    check_device_skill_dir(roots, path)?;
    let skill_md = path.join("SKILL.md");
    if !fs::metadata(&skill_md).is_ok_and(|m| m.is_file()) {
        return Err(AppError::new("SKILL.md not found"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&skill_md)?
        .take(DEVICE_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > DEVICE_PREVIEW_BYTES;
    bytes.truncate(DEVICE_PREVIEW_BYTES as usize);
    Ok(DeviceSkillMd {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

/// The one gate for every per-skill device read: `path` (as scanned) must be
/// absolute, free of `.`/`..`, and strictly inside a folder the scan covers.
fn check_device_skill_dir(roots: &DeviceRoots, path: &Path) -> AppResult<()> {
    use std::path::Component;
    let refuse = || AppError::new("not a skill folder this scan covers");
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(refuse());
    }
    let mut bases = vec![
        roots.claude_config.clone(),
        roots.agents_skills.clone(),
        roots.codex_home.clone(),
    ];
    let mut s = DeviceScanner {
        out: DeviceScan::default(),
        full: false,
    };
    let index = roots
        .claude_config
        .join("plugins")
        .join("installed_plugins.json");
    if let Some(json) = s.read_index(&index) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            let installs = v.get("plugins").and_then(|p| p.as_object());
            for install in installs.into_iter().flat_map(|m| m.values()) {
                let list = install
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![install.clone()]);
                bases.extend(
                    list.iter()
                        .filter_map(|i| i.get("installPath")?.as_str())
                        .map(PathBuf::from)
                        .filter(|p| p.is_absolute()),
                );
            }
        }
    }
    if !bases
        .iter()
        .any(|b| path.starts_with(b) && path != b.as_path())
    {
        return Err(refuse());
    }
    Ok(())
}

const DEVICE_LIST_MAX: usize = 2000;
const DEVICE_FILE_READ_BYTES: usize = 512 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSkillFile {
    pub rel_path: String,
    pub size: u64,
    pub is_symlink: bool,
    /// From the first 8 KiB; `None` for a symlink (never opened).
    pub is_binary: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSkillFiles {
    pub files: Vec<DeviceSkillFile>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSkillFileText {
    pub text: Option<String>,
    pub truncated: bool,
    pub binary: bool,
}

/// Binary = a NUL in the first 8 KiB or invalid UTF-8. `cut` says the bytes
/// were truncated, so an incomplete character at the very end is not invalid.
fn looks_binary(bytes: &[u8], cut: bool) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
        || match std::str::from_utf8(bytes) {
            Ok(_) => false,
            Err(e) => !(cut && e.error_len().is_none()),
        }
}

fn read_prefix(path: &Path, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Files of one device skill, for the read-only file tree. The skill folder
/// itself may be a link (as scanned); nothing inside it is followed, and the
/// upload noise rules (dot-names, `node_modules`, …) leave folders out.
fn list_device_skill_files(roots: &DeviceRoots, path: &Path) -> AppResult<DeviceSkillFiles> {
    check_device_skill_dir(roots, path)?;
    let dir = fs::canonicalize(path)?;
    if !dir.is_dir() {
        return Err(AppError::new("not a folder"));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    let mut walk = WalkDir::new(&dir)
        .follow_links(false)
        .sort_by_file_name()
        .min_depth(1)
        .into_iter();
    while let Some(entry) = walk.next() {
        let Ok(entry) = entry else { continue };
        let ft = entry.file_type();
        let name = entry.file_name().to_string_lossy();
        if skipped_name(&name, ft.is_dir()) {
            if ft.is_dir() {
                walk.skip_current_dir();
            }
            continue;
        }
        if ft.is_dir() || !(ft.is_file() || ft.is_symlink()) {
            continue;
        }
        if files.len() >= DEVICE_LIST_MAX {
            truncated = true;
            break;
        }
        let size = entry
            .path()
            .symlink_metadata()
            .map(|m| m.len())
            .unwrap_or(0);
        let is_binary = if ft.is_symlink() {
            None
        } else {
            read_prefix(entry.path(), BINARY_SNIFF_BYTES).ok().map(|b| {
                let cut = b.len() > BINARY_SNIFF_BYTES;
                looks_binary(&b[..b.len().min(BINARY_SNIFF_BYTES)], cut)
            })
        };
        files.push(DeviceSkillFile {
            rel_path: rel_string(&dir, entry.path()),
            size,
            is_symlink: ft.is_symlink(),
            is_binary,
        });
    }
    Ok(DeviceSkillFiles { files, truncated })
}

/// One file of a device skill (≤512 KiB). `rel_path` passes the §1.2
/// validator and no component of it may be a symlink.
fn read_device_skill_file(
    roots: &DeviceRoots,
    path: &Path,
    rel_path: &str,
) -> AppResult<DeviceSkillFileText> {
    check_device_skill_dir(roots, path)?;
    validate_rel_path(rel_path)
        .map_err(|r| AppError::new(format!("invalid skill path: {rel_path} ({r})")))?;
    let mut target = fs::canonicalize(path)?;
    for component in rel_path.split('/') {
        target.push(component);
        if is_symlink(&target) {
            return Err(AppError::new(format!(
                "symlinks are not allowed: {rel_path}"
            )));
        }
    }
    if !fs::symlink_metadata(&target).is_ok_and(|m| m.is_file()) {
        return Err(AppError::new(format!("not a file: {rel_path}")));
    }
    let mut bytes = read_prefix(&target, DEVICE_FILE_READ_BYTES)?;
    let truncated = bytes.len() > DEVICE_FILE_READ_BYTES;
    bytes.truncate(DEVICE_FILE_READ_BYTES);
    if looks_binary(&bytes, truncated) {
        return Ok(DeviceSkillFileText {
            text: None,
            truncated,
            binary: true,
        });
    }
    // Drop a character the cap split in half.
    let valid = std::str::from_utf8(&bytes).map_or_else(|e| e.valid_up_to(), |s| s.len());
    bytes.truncate(valid);
    Ok(DeviceSkillFileText {
        text: Some(String::from_utf8(bytes).unwrap_or_default()),
        truncated,
        binary: false,
    })
}

fn scan_device(roots: &DeviceRoots) -> DeviceScan {
    let mut s = DeviceScanner {
        out: DeviceScan::default(),
        full: false,
    };
    let none = PluginInfo::default();
    let claude_skills = roots.claude_config.join("skills");
    s.scan_level(
        &claude_skills,
        SkillLocation::ClaudePersonal,
        &none,
        &["synced"],
    );
    s.scan_synced(&claude_skills.join("synced"));
    s.scan_level(
        &roots.agents_skills,
        SkillLocation::AgentsPersonal,
        &none,
        &[],
    );
    let codex_skills = roots.codex_home.join("skills");
    s.scan_level(&codex_skills, SkillLocation::CodexPersonal, &none, &[]);
    s.scan_level(
        &codex_skills.join(".system"),
        SkillLocation::CodexSystem,
        &none,
        &[],
    );
    s.scan_claude_plugins(&roots.claude_config);
    s.scan_codex_plugins(&roots.codex_home);
    s.out
}

// ---- Commands (§4.3) -------------------------------------------------------------

#[tauri::command]
pub async fn skills_targets(window: Webview) -> AppResult<Vec<TargetInfo>> {
    trusted_window(&window)?;
    blocking(|| {
        Ok(targets_info(
            &home_or_err()?,
            std::env::var_os("CLAUDE_CONFIG_DIR"),
            std::env::var_os("CODEX_HOME"),
        ))
    })
    .await
}

#[tauri::command]
pub async fn skills_scan(window: Webview, target: SkillTarget) -> AppResult<Vec<InstalledSkill>> {
    trusted_window(&window)?;
    blocking(move || scan_root(&resolve_root(target)?, SystemTime::now())).await
}

/// Takes `app` beyond the spec's argument list (Tauri injects it; the JS call
/// is unchanged) because a forced install writes its backup into app data.
#[tauri::command]
pub async fn skills_install(
    window: Webview,
    app: tauri::AppHandle,
    target: SkillTarget,
    name: String,
    marker: SkillMarker,
    files: Vec<SkillFilePayload>,
    force: bool,
    replace_unmanaged: Option<bool>,
) -> AppResult<InstallOutcome> {
    trusted_window(&window)?;
    blocking(move || {
        let root = resolve_root(target)?;
        install_skill(
            &root,
            &backups_root(&app)?,
            &name,
            marker,
            &files,
            force,
            replace_unmanaged.unwrap_or(false),
            SystemTime::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn skills_remove(
    window: Webview,
    app: tauri::AppHandle,
    target: SkillTarget,
    name: String,
    owner: SkillOwner,
    mode: Option<RemoveMode>,
) -> AppResult<RemoveOutcome> {
    trusted_window(&window)?;
    blocking(move || {
        let root = resolve_root(target)?;
        remove_from(
            &root,
            &backups_root(&app)?,
            &name,
            &owner,
            mode.unwrap_or_default(),
            SystemTime::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn skills_read_folder(window: Webview, path: String) -> AppResult<SkillBundle> {
    trusted_window(&window)?;
    blocking(move || read_folder(Path::new(&path))).await
}

#[tauri::command]
pub async fn skills_read_zip(window: Webview, path: String) -> AppResult<SkillBundle> {
    trusted_window(&window)?;
    blocking(move || read_zip(Path::new(&path))).await
}

#[tauri::command]
pub async fn skills_export_zip(
    window: Webview,
    dest: String,
    name: String,
    files: Vec<SkillFilePayload>,
) -> AppResult<()> {
    trusted_window(&window)?;
    blocking(move || export_zip(Path::new(&dest), &name, &files)).await
}

#[tauri::command]
pub async fn skills_backups_dir(window: Webview, app: tauri::AppHandle) -> AppResult<String> {
    trusted_window(&window)?;
    blocking(move || Ok(backups_root(&app)?.display().to_string())).await
}

/// Read-only inventory of every skill the AI tools on this machine can see.
#[tauri::command]
pub async fn skills_scan_device(window: Webview) -> AppResult<DeviceScan> {
    trusted_window(&window)?;
    blocking(|| Ok(scan_device(&device_roots()?))).await
}

/// One device skill's SKILL.md for the preview (read-only, capped). `path` is
/// a `DeviceSkill.path` from the scan; anything outside the tool folders is refused.
#[tauri::command]
pub async fn skills_read_device_skill_md(
    window: Webview,
    path: String,
) -> AppResult<DeviceSkillMd> {
    trusted_window(&window)?;
    blocking(move || read_device_skill_md(&device_roots()?, Path::new(&path))).await
}

/// Read-only file list of one device skill (`path` = a `DeviceSkill.path`).
#[tauri::command]
pub async fn skills_list_device_skill_files(
    window: Webview,
    path: String,
) -> AppResult<DeviceSkillFiles> {
    trusted_window(&window)?;
    blocking(move || list_device_skill_files(&device_roots()?, Path::new(&path))).await
}

/// Read-only text of one file in a device skill.
#[tauri::command]
pub async fn skills_read_device_skill_file(
    window: Webview,
    path: String,
    rel_path: String,
) -> AppResult<DeviceSkillFileText> {
    trusted_window(&window)?;
    blocking(move || read_device_skill_file(&device_roots()?, Path::new(&path), &rel_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    const SERVER: &str = "https://example.test";

    fn payload(path: &str, content: &[u8], executable: bool) -> SkillFilePayload {
        SkillFilePayload {
            path: path.into(),
            content_base64: STANDARD.encode(content),
            sha256: sha256_bytes(content),
            executable,
        }
    }

    fn skill_files(body: &str) -> Vec<SkillFilePayload> {
        vec![
            payload(
                "SKILL.md",
                format!("---\nname: demo\ndescription: d\n---\n{body}").as_bytes(),
                false,
            ),
            payload("scripts/run.sh", b"#!/bin/sh\necho hi\n", true),
        ]
    }

    fn marker_for(files: &[SkillFilePayload], version: u32) -> SkillMarker {
        SkillMarker {
            skill_id: "s1".into(),
            org_id: "o1".into(),
            server_url: SERVER.into(),
            user_id: Some("u1".into()),
            name: "demo".into(),
            version,
            bundle_sha256: format!("bundle-v{version}"),
            files: files
                .iter()
                .map(|f| (f.path.clone(), f.sha256.clone()))
                .collect(),
            installed_at: String::new(),
        }
    }

    fn owner() -> SkillOwner {
        SkillOwner {
            skill_id: "s1".into(),
            org_id: "o1".into(),
            server_url: SERVER.into(),
            user_id: "u1".into(),
        }
    }

    struct Env {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        backups: PathBuf,
    }

    fn env() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("home/.claude/skills");
        let backups = tmp.path().join("app-data/skill-backups");
        Env {
            _tmp: tmp,
            root,
            backups,
        }
    }

    fn install(
        e: &Env,
        files: &[SkillFilePayload],
        version: u32,
        force: bool,
    ) -> AppResult<InstallOutcome> {
        install_into(
            &e.root,
            &e.backups,
            "demo",
            marker_for(files, version),
            files,
            force,
            SystemTime::now(),
        )
    }

    fn leftovers(root: &Path) -> Vec<String> {
        fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".baalda-"))
            .collect()
    }

    fn backup_count(e: &Env) -> usize {
        fs::read_dir(&e.backups).map(|d| d.count()).unwrap_or(0)
    }

    #[cfg(unix)]
    fn symlink(src: &Path, dst: &Path) {
        std::os::unix::fs::symlink(src, dst).unwrap();
    }

    // ---- validators

    #[test]
    fn name_rules() {
        for ok in ["a", "demo", "my-skill-2", &"a".repeat(64)] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-a",
            "a-",
            "a--b",
            "A",
            "a_b",
            "a.b",
            "a b",
            "con",
            "nul",
            "com1",
            "lpt9",
            &"a".repeat(65),
        ] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert!(validate_name("con-x").is_ok());
    }

    #[test]
    fn path_rules() {
        for ok in [
            "SKILL.md",
            "scripts/run.sh",
            "a/b/c.txt",
            "consul.txt",
            "name with space.md",
        ] {
            assert!(validate_rel_path(ok).is_ok(), "{ok}");
        }
        let long_component = "a".repeat(101);
        let long_path = format!("{}/{}", "a".repeat(100), "b".repeat(140));
        for bad in [
            "",
            "/abs",
            "a//b",
            "a/",
            "./a",
            "../a",
            "a/../b",
            "a\\b",
            ".hidden",
            "a/.git/x",
            ".baalda-managed.json",
            "a:b",
            "a<b",
            "a|b",
            "a?b",
            "a*b",
            "a\"b",
            "a>b",
            "tab\there",
            "trail.",
            "trail ",
            "con",
            "CON.txt",
            "dir/aux.md",
            "com1.log",
            &long_component,
            &long_path,
        ] {
            assert!(validate_rel_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn payload_caps_and_case_duplicates() {
        let dup = vec![
            payload("SKILL.md", b"a", false),
            payload("skill.md", b"b", false),
        ];
        assert!(decode_payloads(&dup).unwrap_err().0.contains("duplicate"));

        let too_many: Vec<_> = (0..=MAX_FILES)
            .map(|i| payload(&format!("f{i}.md"), b"x", false))
            .collect();
        assert!(decode_payloads(&too_many)
            .unwrap_err()
            .0
            .contains("too many"));

        let big = vec![0u8; MAX_FILE_BYTES + 1];
        assert!(decode_payloads(&[payload("big.bin", &big, false)])
            .unwrap_err()
            .0
            .contains("too large"));

        let chunk = vec![0u8; MAX_FILE_BYTES];
        let total: Vec<_> = (0..6)
            .map(|i| payload(&format!("f{i}.bin"), &chunk, false))
            .collect();
        assert!(decode_payloads(&total)
            .unwrap_err()
            .0
            .contains("skill too large"));
    }

    // ---- roots

    #[test]
    fn claude_config_dir_resolution() {
        let home = Path::new("/home/u");
        assert_eq!(claude_config_dir(home, None), home.join(".claude"));
        assert_eq!(
            claude_config_dir(home, Some("".into())),
            home.join(".claude")
        );
        assert_eq!(
            claude_config_dir(home, Some("relative/dir".into())),
            home.join(".claude")
        );
        let abs = if cfg!(windows) {
            "C:\\cfg\\claude"
        } else {
            "/cfg/claude"
        };
        assert_eq!(
            claude_config_dir(home, Some(abs.into())),
            PathBuf::from(abs)
        );
        assert_eq!(
            target_root(SkillTarget::Claude, home, Some(abs.into())),
            PathBuf::from(abs).join("skills")
        );
        assert_eq!(
            target_root(SkillTarget::Agents, home, Some(abs.into())),
            home.join(".agents").join("skills")
        );
    }

    #[test]
    fn targets_detect_tools_by_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        let codex = tmp.path().join("elsewhere/codex");
        fs::create_dir_all(&codex).unwrap();
        let info = targets_info(home, None, Some(codex.into_os_string()));
        assert!(!info[0].tool_installed && !info[0].root_exists);
        assert_eq!(info[1].detected_tools, ["codex", "cursor", "opencode"]);
        assert!(info[1].tool_installed);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_or_ancestor_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let real = tmp.path().join("real");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(real.join("skills")).unwrap();
        // ~/.claude → elsewhere
        symlink(&real, &home.join(".claude"));
        let err = checked_root(SkillTarget::Claude, &home, None).unwrap_err();
        assert_eq!(err.0, "skills root is a symlink");
        // ~/.agents/skills itself a link
        fs::create_dir_all(home.join(".agents")).unwrap();
        symlink(&real.join("skills"), &home.join(".agents/skills"));
        assert!(checked_root(SkillTarget::Agents, &home, None).is_err());
        // A plain, missing root is fine.
        let other = tmp.path().join("home2");
        fs::create_dir_all(&other).unwrap();
        assert!(checked_root(SkillTarget::Agents, &other, None).is_ok());
    }

    // ---- install

    #[test]
    fn install_fresh_then_unchanged() {
        let e = env();
        let files = skill_files("v1");
        let out = install(&e, &files, 1, false).unwrap();
        assert_eq!(out.status, InstallStatus::Installed);
        let dir = e.root.join("demo");
        assert_eq!(
            fs::read(dir.join("scripts/run.sh")).unwrap(),
            b"#!/bin/sh\necho hi\n"
        );
        let marker = read_marker(&dir).unwrap();
        assert_eq!(marker.version, 1);
        assert!(
            marker.installed_at.ends_with('Z'),
            "{}",
            marker.installed_at
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| fs::metadata(dir.join(p)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode("scripts/run.sh"), 0o755);
            assert_eq!(mode("SKILL.md"), 0o644);
        }
        assert!(leftovers(&e.root).is_empty());

        assert_eq!(
            install(&e, &files, 1, false).unwrap().status,
            InstallStatus::Unchanged
        );
        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan.len(), 1);
        assert_eq!(scan[0].status, InstalledStatus::Managed);
    }

    #[test]
    fn update_swaps_and_leaves_no_debris() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let v2 = vec![payload(
            "SKILL.md",
            b"---\nname: demo\ndescription: two\n---\n",
            false,
        )];
        let out = install(&e, &v2, 2, false).unwrap();
        assert_eq!(out.status, InstallStatus::Installed);
        assert!(out.backup_path.is_none());
        let dir = e.root.join("demo");
        assert!(
            !dir.join("scripts").exists(),
            "files dropped from the new version are gone"
        );
        assert_eq!(read_marker(&dir).unwrap().version, 2);
        assert!(leftovers(&e.root).is_empty());
        assert_eq!(backup_count(&e), 0);
    }

    #[test]
    fn unmanaged_folder_is_a_conflict_and_untouched() {
        let e = env();
        let dir = e.root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "mine").unwrap();
        let out = install(&e, &skill_files("v1"), 1, true).unwrap();
        assert_eq!(out.status, InstallStatus::Conflict);
        assert_eq!(out.detail.as_deref(), Some("unmanaged"));
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "mine");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // A marker naming another folder does not make this one ours.
        let mut m = marker_for(&skill_files("v1"), 1);
        m.name = "other".into();
        fs::write(dir.join(MARKER), serde_json::to_vec(&m).unwrap()).unwrap();
        assert_eq!(
            install(&e, &skill_files("v1"), 1, true).unwrap().status,
            InstallStatus::Conflict
        );
        assert_eq!(
            remove_from(
                &e.root,
                &e.backups,
                "demo",
                &owner(),
                RemoveMode::Delete,
                SystemTime::now()
            )
            .unwrap()
            .status,
            RemoveStatus::Conflict
        );
        assert!(dir.join("SKILL.md").exists());
    }

    #[test]
    fn other_owner_is_a_conflict() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let files = skill_files("v2");
        let mut m = marker_for(&files, 2);
        m.server_url = "https://other.test".into();
        let out = install_into(
            &e.root,
            &e.backups,
            "demo",
            m,
            &files,
            true,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(out.status, InstallStatus::Conflict);
        assert_eq!(out.detail.as_deref(), Some("other_owner"));
        assert_eq!(read_marker(&e.root.join("demo")).unwrap().version, 1);
    }

    #[test]
    fn drift_is_edited_until_forced_then_backed_up() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let dir = e.root.join("demo");
        fs::write(dir.join("SKILL.md"), "my local change").unwrap();
        fs::write(dir.join("notes.txt"), "added").unwrap();

        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan[0].status, InstalledStatus::Edited);
        assert_eq!(scan[0].edited_files, ["SKILL.md", "notes.txt"]);

        let out = install(&e, &skill_files("v2"), 2, false).unwrap();
        assert_eq!(out.status, InstallStatus::Edited);
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "my local change"
        );
        // Same version, drifted: still never silently restored.
        assert_eq!(
            install(&e, &skill_files("v1"), 1, false).unwrap().status,
            InstallStatus::Edited
        );

        let out = install(&e, &skill_files("v2"), 2, true).unwrap();
        assert_eq!(out.status, InstallStatus::Installed);
        let backup = PathBuf::from(out.backup_path.unwrap());
        assert!(backup.starts_with(&e.backups));
        assert_eq!(
            fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "my local change"
        );
        assert_eq!(
            fs::read_to_string(backup.join("notes.txt")).unwrap(),
            "added"
        );
        assert!(!dir.join("notes.txt").exists());
        assert_eq!(read_marker(&dir).unwrap().version, 2);
        assert!(leftovers(&e.root).is_empty());
    }

    #[test]
    fn sha_mismatch_writes_nothing() {
        let e = env();
        let mut files = skill_files("v1");
        let marker = marker_for(&files, 1);
        files[1].content_base64 = STANDARD.encode(b"tampered");
        let err = install_into(
            &e.root,
            &e.backups,
            "demo",
            marker,
            &files,
            false,
            SystemTime::now(),
        )
        .unwrap_err();
        assert_eq!(err.0, "sha mismatch: scripts/run.sh");
        assert!(!e.root.exists());
    }

    #[test]
    fn marker_must_describe_the_payload() {
        let e = env();
        let files = skill_files("v1");
        let mut m = marker_for(&files, 1);
        m.files.insert("extra.md".into(), "0".repeat(64));
        assert!(install_into(
            &e.root,
            &e.backups,
            "demo",
            m,
            &files,
            false,
            SystemTime::now()
        )
        .is_err());
        let mut m = marker_for(&files, 1);
        m.name = "other".into();
        assert!(install_into(
            &e.root,
            &e.backups,
            "demo",
            m,
            &files,
            false,
            SystemTime::now()
        )
        .is_err());
        assert!(install_into(
            &e.root,
            &e.backups,
            "../x",
            marker_for(&files, 1),
            &files,
            false,
            SystemTime::now()
        )
        .is_err());
        assert!(!e.root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_skill_is_edited_and_never_followed() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let dir = e.root.join("demo");
        let outside = e.root.parent().unwrap().join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, &dir.join("link.txt"));

        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan[0].status, InstalledStatus::Edited);
        assert_eq!(scan[0].edited_files, ["link.txt"]);

        let out = install(&e, &skill_files("v2"), 2, true).unwrap();
        let backup = PathBuf::from(out.backup_path.unwrap());
        assert!(!backup.join("link.txt").exists(), "backups skip symlinks");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    }

    /// A person's own folder holding `files` (plus OS droppings an upload skips).
    fn own_folder(e: &Env, files: &[SkillFilePayload]) -> PathBuf {
        let dir = e.root.join("demo");
        for f in files {
            write(&dir, &f.path, &STANDARD.decode(&f.content_base64).unwrap());
        }
        write(&dir, ".DS_Store", b"finder");
        write(&dir, "scripts/__pycache__/run.cpython-312.pyc", b"pyc");
        dir
    }

    fn install_replacing(
        e: &Env,
        files: &[SkillFilePayload],
        marker: SkillMarker,
    ) -> InstallOutcome {
        install_skill(
            &e.root,
            &e.backups,
            "demo",
            marker,
            files,
            false,
            true,
            SystemTime::now(),
        )
        .unwrap()
    }

    #[test]
    fn identical_unmanaged_folder_is_adopted_without_touching_files() {
        let e = env();
        let files = skill_files("v1");
        let dir = own_folder(&e, &files);
        let before = fs::metadata(dir.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap();
        let out = install(&e, &files, 1, false).unwrap();
        assert_eq!(out.status, InstallStatus::Adopted);
        assert!(out.backup_path.is_none());
        assert_eq!(
            fs::metadata(dir.join("SKILL.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        assert_eq!(fs::read(dir.join(".DS_Store")).unwrap(), b"finder");
        let marker = read_marker(&dir).unwrap();
        assert_eq!((marker.version, marker.user_id.as_deref()), (1, Some("u1")));
        assert!(leftovers(&e.root).is_empty());

        // Adopted means ours: the droppings are not a local edit, and the next run is a no-op.
        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan[0].status, InstalledStatus::Managed);
        assert_eq!(
            install(&e, &files, 1, false).unwrap().status,
            InstallStatus::Unchanged
        );
        assert_eq!(
            install(&e, &skill_files("v2"), 2, false).unwrap().status,
            InstallStatus::Installed
        );
    }

    #[test]
    fn any_difference_keeps_the_unmanaged_conflict() {
        let files = skill_files("v1");
        let cases: [(&str, fn(&Path)); 3] = [
            ("one byte", |d| {
                fs::write(d.join("scripts/run.sh"), b"#!/bin/sh\necho hI\n").unwrap()
            }),
            ("extra file", |d| {
                fs::write(d.join("notes.md"), b"mine").unwrap()
            }),
            ("missing file", |d| {
                fs::remove_file(d.join("scripts/run.sh")).unwrap()
            }),
        ];
        for (case, change) in cases {
            let e = env();
            let dir = own_folder(&e, &files);
            change(&dir);
            let out = install(&e, &files, 1, true).unwrap();
            assert_eq!(out.status, InstallStatus::Conflict, "{case}");
            assert_eq!(out.detail.as_deref(), Some("unmanaged"), "{case}");
            assert!(!dir.join(MARKER).exists(), "{case}");
        }
    }

    #[test]
    fn replace_unmanaged_backs_up_then_installs() {
        let e = env();
        let dir = e.root.join("demo");
        write(&dir, "SKILL.md", b"my own skill");
        write(&dir, "notes/keep.md", b"keep me");
        let files = skill_files("v1");
        let out = install_replacing(&e, &files, marker_for(&files, 1));
        assert_eq!(out.status, InstallStatus::Installed);
        let backup = PathBuf::from(out.backup_path.unwrap());
        assert!(backup.starts_with(&e.backups));
        assert_eq!(
            fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "my own skill"
        );
        assert_eq!(
            fs::read_to_string(backup.join("notes/keep.md")).unwrap(),
            "keep me"
        );
        assert!(!dir.join("notes").exists());
        assert_eq!(read_marker(&dir).unwrap().version, 1);
        assert!(leftovers(&e.root).is_empty());
    }

    #[test]
    fn replace_unmanaged_backs_up_another_owners_copy_then_installs() {
        let e = env();
        let files = skill_files("v1");
        let mut theirs = marker_for(&files, 1);
        theirs.user_id = Some("u2".into());
        install_into(
            &e.root,
            &e.backups,
            "demo",
            theirs.clone(),
            &files,
            false,
            SystemTime::now(),
        )
        .unwrap();
        // A sync run (no replace flag) still leaves another owner's copy alone.
        let out = install_into(
            &e.root,
            &e.backups,
            "demo",
            marker_for(&skill_files("v2"), 2),
            &skill_files("v2"),
            true,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(
            (out.status, out.detail.as_deref()),
            (InstallStatus::Conflict, Some("other_owner"))
        );
        assert_eq!(backup_count(&e), 0);

        // "Use team version": theirs is backed up, then ours takes the folder.
        let out = install_replacing(&e, &skill_files("v2"), marker_for(&skill_files("v2"), 2));
        assert_eq!(out.status, InstallStatus::Installed);
        assert!(out.backup_path.is_some());
        assert_eq!(backup_count(&e), 1);
        let dir = e.root.join("demo");
        assert_eq!(read_marker(&dir).unwrap().user_id, marker_for(&files, 1).user_id);
        assert_eq!(read_marker(&dir).unwrap().version, 2);

        // Renamed (a marker naming another folder) is still another owner's: same answer.
        let mut m = theirs;
        m.name = "elsewhere".into();
        fs::write(dir.join(MARKER), serde_json::to_vec(&m).unwrap()).unwrap();
        let out = install_replacing(&e, &files, marker_for(&files, 1));
        assert_eq!(out.status, InstallStatus::Installed);
        assert_eq!(backup_count(&e), 2);
    }

    #[cfg(unix)]
    #[test]
    fn replace_unmanaged_never_follows_a_symlinked_folder() {
        let e = env();
        let real = e.root.parent().unwrap().join("real-skill");
        let files = skill_files("v1");
        for f in &files {
            write(&real, &f.path, &STANDARD.decode(&f.content_base64).unwrap());
        }
        fs::create_dir_all(&e.root).unwrap();
        symlink(&real, &e.root.join("demo"));
        // Neither adopted (identical content) nor replaced.
        for replace in [false, true] {
            let out = install_skill(
                &e.root,
                &e.backups,
                "demo",
                marker_for(&files, 1),
                &files,
                false,
                replace,
                SystemTime::now(),
            )
            .unwrap();
            assert_eq!(
                (out.status, out.detail.as_deref()),
                (InstallStatus::Conflict, Some("unmanaged"))
            );
        }
        assert!(!real.join(MARKER).exists());
        assert!(is_symlink(&e.root.join("demo")));
        assert_eq!(backup_count(&e), 0);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_skill_folder_is_unmanaged() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let real = e.root.join("demo");
        let link = e.root.join("linked");
        symlink(&real, &link);
        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        let linked = scan.iter().find(|s| s.name == "linked").unwrap();
        assert_eq!(linked.status, InstalledStatus::Unmanaged);
    }

    #[test]
    fn scan_skips_dotdirs_and_sweeps_old_leftovers() {
        let e = env();
        assert!(
            scan_root(&e.root, SystemTime::now()).unwrap().is_empty(),
            "missing root"
        );
        fs::create_dir_all(e.root.join(".baalda-staging-abc")).unwrap();
        fs::create_dir_all(e.root.join(".baalda-old-def")).unwrap();
        fs::create_dir_all(e.root.join(".system")).unwrap();
        fs::write(e.root.join("README.md"), "x").unwrap();
        assert!(scan_root(&e.root, SystemTime::now()).unwrap().is_empty());
        assert_eq!(leftovers(&e.root).len(), 2, "fresh leftovers stay");
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        scan_root(&e.root, later).unwrap();
        assert!(leftovers(&e.root).is_empty());
        assert!(e.root.join(".system").exists());
    }

    // ---- remove

    #[test]
    fn remove_respects_the_owner() {
        let e = env();
        assert_eq!(
            remove_from(
                &e.root,
                &e.backups,
                "demo",
                &owner(),
                RemoveMode::Delete,
                SystemTime::now()
            )
            .unwrap()
            .status,
            RemoveStatus::NotFound
        );
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let mut stranger = owner();
        stranger.org_id = "o2".into();
        assert_eq!(
            remove_from(
                &e.root,
                &e.backups,
                "demo",
                &stranger,
                RemoveMode::Delete,
                SystemTime::now()
            )
            .unwrap()
            .status,
            RemoveStatus::Conflict
        );
        assert!(e.root.join("demo").exists());
        let out = remove_from(
            &e.root,
            &e.backups,
            "demo",
            &owner(),
            RemoveMode::Delete,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(out.status, RemoveStatus::Removed);
        assert!(out.backup_path.is_none());
        assert!(!e.root.join("demo").exists());
        assert!(leftovers(&e.root).is_empty());
    }

    #[test]
    fn drifted_remove_backs_up_first() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        fs::write(e.root.join("demo/SKILL.md"), "edited").unwrap();
        let out = remove_from(
            &e.root,
            &e.backups,
            "demo",
            &owner(),
            RemoveMode::Delete,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(out.status, RemoveStatus::Removed);
        let backup = PathBuf::from(out.backup_path.unwrap());
        assert_eq!(
            fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "edited"
        );
        assert!(!e.root.join("demo").exists());
    }

    // ---- uploads

    fn write(base: &Path, rel: &str, content: &[u8]) {
        let p = join_rel(base, rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn read_folder_skips_noise_and_requires_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("My Cool_Skill!");
        write(&src, "SKILL.md", b"---\nname: x\ndescription: y\n---\n");
        write(&src, "ref/guide.md", b"guide");
        write(&src, ".DS_Store", b"x");
        write(&src, ".git/HEAD", b"x");
        write(&src, "node_modules/pkg/index.js", b"x");
        write(&src, "__pycache__/a.pyc", b"x");
        write(&src, "bad:name.md", b"x");
        let bundle = read_folder(&src).unwrap();
        assert_eq!(bundle.suggested_name, "my-cool-skill");
        let paths: Vec<_> = bundle.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["SKILL.md", "ref/guide.md"]);
        assert_eq!(bundle.files[1].sha256, sha256_bytes(b"guide"));
        for s in [".DS_Store", ".git/", "node_modules/", "__pycache__/"] {
            assert!(
                bundle.skipped.iter().any(|x| x == s),
                "{s} in {:?}",
                bundle.skipped
            );
        }
        assert!(bundle
            .skipped
            .iter()
            .any(|x| x.starts_with("bad:name.md (")));

        let empty = tmp.path().join("empty");
        write(&empty, "readme.md", b"x");
        assert_eq!(
            read_folder(&empty).unwrap_err().0,
            "SKILL.md not found at the top of the folder"
        );
    }

    #[test]
    fn read_folder_enforces_caps() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("big");
        write(&src, "SKILL.md", b"x");
        write(&src, "huge.bin", &vec![0u8; MAX_FILE_BYTES + 1]);
        assert!(read_folder(&src).unwrap_err().0.contains("too large"));

        let many = tmp.path().join("many");
        write(&many, "SKILL.md", b"x");
        for i in 0..MAX_FILES {
            write(&many, &format!("f{i}.md"), b"x");
        }
        assert!(read_folder(&many).unwrap_err().0.contains("too many files"));
    }

    #[cfg(unix)]
    #[test]
    fn read_folder_refuses_symlinks_and_keeps_exec_bits() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("s");
        write(&src, "SKILL.md", b"x");
        write(&src, "run.sh", b"#!/bin/sh\n");
        fs::set_permissions(src.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        let bundle = read_folder(&src).unwrap();
        assert!(
            bundle
                .files
                .iter()
                .find(|f| f.path == "run.sh")
                .unwrap()
                .executable
        );
        assert!(
            !bundle
                .files
                .iter()
                .find(|f| f.path == "SKILL.md")
                .unwrap()
                .executable
        );

        symlink(&tmp.path().join("elsewhere"), &src.join("ref"));
        assert_eq!(
            read_folder(&src).unwrap_err().0,
            "symlinks are not allowed: ref"
        );
    }

    fn zip_with(path: &Path, entries: &[(&str, &[u8], u32)]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, body, mode) in entries {
            let opts = zip::write::SimpleFileOptions::default().unix_permissions(*mode);
            zip.start_file(*name, opts).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn read_zip_strips_one_top_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("download.zip");
        zip_with(
            &path,
            &[
                ("Team Skill/SKILL.md", b"x", 0o644),
                ("Team Skill/bin/run", b"y", 0o755),
                ("__MACOSX/Team Skill/._SKILL.md", b"z", 0o644),
                ("Team Skill/.DS_Store", b"z", 0o644),
            ],
        );
        let bundle = read_zip(&path).unwrap();
        assert_eq!(bundle.suggested_name, "team-skill");
        let paths: Vec<_> = bundle.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["SKILL.md", "bin/run"]);
        assert!(bundle.files[1].executable);
        assert!(bundle.skipped.contains(&".DS_Store".to_string()));

        // No single top folder: the zip's stem is the suggestion.
        let flat = tmp.path().join("Flat_One.zip");
        zip_with(&flat, &[("SKILL.md", b"x", 0o644), ("a/b.md", b"y", 0o644)]);
        let bundle = read_zip(&flat).unwrap();
        assert_eq!(bundle.suggested_name, "flat-one");
        assert_eq!(bundle.files.len(), 2);
    }

    #[test]
    fn read_zip_refuses_traversal_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let evil = tmp.path().join("evil.zip");
        zip_with(
            &evil,
            &[("s/SKILL.md", b"x", 0o644), ("s/../../etc/x", b"y", 0o644)],
        );
        assert!(read_zip(&evil)
            .unwrap_err()
            .0
            .starts_with("unsafe path in zip"));

        let abs = tmp.path().join("abs.zip");
        zip_with(&abs, &[("/etc/passwd", b"y", 0o644)]);
        assert!(read_zip(&abs)
            .unwrap_err()
            .0
            .starts_with("unsafe path in zip"));

        let link = tmp.path().join("link.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&link).unwrap());
            zip.start_file("s/SKILL.md", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"x").unwrap();
            zip.add_symlink("s/ref", "/etc", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(
            read_zip(&link).unwrap_err().0,
            "symlinks are not allowed: ref"
        );
    }

    #[test]
    fn export_zip_round_trips_through_read_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("demo-v3.zip");
        let files = skill_files("v3");
        export_zip(&dest, "demo", &files).unwrap();
        let names: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["demo-v3.zip"], "no temp file left behind");
        let bundle = read_zip(&dest).unwrap();
        assert_eq!(bundle.suggested_name, "demo");
        assert_eq!(bundle.files.len(), files.len());
        for (a, b) in bundle.files.iter().zip(files.iter()) {
            assert_eq!(
                (&a.path, &a.sha256, a.executable),
                (&b.path, &b.sha256, b.executable)
            );
        }

        let mut bad = files.clone();
        bad[0].sha256 = "0".repeat(64);
        let dest2 = tmp.path().join("bad.zip");
        assert!(export_zip(&dest2, "demo", &bad)
            .unwrap_err()
            .0
            .starts_with("sha mismatch"));
        assert!(!dest2.exists());
        assert!(export_zip(&tmp.path().join("x.txt"), "demo", &files).is_err());
    }

    #[test]
    fn export_zip_never_touches_a_file_named_like_a_temp() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("demo.zip");
        fs::write(tmp.path().join("demo.zip.tmp"), "user data").unwrap();
        export_zip(&dest, "demo", &skill_files("v1")).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join("demo.zip.tmp")).unwrap(),
            "user data"
        );
        assert!(dest.exists());
    }

    // ---- ownership by user, release

    fn rel_marker(e: &Env) -> PathBuf {
        e.root.join("demo").join(MARKER)
    }

    #[test]
    fn another_users_copy_is_never_overwritten_or_removed() {
        let e = env();
        let files = skill_files("v1");
        let mut theirs = marker_for(&files, 1);
        theirs.user_id = Some("u2".into());
        install_into(
            &e.root,
            &e.backups,
            "demo",
            theirs,
            &files,
            false,
            SystemTime::now(),
        )
        .unwrap();

        let out = install(&e, &skill_files("v2"), 2, true).unwrap();
        assert_eq!(out.status, InstallStatus::Conflict);
        assert_eq!(out.detail.as_deref(), Some("other_owner"));
        for mode in [RemoveMode::Delete, RemoveMode::Release] {
            let out = remove_from(
                &e.root,
                &e.backups,
                "demo",
                &owner(),
                mode,
                SystemTime::now(),
            )
            .unwrap();
            assert_eq!(out.status, RemoveStatus::Conflict);
        }
        let marker = read_marker(&e.root.join("demo")).unwrap();
        assert_eq!((marker.version, marker.user_id.as_deref()), (1, Some("u2")));
    }

    #[test]
    fn a_marker_without_user_id_counts_as_ours() {
        let e = env();
        install(&e, &skill_files("v1"), 1, false).unwrap();
        // Rewrite the marker the way an earlier dev build did: no userId key.
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(rel_marker(&e)).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("userId");
        fs::write(rel_marker(&e), serde_json::to_vec(&legacy).unwrap()).unwrap();

        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan[0].status, InstalledStatus::Managed);
        assert_eq!(scan[0].marker.as_ref().unwrap().user_id, None);

        let out = install(&e, &skill_files("v2"), 2, false).unwrap();
        assert_eq!(out.status, InstallStatus::Installed);
        let marker = read_marker(&e.root.join("demo")).unwrap();
        assert_eq!(
            marker.user_id.as_deref(),
            Some("u1"),
            "upgraded on reinstall"
        );
    }

    #[test]
    fn install_requires_a_user() {
        let e = env();
        let files = skill_files("v1");
        for user in [None, Some(String::new())] {
            let mut m = marker_for(&files, 1);
            m.user_id = user;
            let err = install_into(
                &e.root,
                &e.backups,
                "demo",
                m,
                &files,
                false,
                SystemTime::now(),
            )
            .unwrap_err();
            assert_eq!(err.0, "marker is missing its owner");
        }
        assert!(!e.root.exists());
    }

    #[test]
    fn release_drops_only_the_marker() {
        let e = env();
        assert_eq!(
            remove_from(
                &e.root,
                &e.backups,
                "demo",
                &owner(),
                RemoveMode::Release,
                SystemTime::now()
            )
            .unwrap()
            .status,
            RemoveStatus::NotFound
        );
        install(&e, &skill_files("v1"), 1, false).unwrap();
        let dir = e.root.join("demo");
        fs::write(dir.join("SKILL.md"), "kept local edit").unwrap();

        let mut stranger = owner();
        stranger.skill_id = "s2".into();
        let out = remove_from(
            &e.root,
            &e.backups,
            "demo",
            &stranger,
            RemoveMode::Release,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(out.status, RemoveStatus::Conflict);
        assert!(rel_marker(&e).exists());

        let out = remove_from(
            &e.root,
            &e.backups,
            "demo",
            &owner(),
            RemoveMode::Release,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(out.status, RemoveStatus::Released);
        assert!(out.backup_path.is_none());
        assert!(!rel_marker(&e).exists());
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "kept local edit"
        );
        assert!(dir.join("scripts/run.sh").exists());
        assert_eq!(backup_count(&e), 0);

        let scan = scan_root(&e.root, SystemTime::now()).unwrap();
        assert_eq!(scan[0].status, InstalledStatus::Unmanaged);
        // Now the user's: a later install or remove leaves it alone.
        assert_eq!(
            install(&e, &skill_files("v2"), 2, true).unwrap().status,
            InstallStatus::Conflict
        );
        assert_eq!(
            remove_from(
                &e.root,
                &e.backups,
                "demo",
                &owner(),
                RemoveMode::Delete,
                SystemTime::now()
            )
            .unwrap()
            .status,
            RemoveStatus::Conflict
        );
        assert!(dir.exists());
    }

    #[test]
    fn remove_mode_defaults_to_delete() {
        let mode: Option<RemoveMode> = serde_json::from_str("null").unwrap();
        assert_eq!(mode.unwrap_or_default(), RemoveMode::Delete);
        let mode: RemoveMode = serde_json::from_str("\"release\"").unwrap();
        assert_eq!(mode, RemoveMode::Release);
        assert_eq!(
            serde_json::to_string(&RemoveStatus::Released).unwrap(),
            "\"released\""
        );
    }

    // ---- device scan

    fn skill_md(dir: &Path, name: &str, description: &str) {
        write(
            dir,
            "SKILL.md",
            format!("---\nname: {name}\ndescription: {description}\n---\n# body\n").as_bytes(),
        );
    }

    fn device_fixture() -> (tempfile::TempDir, DeviceRoots) {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let claude = home.join(".claude");
        let agents = home.join(".agents/skills");
        let codex = home.join(".codex");

        skill_md(&claude.join("skills/writer"), "writer", "Writes things");
        write(&claude.join("skills/writer"), "ref/a.md", b"12345");
        fs::create_dir_all(claude.join("skills/no-skill-md")).unwrap();
        write(&claude.join("skills"), "README.md", b"not a skill");
        skill_md(
            &claude.join("skills/synced/org-1/team-voice"),
            "team-voice",
            "Org copy",
        );
        skill_md(&agents.join("shared"), "shared", "Shared one");
        skill_md(&agents.join(".hidden"), "hidden", "never listed");
        // A Baalda-managed copy.
        let files = skill_files("v1");
        let mut marker = marker_for(&files, 1);
        marker.name = "demo".into();
        install_into(
            &agents,
            &home.join("backups"),
            "demo",
            marker,
            &files,
            false,
            SystemTime::now(),
        )
        .unwrap();
        // Frontmatter without a name: the folder name stands in.
        write(
            &codex.join("skills/plain"),
            "SKILL.md",
            b"no frontmatter here",
        );
        skill_md(
            &codex.join("skills/.system/imagegen"),
            "imagegen",
            "System skill",
        );

        // Claude plugins: one installed, one only cached.
        let installed = claude.join("plugins/cache/mkt/tools/1.2.0");
        skill_md(&installed.join("skills/lint"), "lint", "Lints");
        skill_md(
            &claude.join("plugins/cache/mkt/stale/0.1.0/skills/old"),
            "old",
            "not installed",
        );
        let index = serde_json::json!({
            "version": 2,
            "plugins": { "tools@mkt": [{ "scope": "user", "installPath": installed, "version": "1.2.0" }] }
        });
        write(
            &claude.join("plugins"),
            "installed_plugins.json",
            index.to_string().as_bytes(),
        );
        write(
            &claude,
            "settings.json",
            br#"{"model":"x","enabledPlugins":{"tools@mkt":true,"stale@mkt":false}}"#,
        );

        // Codex plugins: enabled, disabled, and a key trying to climb out.
        let cache = codex.join("plugins/cache");
        skill_md(
            &cache.join("bundled/viz/1.0.0/skills/visualize"),
            "visualize",
            "Charts",
        );
        skill_md(
            &cache.join("bundled/off/1.0.0/skills/nope"),
            "nope",
            "disabled",
        );
        write(
            &codex,
            "config.toml",
            b"model = \"x\"\n\n[plugins.\"viz@bundled\"]\nenabled = true # on\n\n[plugins.\"off@bundled\"]\nenabled = false\n\n[plugins.\"..@..\"]\nenabled = true\n",
        );
        let roots = DeviceRoots {
            claude_config: claude,
            agents_skills: agents,
            codex_home: codex,
        };
        (tmp, roots)
    }

    fn by_name<'a>(scan: &'a DeviceScan, name: &str) -> Vec<&'a DeviceSkill> {
        scan.entries.iter().filter(|e| e.name == name).collect()
    }

    #[test]
    fn device_scan_finds_every_layout() {
        let (_tmp, roots) = device_fixture();
        let scan = scan_device(&roots);
        assert!(scan.errors.is_empty(), "{:?}", scan.errors);
        let names: Vec<(&str, SkillLocation)> = scan
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.location))
            .collect();
        assert_eq!(
            names,
            [
                ("writer", SkillLocation::ClaudePersonal),
                ("team-voice", SkillLocation::ClaudeSynced),
                ("demo", SkillLocation::AgentsPersonal),
                ("shared", SkillLocation::AgentsPersonal),
                ("plain", SkillLocation::CodexPersonal),
                ("imagegen", SkillLocation::CodexSystem),
                ("lint", SkillLocation::ClaudePlugin),
                ("visualize", SkillLocation::CodexPlugin),
            ]
        );
        let writer = by_name(&scan, "writer")[0];
        assert_eq!(writer.description, "Writes things");
        assert_eq!((writer.file_count, writer.truncated), (2, false));
        assert!(writer.total_bytes > 5);
        assert!(writer.managed.is_none() && writer.plugin_name.is_none());

        let demo = by_name(&scan, "demo")[0];
        assert_eq!(demo.managed.as_ref().unwrap().skill_id, "s1");
        assert_eq!(demo.file_count, 3, "two skill files plus the marker");

        let lint = by_name(&scan, "lint")[0];
        assert_eq!(
            (
                lint.plugin_name.as_deref(),
                lint.marketplace.as_deref(),
                lint.plugin_version.as_deref()
            ),
            (Some("tools"), Some("mkt"), Some("1.2.0"))
        );
        assert_eq!(lint.enabled, Some(true));
        assert!(scan
            .entries
            .iter()
            .filter(|e| !matches!(
                e.location,
                SkillLocation::ClaudePlugin | SkillLocation::CodexPlugin
            ))
            .all(|e| e.enabled.is_none()));
        let viz = by_name(&scan, "visualize")[0];
        assert_eq!(viz.enabled, Some(true));
        assert_eq!(viz.plugin_version.as_deref(), Some("1.0.0"));
        assert_eq!(by_name(&scan, "plain")[0].description, "");
    }

    #[test]
    fn device_scan_is_read_only() {
        let (tmp, roots) = device_fixture();
        let snapshot = |root: &Path| -> Vec<(String, u64)> {
            WalkDir::new(root)
                .sort_by_file_name()
                .into_iter()
                .flatten()
                .map(|e| {
                    (
                        e.path().display().to_string(),
                        e.metadata().map(|m| m.len()).unwrap_or(0),
                    )
                })
                .collect()
        };
        let before = snapshot(tmp.path());
        scan_device(&roots);
        assert_eq!(before, snapshot(tmp.path()));
    }

    #[cfg(unix)]
    #[test]
    fn device_scan_reports_symlinked_skills_with_their_real_path() {
        let (_tmp, roots) = device_fixture();
        symlink(
            &roots.agents_skills.join("shared"),
            &roots.claude_config.join("skills/shared"),
        );
        let scan = scan_device(&roots);
        let shared = by_name(&scan, "shared");
        assert_eq!(shared.len(), 2);
        let link = shared.iter().find(|e| e.is_symlink).unwrap();
        let real = shared.iter().find(|e| !e.is_symlink).unwrap();
        assert_eq!(link.location, SkillLocation::ClaudePersonal);
        assert_eq!(link.real_path, real.real_path);
        assert_ne!(link.path, real.path);
    }

    #[test]
    fn device_scan_caps_walks_and_reports_bad_indexes() {
        let (_tmp, roots) = device_fixture();
        let big = roots.claude_config.join("skills/big");
        skill_md(&big, "big", "many files");
        for i in 0..250 {
            write(&big, &format!("f{i}.txt"), b"x");
        }
        write(
            &roots.claude_config.join("plugins"),
            "installed_plugins.json",
            b"{not json",
        );
        let scan = scan_device(&roots);
        let big = by_name(&scan, "big")[0];
        assert_eq!((big.file_count, big.truncated), (DEVICE_WALK_FILES, true));
        assert_eq!(scan.errors.len(), 1);
        assert!(scan.errors[0].root.ends_with("installed_plugins.json"));
        assert!(!scan.errors[0].error.is_empty());
        assert!(by_name(&scan, "lint").is_empty());
        assert!(
            !by_name(&scan, "writer").is_empty(),
            "one bad root never fails the scan"
        );
    }

    #[test]
    fn device_scan_stops_at_the_entry_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let agents = tmp.path().join("agents");
        for i in 0..DEVICE_MAX_ENTRIES + 3 {
            write(&agents.join(format!("s{i}")), "SKILL.md", b"x");
        }
        let scan = scan_device(&DeviceRoots {
            claude_config: tmp.path().join("claude"),
            agents_skills: agents,
            codex_home: tmp.path().join("codex"),
        });
        assert_eq!(scan.entries.len(), DEVICE_MAX_ENTRIES);
        assert_eq!(scan.errors.len(), 1);
        assert_eq!(
            scan.errors[0].error,
            format!("stopped after {DEVICE_MAX_ENTRIES} skills")
        );
    }

    #[test]
    fn device_skill_md_preview_is_confined_to_scanned_folders() {
        let (tmp, roots) = device_fixture();
        let scan = scan_device(&roots);
        for e in &scan.entries {
            let md = read_device_skill_md(&roots, Path::new(&e.path)).unwrap();
            assert!(!md.text.is_empty() && !md.truncated, "{}", e.path);
        }
        let writer = by_name(&scan, "writer")[0];
        assert!(read_device_skill_md(&roots, Path::new(&writer.path))
            .unwrap()
            .text
            .contains("Writes things"));

        let outside = tmp.path().join("elsewhere/skill");
        skill_md(&outside, "x", "y");
        for bad in [
            outside.clone(),
            roots.claude_config.join("skills/../../../elsewhere/skill"),
            roots.claude_config.clone(),
            PathBuf::from("relative/skill"),
        ] {
            assert!(
                read_device_skill_md(&roots, &bad).is_err(),
                "{}",
                bad.display()
            );
        }
        assert!(
            read_device_skill_md(&roots, &roots.claude_config.join("skills/no-skill-md")).is_err()
        );

        let big = roots.agents_skills.join("big");
        write(
            &big,
            "SKILL.md",
            &vec![b'a'; DEVICE_PREVIEW_BYTES as usize + 10],
        );
        let md = read_device_skill_md(&roots, &big).unwrap();
        assert!(md.truncated);
        assert_eq!(md.text.len(), DEVICE_PREVIEW_BYTES as usize);
    }

    #[cfg(unix)]
    #[test]
    fn device_skill_md_previews_through_a_link_and_read_folder_refuses_it() {
        let (tmp, roots) = device_fixture();
        let real = tmp.path().join("dev/my-skill");
        skill_md(&real, "my-skill", "linked in");
        let link = roots.claude_config.join("skills/my-skill");
        symlink(&real, &link);
        assert!(read_device_skill_md(&roots, &link)
            .unwrap()
            .text
            .contains("linked in"));
        // "Share with team" must hand read_folder the realPath, not the link.
        assert!(read_folder(&link)
            .unwrap_err()
            .0
            .starts_with("symlinks are not allowed"));
        let real_path = fs::canonicalize(&link).unwrap();
        assert_eq!(read_folder(&real_path).unwrap().suggested_name, "my-skill");
    }

    #[test]
    fn claude_plugin_enabled_follows_settings() {
        let (_tmp, roots) = device_fixture();
        let lint = |settings: Option<&[u8]>| {
            let path = roots.claude_config.join("settings.json");
            match settings {
                Some(body) => fs::write(&path, body).unwrap(),
                None => fs::remove_file(&path).unwrap(),
            }
            let scan = scan_device(&roots);
            let e = by_name(&scan, "lint")[0].enabled;
            (e, scan.errors.len())
        };
        assert_eq!(
            lint(Some(br#"{"enabledPlugins":{"tools@mkt":false}}"#)),
            (Some(false), 0)
        );
        assert_eq!(
            lint(Some(br#"{"enabledPlugins":{"other@mkt":false}}"#)),
            (Some(true), 0),
            "absent = enabled"
        );
        assert_eq!(lint(Some(br#"{"theme":"dark"}"#)), (Some(true), 0));
        assert_eq!(lint(Some(b"{broken")), (None, 1));
        assert_eq!(lint(Some(b"[]")), (None, 1));
        assert_eq!(lint(None), (None, 1));
    }

    #[test]
    fn device_skill_files_list_and_read() {
        let (tmp, roots) = device_fixture();
        let dir = roots.claude_config.join("skills/writer");
        write(&dir, "node_modules/x/index.js", b"x");
        write(&dir, ".git/HEAD", b"x");
        write(&dir, "img.png", b"\x89PNG\0\0binary");
        write(&dir, "latin1.txt", b"caf\xe9");
        let listed = list_device_skill_files(&roots, &dir).unwrap();
        assert!(!listed.truncated);
        let rels: Vec<_> = listed.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, ["SKILL.md", "img.png", "latin1.txt", "ref/a.md"]);
        let md = &listed.files[0];
        assert_eq!((md.is_symlink, md.is_binary), (false, Some(false)));
        assert_eq!(listed.files[1].is_binary, Some(true));
        assert_eq!(listed.files[2].is_binary, Some(true));
        assert_eq!(listed.files[3].size, 5);

        let text = read_device_skill_file(&roots, &dir, "ref/a.md").unwrap();
        assert_eq!(
            (text.text.as_deref(), text.truncated, text.binary),
            (Some("12345"), false, false)
        );
        for bin in ["img.png", "latin1.txt"] {
            let out = read_device_skill_file(&roots, &dir, bin).unwrap();
            assert_eq!((out.text, out.binary), (None, true), "{bin}");
        }

        // Traversal, absolute, dot paths and the outside world are refused.
        for bad in [
            "../shared/SKILL.md",
            "/etc/passwd",
            "ref/../../x",
            ".git/HEAD",
            "a\\b",
        ] {
            assert!(read_device_skill_file(&roots, &dir, bad).is_err(), "{bad}");
        }
        let outside = tmp.path().join("elsewhere/skill");
        skill_md(&outside, "x", "y");
        assert!(list_device_skill_files(&roots, &outside).is_err());
        assert!(read_device_skill_file(&roots, &outside, "SKILL.md").is_err());
        assert!(list_device_skill_files(
            &roots,
            &roots.claude_config.join("skills/../../elsewhere/skill")
        )
        .is_err());
        assert!(read_device_skill_file(&roots, &dir, "missing.md").is_err());
    }

    #[test]
    fn device_skill_file_read_truncates_on_a_char_boundary() {
        let (_tmp, roots) = device_fixture();
        let dir = roots.agents_skills.join("shared");
        // 3-byte characters straddle the 512 KiB cap.
        let body = "\u{20ac}".repeat(DEVICE_FILE_READ_BYTES / 3 + 10);
        write(&dir, "big.md", body.as_bytes());
        let out = read_device_skill_file(&roots, &dir, "big.md").unwrap();
        assert!(out.truncated && !out.binary);
        let text = out.text.unwrap();
        assert!(text.len() <= DEVICE_FILE_READ_BYTES && text.chars().all(|c| c == '\u{20ac}'));

        for i in 0..DEVICE_LIST_MAX + 5 {
            write(&dir, &format!("many/f{i:05}.txt"), b"x");
        }
        let listed = list_device_skill_files(&roots, &dir).unwrap();
        assert!(listed.truncated);
        assert_eq!(listed.files.len(), DEVICE_LIST_MAX);
    }

    #[cfg(unix)]
    #[test]
    fn device_skill_files_never_follow_nested_links() {
        let (tmp, roots) = device_fixture();
        let secret_dir = tmp.path().join("secret");
        write(&secret_dir, "key.txt", b"secret");
        let dir = roots.claude_config.join("skills/writer");
        symlink(&secret_dir.join("key.txt"), &dir.join("link.txt"));
        symlink(&secret_dir, &dir.join("linkdir"));
        let listed = list_device_skill_files(&roots, &dir).unwrap();
        let links: Vec<_> = listed.files.iter().filter(|f| f.is_symlink).collect();
        assert_eq!(links.len(), 2);
        assert!(links.iter().all(|f| f.is_binary.is_none()));
        assert!(!listed
            .files
            .iter()
            .any(|f| f.rel_path.starts_with("linkdir/")));
        for rel in ["link.txt", "linkdir/key.txt"] {
            let err = read_device_skill_file(&roots, &dir, rel).unwrap_err();
            assert!(
                err.0.starts_with("symlinks are not allowed"),
                "{rel}: {err}"
            );
        }

        // A skill folder that IS a link (as scanned) lists and reads its target.
        let real = tmp.path().join("dev/my-skill");
        skill_md(&real, "my-skill", "linked");
        let link = roots.claude_config.join("skills/my-skill");
        symlink(&real, &link);
        let listed = list_device_skill_files(&roots, &link).unwrap();
        assert_eq!(listed.files.len(), 1);
        assert!(read_device_skill_file(&roots, &link, "SKILL.md")
            .unwrap()
            .text
            .unwrap()
            .contains("linked"));
    }

    #[test]
    fn codex_config_parsing() {
        let toml = "[plugins.\"a@m\"]\nenabled = true\n[plugins.'b@m']\nenabled=true\n[plugins.\"c@m\"]\nenabled = false\n[other]\nenabled = true\n";
        assert_eq!(enabled_codex_plugins(toml), ["a@m", "b@m"]);
        assert_eq!(split_plugin_key("x@y@z"), ("x@y".into(), Some("z".into())));
        assert!(
            !is_plain_component("..") && !is_plain_component("a/b") && is_plain_component("ok")
        );
    }

    #[test]
    fn timestamps_format_in_utc() {
        let at = UNIX_EPOCH + Duration::from_secs(1_793_016_245); // 2026-10-26T12:04:05Z
        assert_eq!(rfc3339(at), "2026-10-26T12:04:05Z");
        assert_eq!(backup_stamp(at), "20261026-120405");
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn suggested_names_follow_the_name_rule() {
        assert_eq!(suggest_name("My Skill (v2)"), "my-skill-v2");
        assert_eq!(suggest_name("--__--"), "");
        assert_eq!(suggest_name(&"a".repeat(80)).len(), 64);
    }
}
