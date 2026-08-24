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

/// Create a folder if it isn't already there, including missing parents.
///
/// Distinct from `create_folder`, which fails when the target exists — that's the
/// right behaviour for "New Folder" (the user should not silently land in an
/// existing one) and the wrong behaviour for reconciliation, which runs on every
/// registry change and must be a no-op the second time. Sniffing
/// `create_folder`'s error string across the IPC boundary to tell "already there"
/// from a real failure is how idempotency quietly breaks.
pub fn ensure_folder(vault: &Path, rel: &str) -> AppResult<()> {
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new("refusing to create a folder in an ignored dir"));
    }
    let abs = resolve_in_vault(vault, rel)?;
    std::fs::create_dir_all(&abs)?;
    Ok(())
}

/// Move a note OUT of the note pipeline into `.context/trash/<stamp>/<rel>`
/// rather than deleting it. Returns the trash-relative destination.
///
/// Why `.context` and not the OS trash: `vault::IGNORED_DIRS` keeps `.context` out
/// of the tree walk, the watcher and the index, so a trashed note is recoverable
/// by hand but can never be re-registered. A file restored from the OS trash lands
/// back at its original path, where the watcher indexes it under a FRESH doc_id and
/// the registry pushes it up as a brand-new note — resurrecting something the team
/// deliberately deleted. Invisible-to-the-walk is the property doing the work here.
///
/// `stamp` comes from the caller: there's no date crate in this binary, and one
/// stamp per reconciliation pass keeps a multi-note delete together in one folder.
pub fn trash_note(vault: &Path, rel: &str, stamp: &str) -> AppResult<String> {
    // The stamp is joined into a path, so it must be exactly one ordinary segment.
    if stamp.is_empty()
        || stamp.starts_with('.')
        || !stamp
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(AppError::new("invalid trash stamp"));
    }
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new("refusing to trash a path inside an ignored dir"));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Err(AppError::new("path does not exist"));
    }
    // Folders are hard-deleted server-side with no tombstone, so an inbound folder
    // delete is undecidable and never attempted. Refuse loudly rather than let a
    // caller discover that by removing a subtree.
    if abs.is_dir() {
        return Err(AppError::new("refusing to trash a directory"));
    }
    let dest_rel = unique_trash_dest(vault, &format!(".context/trash/{stamp}/{rel}"))?;
    let dest = resolve_in_vault(vault, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Same filesystem by construction (.context lives inside the vault), so this
    // rename is atomic. A failure propagates and the caller leaves the file alone,
    // which is the safe outcome.
    std::fs::rename(&abs, &dest)?;
    Ok(dest_rel)
}

/// `x.md` → `x (2).md` when the destination inside this stamp is already taken.
fn unique_trash_dest(vault: &Path, rel: &str) -> AppResult<String> {
    if !resolve_in_vault(vault, rel)?.exists() {
        return Ok(rel.to_string());
    }
    let (stem, ext) = match rel.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (rel.to_string(), String::new()),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !resolve_in_vault(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::new("could not find a free name in the trash"))
}

