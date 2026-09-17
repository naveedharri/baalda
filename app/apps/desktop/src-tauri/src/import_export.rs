//! Import external files/folders into the vault and export vault content back
//! out to arbitrary locations on disk. Rust owns all disk I/O; every in-vault
//! destination is validated with `vault::resolve_in_vault` (traversal-rejected)
//! and every write is atomic (temp file + rename), exactly like `notefile` and
//! `attachments`.
//!
//! Import rules:
//! - every file type is copied into the chosen destination folder with its own
//!   name and extension, structure preserved — nothing is ever rerouted into
//!   `attachments/` (that directory is only for what the app itself writes
//!   there: pasted/dropped bytes, see `attachments.rs`);
//! - `.markdown` is normalized to `.md`, because the two are the same format
//!   under two names. `.txt` is NOT: it is its own note-family member now
//!   (`vault::NOTE_EXTS`), it opens in the editor and it indexes, so renaming a
//!   user's file on the way in would only lose information;
//! - name clashes are auto-renamed (` 2`, ` 3`, …) so import never overwrites
//!   or errors on an existing file;
//! - dotfiles and `.context`/`.git` are always skipped. Files whose extension is
//!   not in `vault::ALLOWED_EXTS` are copied but will not surface in the tree.
//! Per-item failures are collected into the summary, never fatal.

use crate::error::{AppError, AppResult};
use crate::vault::{is_ignored_name, resolve_in_vault};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Outcome of an import, surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Vault-relative paths of the created top-level items (notes/folders),
    /// so the UI can focus/refresh them.
    pub imported: Vec<String>,
    /// Total files copied (including nested files and attachments).
    pub files: usize,
    /// Files/dirs skipped (ignored names, unreadable sources, etc.).
    pub skipped: usize,
}

enum Kind {
    Note,
    Html,
    Other,
}

fn classify(name: &str) -> Kind {
    match ext_lower(name).as_str() {
        // Markdown under its two spellings, and nothing else. `.txt` used to be
        // here and was rewritten to `.md`; it is a note in its own right now.
        "md" | "markdown" => Kind::Note,
        "html" | "htm" => Kind::Html,
        _ => Kind::Other,
    }
}

fn ext_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// File name after note-extension normalization (`.markdown` → `.md`).
fn normalized_name(name: &str) -> String {
    match classify(name) {
        Kind::Note => {
            let stem = match name.rfind('.') {
                Some(i) if i > 0 => &name[..i],
                _ => name,
            };
            format!("{stem}.md")
        }
        _ => name.to_string(),
    }
}

fn join_rel(parent: &str, name: &str) -> String {
    let p = parent.trim_matches('/');
    if p.is_empty() {
        name.to_string()
    } else {
        format!("{p}/{name}")
    }
}

/// A vault-relative path under `parent_rel` that doesn't already exist,
/// inserting ` N` before the extension (files) or after the name (dirs).
fn unique_rel(vault: &Path, parent_rel: &str, name: &str, is_dir: bool) -> AppResult<String> {
    let (stem, ext) = if is_dir {
        (name.to_string(), String::new())
    } else {
        match name.rfind('.') {
            Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
            _ => (name.to_string(), String::new()),
        }
    };
    for i in 0..10_000 {
        // First clash becomes " 2" (Finder-style: the original is the implicit 1).
        let candidate = if i == 0 {
            name.to_string()
        } else {
            format!("{stem} {}{ext}", i + 1)
        };
        let rel = join_rel(parent_rel, &candidate);
        let abs = resolve_in_vault(vault, &rel)?;
        if !abs.exists() {
            return Ok(rel);
        }
    }
    Err(AppError::new("could not find a free name"))
}

/// Atomic byte write to a vault-relative path (temp + rename), creating parents.
fn atomic_write(vault: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    let abs = resolve_in_vault(vault, rel)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("destination has no parent directory"))?;
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

/// Copy one source file into `parent_rel` under `target_name` (already
/// normalized), auto-renaming on clash. Returns the created rel path.
fn copy_file_to(
    vault: &Path,
    parent_rel: &str,
    src_abs: &Path,
    target_name: &str,
    s: &mut ImportSummary,
) -> AppResult<String> {
    let rel = unique_rel(vault, parent_rel, target_name, false)?;
    let bytes = std::fs::read(src_abs)?;
    atomic_write(vault, &rel, &bytes)?;
    s.files += 1;
    Ok(rel)
}

/// Import a single loose file into `dest_rel`, keeping its name and extension
/// (only `.markdown` is normalized). Nothing is rerouted.
fn import_one_file(
    vault: &Path,
    dest_rel: &str,
    src_abs: &Path,
    s: &mut ImportSummary,
) -> AppResult<String> {
    let name = src_abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    if is_ignored_name(name) {
        return Err(AppError::new("ignored file"));
    }
    // Everything imports into the target dir, keeping its real name/extension;
    // only `.markdown` is normalized to `.md`. Nothing is rerouted, so imported
    // files of any type stay put and show in the sidebar.
    let target = normalized_name(name);
    copy_file_to(vault, dest_rel, src_abs, &target, s)
}

