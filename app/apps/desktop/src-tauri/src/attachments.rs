//! Binary attachment I/O under the vault's `attachments/` dir (spec 02 §2).
//! Path-validated (traversal-rejected) like all other disk access; writes are
//! atomic (temp file + rename). Attachments are NEVER fed into the note/CRDT
//! pipeline — this module only reads/writes raw bytes and lists metadata.

use crate::error::{AppError, AppResult};
use crate::vault::{is_ignored_name, resolve_in_vault};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

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

/// Read a binary file at a vault-relative path.
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

/// Atomic write of raw bytes: temp file in the same dir, then rename over the
/// target so readers never observe a half-written file. Creates parent dirs.
pub fn write_binary_file(vault: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    ensure_attachment_rel(rel)?;
    let abs = resolve_in_vault(vault, rel)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("attachment has no parent directory"))?;
    std::fs::create_dir_all(parent)?;

    let file_name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    let tmp = parent.join(format!(".{file_name}.tmp"));

    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &abs)?;
    Ok(())
}

/// List every file under the vault's `attachments/` dir (recursively), skipping
/// dotfiles/dotfolders. Returns an empty list if the dir is absent.
pub fn list_attachments(vault: &Path) -> AppResult<Vec<AttachmentMeta>> {
    let root = vault.join("attachments");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    walk(vault, &root, &mut out)?;
    // Deterministic order (stable diffs, stable tests).
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn walk(vault: &Path, dir: &Path, out: &mut Vec<AttachmentMeta>) -> AppResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue; // skip dotfiles / .context / .git and our .*.tmp writes
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk(vault, &path, out)?;
        } else if file_type.is_file() {
            let bytes = std::fs::read(&path)?;
            out.push(AttachmentMeta {
                rel_path: rel_from(vault, &path),
                size: bytes.len() as u64,
                sha256: sha256_bytes(&bytes),
            });
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

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
