//! Local recovery copies under `<vault>/.context/trash/<stamp>/<rel path>`.
//!
//! Sync writes these when it has to set local text aside (a teammate's delete
//! over unsent edits, revoked access, another app's offline edit that lost to
//! the server). Vault Health lists them and lets a person open, compare,
//! restore or delete one. Every other command refuses `.context`, so these
//! resolve the trash root EXPLICITLY and accept only a stamp plus a path under
//! it: no `..`, no absolute path, no symlink anywhere below the vault, and
//! never a file outside `.context/trash`.
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Vault-relative location of the trash root. Same constant as `checks.rs`.
pub const TRASH_DIR: &str = ".context/trash";

/// Most copies one listing returns. Health pages the list; a vault with more
/// than this has a problem the "Empty trash" check already reports.
pub const MAX_LISTED: usize = 5000;

/// Largest copy `read_trash_copy` returns, like the server's `MAX_NOTE_MB`.
pub const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashCopy {
    /// The timestamp directory directly under `.context/trash`.
    pub stamp: String,
    /// The copy's path under that stamp, `/`-separated (the note's original
    /// vault-relative path, possibly with a ` (2)` collision suffix).
    pub rel_path: String,
    pub bytes: u64,
    /// Modification time, milliseconds since the Unix epoch.
    pub modified: i64,
}

/// A stamp is one directory name the app itself generated: ASCII letters,
/// digits, `-` and `_`. Mirrors `notefile::validate_trash_stamp`.
fn validate_stamp(stamp: &str) -> AppResult<()> {
    if stamp.is_empty()
        || stamp.starts_with('.')
        || !stamp
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(AppError::new("invalid trash stamp"));
    }
    Ok(())
}

/// Only plain components: no `..`, no root, no drive prefix, no `.`, no
/// backslash (a Windows separator smuggled through a `/` path) and no NUL.
fn validate_rel(rel: &str) -> AppResult<()> {
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return Err(AppError::new("invalid recovery copy path"));
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(_) => {}
            Component::ParentDir => {
                return Err(AppError::new("path traversal ('..') is not allowed"));
            }
            _ => return Err(AppError::new("invalid recovery copy path")),
        }
    }
    Ok(())
}

/// Refuse when any existing component from the vault root down to `abs` is a
/// symlink. `.context` itself counts: a linked `.context` would make every
/// "inside the trash" check describe somewhere else entirely.
fn refuse_links(vault: &Path, abs: &Path) -> AppResult<()> {
    let rel = abs
        .strip_prefix(vault)
        .map_err(|_| AppError::new("recovery copy escapes the vault"))?;
    let mut cur = vault.to_path_buf();
    for comp in rel.components() {
        cur.push(comp);
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(AppError::new("refusing a recovery copy behind a symlink"));
            }
            Ok(_) => {}
            Err(_) => break, // missing: nothing further down can be a link
        }
    }
    Ok(())
}

/// The absolute path of one copy, validated. The file need not exist.
pub fn resolve_copy(vault: &Path, stamp: &str, rel: &str) -> AppResult<PathBuf> {
    validate_stamp(stamp)?;
    validate_rel(rel)?;
    let root = vault.join(TRASH_DIR);
    let abs = root.join(stamp).join(rel);
    if !abs.starts_with(&root) {
        return Err(AppError::new("recovery copy escapes the trash"));
    }
    refuse_links(vault, &abs)?;
    Ok(abs)
}