/// Recursively copy the *contents* of `src_dir` into the (already-unique)
/// vault-relative `dest_rel`, preserving structure. Note extensions are
/// normalized; everything else (images, etc.) is copied as-is in place.
fn copy_dir_contents(
    vault: &Path,
    dest_rel: &str,
    src_dir: &Path,
    s: &mut ImportSummary,
) -> AppResult<()> {
    for entry in std::fs::read_dir(src_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            s.skipped += 1;
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            let child_rel = join_rel(dest_rel, &name);
            std::fs::create_dir_all(resolve_in_vault(vault, &child_rel)?)?;
            copy_dir_contents(vault, &child_rel, &path, s)?;
        } else if ft.is_file() {
            let target = normalized_name(&name);
            if copy_file_to(vault, dest_rel, &path, &target, s).is_err() {
                s.skipped += 1;
            }
        } else {
            s.skipped += 1;
        }
    }
    Ok(())
}

/// Import a single source directory as a new (auto-renamed) folder under
/// `dest_rel`, preserving its structure. Returns the new folder's rel path.
fn import_one_dir(
    vault: &Path,
    dest_rel: &str,
    src_dir: &Path,
    s: &mut ImportSummary,
) -> AppResult<String> {
    let base = src_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::new("invalid folder name"))?;
    if is_ignored_name(base) {
        return Err(AppError::new("ignored folder"));
    }
    let root_rel = unique_rel(vault, dest_rel, base, true)?;
    std::fs::create_dir_all(resolve_in_vault(vault, &root_rel)?)?;
    copy_dir_contents(vault, &root_rel, src_dir, s)?;
    Ok(root_rel)
}

/// The unified import entry point used by pick-files, pick-folder, and
/// drag-and-drop. `sources` are absolute host paths (files and/or dirs mixed).
pub fn import_paths(vault: &Path, dest_rel: &str, sources: &[String]) -> ImportSummary {
    let mut s = ImportSummary::default();
    for src in sources {
        let src_abs = Path::new(src);
        match src_abs.metadata() {
            Ok(m) if m.is_dir() => match import_one_dir(vault, dest_rel, src_abs, &mut s) {
                Ok(rel) => s.imported.push(rel),
                Err(_) => s.skipped += 1,
            },
            Ok(m) if m.is_file() => match import_one_file(vault, dest_rel, src_abs, &mut s) {
                Ok(rel) => s.imported.push(rel),
                Err(_) => s.skipped += 1,
            },
            _ => s.skipped += 1,
        }
    }
    s
}