/// Remove a directory ONLY if it is empty by now. Returns whether it was
/// removed; anything still inside (an unconfirmed note, a stray image, a new
/// local file) keeps the folder alive, which is the safe outcome.
///
/// This is the executor for an inbound folder delete: the server tombstones a
/// deleted folder by id, the notes inside leave via their own tombstones, and
/// then this unwinds the emptied directories bottom-up. Deliberately never
/// recursive — `remove_dir`, not `remove_dir_all` — so it can only ever take
/// away a folder that holds nothing.
pub fn delete_folder_if_empty(vault: &Path, rel: &str) -> AppResult<bool> {
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new("refusing to touch an ignored dir"));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Ok(true); // already gone — the goal state
    }
    if !abs.is_dir() {
        return Ok(false); // a file lives at this path; not ours to remove
    }
    // Any failure (non-empty, permissions, races) means "leave it": a folder
    // that lingers is cosmetic, a reconcile pass that fails over it is not.
    Ok(std::fs::remove_dir(&abs).is_ok())
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

    // ---- trash / ensure_folder --------------------------------------------
    //
    // `trash_note` is how a remote delete is applied locally, so it is the only
    // inbound operation that takes a file away from the user. It has to be
    // recoverable, and it must never be talked into touching anything else.

    #[test]
    fn trash_moves_the_note_into_context_and_leaves_no_source() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Notes/bye.md", "real content").unwrap();
        let dest = trash_note(tmp.path(), "Notes/bye.md", "2026-08-07").unwrap();
        assert_eq!(dest, ".context/trash/2026-08-07/Notes/bye.md");
        assert!(!tmp.path().join("Notes/bye.md").exists());
        // Recoverable: the bytes are still there, just outside the note pipeline
        // (`.context` is skipped by the walker, watcher and index, which is what
        // stops a trashed note being re-registered as a ghost).
        let moved = std::fs::read_to_string(tmp.path().join(dest)).unwrap();
        assert_eq!(moved, "real content");
    }

    #[test]
    fn trash_disambiguates_a_collision_within_one_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "first").unwrap();
        assert_eq!(
            trash_note(tmp.path(), "a.md", "s1").unwrap(),
            ".context/trash/s1/a.md"
        );
        write_note(tmp.path(), "a.md", "second").unwrap();
        assert_eq!(
            trash_note(tmp.path(), "a.md", "s1").unwrap(),
            ".context/trash/s1/a (2).md"
        );
        // Neither copy was overwritten.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".context/trash/s1/a.md")).unwrap(),
            "first"
        );
    }

    #[test]
    fn trash_refuses_a_directory() {
        // Folders are hard-deleted server-side with no tombstone, so an inbound
        // folder delete is undecidable and never attempted. Fail loudly rather
        // than let a caller discover that by losing a subtree.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Folder")).unwrap();
        assert!(trash_note(tmp.path(), "Folder", "s1").is_err());
        assert!(tmp.path().join("Folder").exists());
    }

    #[test]
    fn trash_refuses_a_path_already_inside_context() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".context")).unwrap();
        std::fs::write(tmp.path().join(".context/config.json"), "{}").unwrap();
        assert!(trash_note(tmp.path(), ".context/config.json", "s1").is_err());
        assert!(tmp.path().join(".context/config.json").exists());
    }

    #[test]
    fn trash_rejects_a_stamp_that_is_not_one_plain_segment() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "x").unwrap();
        for bad in ["", "a/b", "../..", ".hidden", "a b"] {
            assert!(trash_note(tmp.path(), "a.md", bad).is_err(), "stamp {bad:?}");
        }
        // Nothing was moved by any of the rejected attempts.
        assert!(tmp.path().join("a.md").exists());
    }

    #[test]
    fn trash_rejects_traversal_and_a_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(trash_note(tmp.path(), "../escape.md", "s1").is_err());
        assert!(trash_note(tmp.path(), "nope.md", "s1").is_err());
    }

    #[test]
    fn ensure_folder_is_idempotent_and_makes_parents() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_folder(tmp.path(), "A/B/C").unwrap();
        assert!(tmp.path().join("A/B/C").is_dir());
        // Unlike `create_folder`, a second call is a no-op rather than an error —
        // reconciliation runs on every registry change.
        ensure_folder(tmp.path(), "A/B/C").unwrap();
    }

    #[test]
    fn ensure_folder_refuses_ignored_dirs_and_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(ensure_folder(tmp.path(), ".context/evil").is_err());
        assert!(ensure_folder(tmp.path(), "node_modules/x").is_err());
        assert!(ensure_folder(tmp.path(), "../up").is_err());
    }

    #[test]
    fn delete_folder_if_empty_is_empty_only() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_folder(tmp.path(), "A/B").unwrap();
        std::fs::write(tmp.path().join("A/B/keep.md"), "content").unwrap();
        // Non-empty: stays, reported as not removed.
        assert!(!delete_folder_if_empty(tmp.path(), "A/B").unwrap());
        assert!(tmp.path().join("A/B").is_dir());
        // Emptied: removed, bottom-up.
        std::fs::remove_file(tmp.path().join("A/B/keep.md")).unwrap();
        assert!(delete_folder_if_empty(tmp.path(), "A/B").unwrap());
        assert!(delete_folder_if_empty(tmp.path(), "A").unwrap());
        assert!(!tmp.path().join("A").exists());
        // Already gone is the goal state, not an error.
        assert!(delete_folder_if_empty(tmp.path(), "A").unwrap());
        // A FILE at the path is not ours to remove.
        std::fs::write(tmp.path().join("f.md"), "x").unwrap();
        assert!(!delete_folder_if_empty(tmp.path(), "f.md").unwrap());
        assert!(tmp.path().join("f.md").exists());
        // Ignored dirs and traversal are refused loudly.
        assert!(delete_folder_if_empty(tmp.path(), ".context/trash").is_err());
        assert!(delete_folder_if_empty(tmp.path(), "../up").is_err());
    }
}