fn to_slash(p: &Path) -> Option<String> {
    let mut out = Vec::new();
    for comp in p.components() {
        match comp {
            Component::Normal(s) => out.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    Some(out.join("/"))
}

/// Every file under `.context/trash/<stamp>/`, newest first. Never follows a
/// link, and a linked trash root lists nothing.
pub fn list_copies(vault: &Path) -> AppResult<Vec<TrashCopy>> {
    let root = vault.join(TRASH_DIR);
    if refuse_links(vault, &root).is_err() {
        return Err(AppError::new("refusing a trash directory behind a symlink"));
    }
    let Ok(meta) = fs::symlink_metadata(&root) else {
        return Ok(Vec::new());
    };
    if !meta.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for stamp_entry in fs::read_dir(&root)?.flatten() {
        let Ok(ft) = stamp_entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let stamp = stamp_entry.file_name().to_string_lossy().to_string();
        if validate_stamp(&stamp).is_err() {
            continue;
        }
        let stamp_dir = stamp_entry.path();
        for e in WalkDir::new(&stamp_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !e.file_type().is_file() {
                continue;
            }
            let Ok(rel) = e.path().strip_prefix(&stamp_dir) else { continue };
            let Some(rel_path) = to_slash(rel) else { continue };
            let meta = e.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(TrashCopy {
                stamp: stamp.clone(),
                rel_path,
                bytes: meta.map(|m| m.len()).unwrap_or(0),
                modified,
            });
        }
    }
    out.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| b.stamp.cmp(&a.stamp))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    out.truncate(MAX_LISTED);
    Ok(out)
}

pub fn read_copy(vault: &Path, stamp: &str, rel: &str) -> AppResult<String> {
    let abs = resolve_copy(vault, stamp, rel)?;
    let meta = fs::symlink_metadata(&abs).map_err(|_| AppError::new("recovery copy not found"))?;
    if !meta.is_file() {
        return Err(AppError::new("recovery copy is not a file"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AppError::new("recovery copy is too large to open"));
    }
    let bytes = fs::read(&abs)?;
    String::from_utf8(bytes).map_err(|_| AppError::new("recovery copy is not text"))
}

/// Delete one copy, then any stamp directories it leaves empty. The trash root
/// itself always survives.
pub fn delete_copy(vault: &Path, stamp: &str, rel: &str) -> AppResult<()> {
    let abs = resolve_copy(vault, stamp, rel)?;
    let meta = fs::symlink_metadata(&abs).map_err(|_| AppError::new("recovery copy not found"))?;
    if !meta.is_file() {
        return Err(AppError::new("recovery copy is not a file"));
    }
    fs::remove_file(&abs)?;
    let stamp_dir = vault.join(TRASH_DIR).join(stamp);
    let mut dir = abs.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if !d.starts_with(&stamp_dir) {
            break;
        }
        // `remove_dir` only removes an EMPTY directory; the first refusal ends it.
        if fs::remove_dir(&d).is_err() {
            break;
        }
        if d == stamp_dir {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Ok(())
}

fn open_vault(state: &State<'_, AppState>, expected_epoch: Option<u64>) -> AppResult<PathBuf> {
    let inner = state.inner.lock().unwrap();
    if let Some(e) = expected_epoch {
        if e != inner.vault_epoch {
            return Err(AppError::new(format!(
                "{}: caller pinned vault epoch {e}, but epoch {} is open",
                crate::commands::VAULT_MISMATCH,
                inner.vault_epoch
            )));
        }
    }
    inner
        .vault
        .clone()
        .ok_or_else(|| AppError::new("no vault is open"))
}

#[tauri::command]
pub async fn list_trash_copies(
    state: State<'_, AppState>,
    expected_epoch: Option<u64>,
) -> AppResult<Vec<TrashCopy>> {
    let vault = open_vault(&state, expected_epoch)?;
    list_copies(&vault)
}

#[tauri::command]
pub async fn read_trash_copy(
    state: State<'_, AppState>,
    stamp: String,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<String> {
    let vault = open_vault(&state, expected_epoch)?;
    read_copy(&vault, &stamp, &rel_path)
}

#[tauri::command]
pub async fn delete_trash_copy(
    state: State<'_, AppState>,
    stamp: String,
    rel_path: String,
    expected_epoch: Option<u64>,
) -> AppResult<()> {
    let vault = open_vault(&state, expected_epoch)?;
    delete_copy(&vault, &stamp, &rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with_copy() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join(".context/trash/2026-09-26T10-00-00-000Z/Team");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("plan.md"), "kept text").unwrap();
        fs::write(tmp.path().join("secret.md"), "not trash").unwrap();
        tmp
    }

    const STAMP: &str = "2026-09-26T10-00-00-000Z";

    #[test]
    fn lists_reads_and_deletes_a_copy() {
        let tmp = vault_with_copy();
        let list = list_copies(tmp.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].stamp, STAMP);
        assert_eq!(list[0].rel_path, "Team/plan.md");
        assert_eq!(list[0].bytes, 9);
        assert_eq!(read_copy(tmp.path(), STAMP, "Team/plan.md").unwrap(), "kept text");
        delete_copy(tmp.path(), STAMP, "Team/plan.md").unwrap();
        assert!(list_copies(tmp.path()).unwrap().is_empty());
        // The emptied stamp directory goes; the trash root stays.
        assert!(!tmp.path().join(".context/trash").join(STAMP).exists());
        assert!(tmp.path().join(".context/trash").is_dir());
    }

    #[test]
    fn an_absent_trash_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_copies(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let tmp = vault_with_copy();
        let v = tmp.path();
        for rel in ["../../secret.md", "Team/../../../secret.md", "/etc/passwd", "", "a\\..\\b.md", "./x.md"] {
            assert!(read_copy(v, STAMP, rel).is_err(), "{rel:?} must be refused");
            assert!(delete_copy(v, STAMP, rel).is_err(), "{rel:?} must be refused");
        }
        for stamp in ["..", "../..", ".hidden", "", "a/b", "a\\b"] {
            assert!(read_copy(v, stamp, "Team/plan.md").is_err(), "stamp {stamp:?} must be refused");
        }
        assert!(v.join("secret.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_inside_the_trash() {
        let tmp = vault_with_copy();
        let v = tmp.path();
        let stamp_dir = v.join(".context/trash").join(STAMP);
        std::os::unix::fs::symlink(v.join("secret.md"), stamp_dir.join("link.md")).unwrap();
        assert!(read_copy(v, STAMP, "link.md").is_err());
        assert!(delete_copy(v, STAMP, "link.md").is_err());
        assert!(v.join("secret.md").exists());
        // A link is never listed as a copy.
        assert!(list_copies(v).unwrap().iter().all(|c| c.rel_path != "link.md"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_linked_trash_root() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::create_dir_all(elsewhere.path().join("s1")).unwrap();
        fs::write(elsewhere.path().join("s1/x.md"), "x").unwrap();
        fs::create_dir_all(tmp.path().join(".context")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), tmp.path().join(".context/trash")).unwrap();
        assert!(list_copies(tmp.path()).is_err());
        assert!(read_copy(tmp.path(), "s1", "x.md").is_err());
        assert!(delete_copy(tmp.path(), "s1", "x.md").is_err());
        assert!(elsewhere.path().join("s1/x.md").exists());
    }

    #[test]
    fn deleting_one_copy_keeps_its_siblings() {
        let tmp = vault_with_copy();
        let d = tmp.path().join(".context/trash").join(STAMP).join("Team");
        fs::write(d.join("other.md"), "o").unwrap();
        delete_copy(tmp.path(), STAMP, "Team/plan.md").unwrap();
        assert!(d.join("other.md").exists());
    }
}
