//! Vault path helpers: safe resolution of vault-relative paths (traversal
//! rejection) and the rules for what the note pipeline ignores.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Names that are never walked into the note pipeline (spec 02 §2 hard rule).
/// `.context` holds the derived index and CRDT store; it must never fork into
/// the note pipeline.
pub const IGNORED_DIRS: &[&str] = &[".context", ".git"];

/// Heavy build/dependency directories we never walk or sync (on top of dotfiles
/// and `IGNORED_DIRS`). Without this, importing a project folder floods the
/// vault with thousands of files (e.g. a stray `node_modules`). Dot-prefixed
/// variants like `.next`/`.cache`/`.venv` are already covered by the dotfile rule.
pub const DENIED_DIRS: &[&str] = &["node_modules", "dist", "build", "target", "vendor", "__pycache__", "venv"];

/// Allowlist of file extensions the vault surfaces + syncs (lowercase, no dot).
/// Everything else — source code, lockfiles, binaries — is ignored, so importing
/// a real project directory can't dump junk into the workspace.
pub const ALLOWED_EXTS: &[&str] = &[
    // notes / text
    "md", "markdown", "mdx", "txt", "html", "htm", "canvas",
    // images
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif",
    // documents
    "pdf",
];

/// True if a directory/file name should be skipped by the tree walk & watcher.
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name) || DENIED_DIRS.contains(&name)
}

/// True if a file (by name) is an allowed, surfaceable type per `ALLOWED_EXTS`.
/// Files with no extension, or an extension not on the list, are not surfaced.
pub fn is_allowed_file(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            ALLOWED_EXTS.contains(&ext.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// True if `dir` already looks like a vault: it has our `.context/` index, or it
/// directly contains at least one markdown note. The vault picker uses this to
/// offer "open it instead" rather than silently creating a nested empty vault
/// inside a folder the user already uses as a vault.
pub fn is_vault(dir: &Path) -> bool {
    if dir.join(".context").is_dir() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    const NOTE_EXTS: &[&str] = &["md", "markdown", "mdx"];
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some((stem, ext)) = name.rsplit_once('.') {
            if !stem.is_empty() && NOTE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
                return true;
            }
        }
    }
    false
}

/// True if any component of a vault-relative path is an ignored dir/dotfile.
pub fn rel_path_is_ignored(rel: &str) -> bool {
    rel.split('/').any(|seg| !seg.is_empty() && is_ignored_name(seg))
}

/// Resolve a vault-relative path to an absolute path *inside* the vault,
/// rejecting `..` traversal, absolute inputs, and anything that escapes root.
pub fn resolve_in_vault(vault: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(rel);

    // Reject absolute paths and any parent/prefix components outright.
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::new("path traversal ('..') is not allowed"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::new("absolute paths are not allowed"));
            }
        }
    }

    let joined = vault.join(candidate);

    // Defense in depth: after lexical normalization the result must still be
    // within the vault root. We normalize without touching the filesystem so
    // this works for paths that don't exist yet (create_note/create_folder).
    let normalized = normalize_lexically(&joined);
    let vault_norm = normalize_lexically(vault);
    if !normalized.starts_with(&vault_norm) {
        return Err(AppError::new("resolved path escapes the vault"));
    }
    Ok(normalized)
}

/// Lexical normalization (collapse `.` / `..`) without filesystem access.
fn normalize_lexically(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Compute a vault-relative, forward-slash path from an absolute path.
pub fn rel_from_abs(vault: &Path, abs: &Path) -> AppResult<String> {
    let vault_norm = normalize_lexically(vault);
    let abs_norm = normalize_lexically(abs);
    let rel = abs_norm
        .strip_prefix(&vault_norm)
        .map_err(|_| AppError::new("path is outside the vault"))?;
    Ok(rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault() -> PathBuf {
        PathBuf::from("/tmp/vault")
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(resolve_in_vault(&vault(), "../secret.md").is_err());
        assert!(resolve_in_vault(&vault(), "notes/../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(resolve_in_vault(&vault(), "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative_paths() {
        let p = resolve_in_vault(&vault(), "sub/dir/note.md").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/vault/sub/dir/note.md"));
    }

    #[test]
    fn ignores_dotfolders_and_context_dirs() {
        assert!(is_ignored_name(".context"));
        assert!(is_ignored_name(".git"));
        assert!(is_ignored_name(".hidden"));
        assert!(!is_ignored_name("Notes"));
        assert!(rel_path_is_ignored(".context/index.sqlite"));
        assert!(rel_path_is_ignored("a/.git/config"));
        assert!(!rel_path_is_ignored("a/b/note.md"));
    }

    #[test]
    fn ignores_heavy_dependency_dirs() {
        assert!(is_ignored_name("node_modules"));
        assert!(is_ignored_name("target"));
        assert!(is_ignored_name("__pycache__"));
        assert!(rel_path_is_ignored("app/node_modules/pkg/index.js"));
        assert!(!is_ignored_name("Projects")); // real folders still walked
    }

    #[test]
    fn allowlist_accepts_notes_images_pdf_only() {
        for ok in ["note.md", "a.markdown", "b.MDX", "readme.txt", "page.html", "img.png", "p.JPG", "doc.pdf"] {
            assert!(is_allowed_file(ok), "{ok} should be allowed");
        }
        for no in ["script.js", "types.d.ts", "styles.css", "data.json", "Makefile", "LICENSE", "bundle.min.js"] {
            assert!(!is_allowed_file(no), "{no} should be rejected");
        }
    }

    #[test]
    fn rel_from_abs_uses_forward_slashes() {
        let rel = rel_from_abs(&vault(), Path::new("/tmp/vault/a/b.md")).unwrap();
        assert_eq!(rel, "a/b.md");
    }

    #[test]
    fn is_vault_detects_context_dir_and_notes() {
        // Empty folder → not a vault.
        let empty = tempfile::tempdir().unwrap();
        assert!(!is_vault(empty.path()));

        // Folder with a .context/ index → a vault.
        let indexed = tempfile::tempdir().unwrap();
        std::fs::create_dir(indexed.path().join(".context")).unwrap();
        assert!(is_vault(indexed.path()));

        // Folder with a markdown note → a vault.
        let noted = tempfile::tempdir().unwrap();
        std::fs::write(noted.path().join("Welcome.md"), "# hi").unwrap();
        assert!(is_vault(noted.path()));

        // Folder with only non-note files (images/pdf/junk) → not a vault.
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(assets.path().join("photo.png"), b"x").unwrap();
        std::fs::write(assets.path().join("report.pdf"), b"x").unwrap();
        assert!(!is_vault(assets.path()));
    }
}
