//! Filesystem mutations. Rust owns all disk I/O; every path is validated to
//! stay inside the vault before touching the filesystem. Writes are atomic
//! (temp file + rename) so a crash mid-save never truncates a note.

use crate::error::{AppError, AppResult};
use crate::vault::resolve_in_vault;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Read a `.md` note to a string (vault-relative path).
pub fn read_note(vault: &Path, rel: &str) -> AppResult<String> {
    let abs = resolve_in_vault(vault, rel)?;
    Ok(std::fs::read_to_string(&abs)?)
}

/// Atomic write: write to a temp file in the same dir, then rename over the
/// target so readers never observe a half-written file.
pub fn write_note(vault: &Path, rel: &str, content: &str) -> AppResult<()> {
    let abs = resolve_in_vault(vault, rel)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("note has no parent directory"))?;
    std::fs::create_dir_all(parent)?;

    let file_name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    let tmp = parent.join(format!(".{file_name}.tmp"));

    std::fs::write(&tmp, content.as_bytes())?;
    // rename is atomic on the same filesystem.
    std::fs::rename(&tmp, &abs)?;
    Ok(())
}

/// Write a note ONLY if nothing is there yet. Returns true when the file was
/// created, false when it already existed (left byte-for-byte untouched).
///
/// This exists for one caller — the registry materializing a server-only note as
/// an empty placeholder — and for one reason. That caller decides "the server has
/// this note, this device doesn't" from a *list*, and if the list is ever wrong
/// the plain [`write_note`] turns the mistake into silent, unrecoverable data
/// loss: an empty atomic overwrite of a note full of content. It has happened
/// (428 notes, from a lazily-loaded tree the caller mistook for the whole vault).
/// A create-only write makes that class of bug cost nothing.
///
/// `exists()` + write is not atomic, but it does not need to be: the only writer
/// that races here is the same app, and the failure mode this guards against is a
/// wrong *decision*, not a concurrent one.
pub fn write_note_if_missing(vault: &Path, rel: &str, content: &str) -> AppResult<bool> {
    let abs = resolve_in_vault(vault, rel)?;
    if abs.exists() {
        return Ok(false);
    }
    write_note(vault, rel, content)?;
    Ok(true)
}

/// Create a new empty note. `parent_rel` is "" for the vault root. Returns the
/// new note's vault-relative path. Fails if it already exists.
pub fn create_note(vault: &Path, parent_rel: &str, name: &str) -> AppResult<String> {
    let name = ensure_md_extension(name)?;
    let rel = join_rel(parent_rel, &name);
    let abs = resolve_in_vault(vault, &rel)?;
    if abs.exists() {
        return Err(AppError::new("a note with that name already exists"));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Seed with an H1 of the title so the note isn't empty.
    let stem = name.trim_end_matches(".md");
    std::fs::write(&abs, format!("# {stem}\n\n"))?;
    Ok(rel)
}

/// Create a new folder. Returns its vault-relative path.
pub fn create_folder(vault: &Path, parent_rel: &str, name: &str) -> AppResult<String> {
    let rel = join_rel(parent_rel, name);
    let abs = resolve_in_vault(vault, &rel)?;
    if abs.exists() {
        return Err(AppError::new("a folder with that name already exists"));
    }
    std::fs::create_dir_all(&abs)?;
    Ok(rel)
}

/// Rename/move a file or folder within the vault. Returns the new rel path.
pub fn rename_path(vault: &Path, old_rel: &str, new_rel: &str) -> AppResult<String> {
    let old_abs = resolve_in_vault(vault, old_rel)?;
    let new_abs = resolve_in_vault(vault, new_rel)?;
    if !old_abs.exists() {
        return Err(AppError::new("source path does not exist"));
    }
    if new_abs.exists() {
        return Err(AppError::new("destination already exists"));
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&old_abs, &new_abs)?;
    Ok(new_rel.trim_start_matches('/').to_string())
}

/// Delete a file or folder (recursively for folders).
pub fn delete_path(vault: &Path, rel: &str) -> AppResult<()> {
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Ok(());
    }
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs)?;
    } else {
        std::fs::remove_file(&abs)?;
    }
    Ok(())
}

/// Hex-encoded SHA-256 of a note's content (echo-suppression aid for the index).
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn ensure_md_extension(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new("name cannot be empty"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::new("name cannot contain path separators"));
    }
    if name.to_lowercase().ends_with(".md") {
        Ok(name.to_string())
    } else {
        Ok(format!("{name}.md"))
    }
}

fn join_rel(parent_rel: &str, name: &str) -> String {
    let parent = parent_rel.trim_matches('/');
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_and_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a/b/note.md", "hello world").unwrap();
        let got = read_note(tmp.path(), "a/b/note.md").unwrap();
        assert_eq!(got, "hello world");
        // No leftover temp file.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path().join("a/b"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_note_if_missing_creates_but_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();

        // Creates, parents and all.
        assert!(write_note_if_missing(tmp.path(), "Context/brand/kit.md", "").unwrap());
        assert_eq!(read_note(tmp.path(), "Context/brand/kit.md").unwrap(), "");

        // A real note is then written there by the user.
        write_note(tmp.path(), "Context/brand/kit.md", "# Brand kit\n\nreal content").unwrap();

        // Materializing it again — the exact call that emptied 428 notes when it
        // was a plain write — reports "already there" and changes nothing.
        assert!(!write_note_if_missing(tmp.path(), "Context/brand/kit.md", "").unwrap());
        assert_eq!(
            read_note(tmp.path(), "Context/brand/kit.md").unwrap(),
            "# Brand kit\n\nreal content"
        );
    }

    #[test]
    fn write_note_if_missing_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_note_if_missing(tmp.path(), "../escape.md", "x").is_err());
    }

    #[test]
    fn write_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_note(tmp.path(), "../escape.md", "x").is_err());
    }

    #[test]
    fn create_note_adds_md_and_refuses_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let rel = create_note(tmp.path(), "", "My Note").unwrap();
        assert_eq!(rel, "My Note.md");
        assert!(create_note(tmp.path(), "", "My Note").is_err());
    }

    #[test]
    fn rename_moves_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "x").unwrap();
        rename_path(tmp.path(), "a.md", "sub/b.md").unwrap();
        assert!(!tmp.path().join("a.md").exists());
        assert!(tmp.path().join("sub/b.md").exists());
    }

    #[test]
    fn sha_is_stable() {
        assert_eq!(sha256_hex("abc"), sha256_hex("abc"));
        assert_ne!(sha256_hex("abc"), sha256_hex("abd"));
    }
}