/// Recursively copy the contents of `src_dir` to `dest_dir`, skipping ignored
/// names (`.context`/`.git`/dotfiles). Used by export.
fn export_dir_contents(src_dir: &Path, dest_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dest_dir)?;
    for entry in std::fs::read_dir(src_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        let target = dest_dir.join(&name);
        if ft.is_dir() {
            export_dir_contents(&path, &target)?;
        } else if ft.is_file() {
            std::fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

/// Export a note, a folder subtree, or the whole vault (`rel == ""`) to `dest`.
/// For a directory source, `dest` is a destination *directory* and the export
/// lands in `dest/<basename>`. For a single file, `dest` is the exact target
/// path (from the Save dialog).
pub fn export_path(vault: &Path, rel: &str, dest: &str) -> AppResult<()> {
    let dest_abs = Path::new(dest);
    let src = if rel.is_empty() {
        vault.to_path_buf()
    } else {
        resolve_in_vault(vault, rel)?
    };
    let meta = src
        .metadata()
        .map_err(|_| AppError::new("source path does not exist"))?;
    if meta.is_dir() {
        let base = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("export");
        export_dir_contents(&src, &dest_abs.join(base))?;
    } else {
        if let Some(p) = dest_abs.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(&src, dest_abs)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn imports_single_note_and_normalizes_extension() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let src = ext.path().join("Idea.markdown");
        write(&src, b"# hello");

        let s = import_paths(
            vault.path(),
            "",
            &[src.to_string_lossy().to_string()],
        );
        assert_eq!(s.files, 1);
        assert_eq!(s.imported, vec!["Idea.md"]);
        assert!(vault.path().join("Idea.md").is_file());
    }

    /// `.txt` is a note in its own right (`vault::NOTE_EXTS`): it opens in the
    /// editor and it indexes, so import must leave it alone. Renaming it to
    /// `.md` used to be the only way it became openable — and it silently
    /// changed the user's file name to do it.
    #[test]
    fn imports_txt_without_renaming_it_to_md() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let src = ext.path().join("Idea.txt");
        write(&src, b"plain text");

        let s = import_paths(vault.path(), "", &[src.to_string_lossy().to_string()]);
        assert_eq!(s.files, 1);
        assert_eq!(s.imported, vec!["Idea.txt"]);
        assert!(vault.path().join("Idea.txt").is_file());
        assert!(!vault.path().join("Idea.md").exists());
    }

    #[test]
    fn imports_html_as_is() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let src = ext.path().join("page.html");
        write(&src, b"<h1>hi</h1>");
        let s = import_paths(vault.path(), "Docs", &[src.to_string_lossy().to_string()]);
        assert_eq!(s.imported, vec!["Docs/page.html"]);
        assert!(vault.path().join("Docs/page.html").is_file());
    }

    #[test]
    fn imports_any_file_into_target_dir_as_is() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        // A binary and a code file both land in the chosen dir, unchanged.
        let png = ext.path().join("logo.png");
        write(&png, &[0x89, 0x50]);
        let js = ext.path().join("app.js");
        write(&js, b"console.log(1)");
        let s = import_paths(
            vault.path(),
            "Notes",
            &[png.to_string_lossy().to_string(), js.to_string_lossy().to_string()],
        );
        assert_eq!(s.imported, vec!["Notes/logo.png", "Notes/app.js"]);
        assert!(vault.path().join("Notes/logo.png").is_file());
        assert!(vault.path().join("Notes/app.js").is_file());
    }

    #[test]
    fn auto_renames_on_clash() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("Idea.md"), b"existing").unwrap();
        let ext = tempfile::tempdir().unwrap();
        let src = ext.path().join("Idea.md");
        write(&src, b"new");
        let s = import_paths(vault.path(), "", &[src.to_string_lossy().to_string()]);
        assert_eq!(s.imported, vec!["Idea 2.md"]);
        assert!(vault.path().join("Idea 2.md").is_file());
        // Original untouched.
        assert_eq!(
            std::fs::read_to_string(vault.path().join("Idea.md")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn imports_folder_preserving_structure_and_skipping_ignored() {
        let vault = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let root = ext.path().join("Project");
        write(&root.join("a.md"), b"a");
        write(&root.join("sub/b.markdown"), b"b");
        write(&root.join("sub/img.png"), &[1, 2, 3]);
        write(&root.join(".git/config"), b"junk");
        write(&root.join(".DS_Store"), b"junk");

        let s = import_paths(vault.path(), "", &[root.to_string_lossy().to_string()]);
        assert_eq!(s.imported, vec!["Project"]);
        assert!(vault.path().join("Project/a.md").is_file());
        // .markdown normalized to .md
        assert!(vault.path().join("Project/sub/b.md").is_file());
        // image kept in place (structure preserved, NOT rerouted to attachments/)
        assert!(vault.path().join("Project/sub/img.png").is_file());
        // ignored names skipped
        assert!(!vault.path().join("Project/.git").exists());
        assert!(!vault.path().join("Project/.DS_Store").exists());
        assert_eq!(s.files, 3);
    }

    #[test]
    fn folder_import_auto_renames_root() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("Project")).unwrap();
        let ext = tempfile::tempdir().unwrap();
        let root = ext.path().join("Project");
        write(&root.join("a.md"), b"a");
        let s = import_paths(vault.path(), "", &[root.to_string_lossy().to_string()]);
        assert_eq!(s.imported, vec!["Project 2"]);
        assert!(vault.path().join("Project 2/a.md").is_file());
    }

    #[test]
    fn export_single_note_to_exact_path() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("note.md"), b"body").unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("exported.md");
        export_path(vault.path(), "note.md", &dest.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "body");
    }

    #[test]
    fn export_folder_nests_under_dest_and_skips_context() {
        let vault = tempfile::tempdir().unwrap();
        write(&vault.path().join("Folder/a.md"), b"a");
        write(&vault.path().join("Folder/sub/b.md"), b"b");
        write(&vault.path().join(".context/index.sqlite"), b"db");
        write(&vault.path().join("Folder/.context/x"), b"junk");
        let out = tempfile::tempdir().unwrap();
        export_path(vault.path(), "Folder", &out.path().to_string_lossy()).unwrap();
        assert!(out.path().join("Folder/a.md").is_file());
        assert!(out.path().join("Folder/sub/b.md").is_file());
        assert!(!out.path().join("Folder/.context").exists());
    }

    #[test]
    fn export_whole_vault_excludes_context() {
        let vault = tempfile::tempdir().unwrap();
        write(&vault.path().join("a.md"), b"a");
        write(&vault.path().join(".context/index.sqlite"), b"db");
        let out = tempfile::tempdir().unwrap();
        export_path(vault.path(), "", &out.path().to_string_lossy()).unwrap();
        // Nested under the vault's own dir name.
        let base = vault.path().file_name().unwrap().to_string_lossy().to_string();
        assert!(out.path().join(&base).join("a.md").is_file());
        assert!(!out.path().join(&base).join(".context").exists());
    }

    #[test]
    fn import_rejects_nothing_but_reports_missing_sources() {
        let vault = tempfile::tempdir().unwrap();
        let s = import_paths(vault.path(), "", &["/no/such/path".to_string()]);
        assert_eq!(s.skipped, 1);
        assert_eq!(s.files, 0);
    }
}
