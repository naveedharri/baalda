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
/// a real project directory can't dump junk into the vault. That flood guard is
/// why `js`/`ts`/`css`/`java` are absent even though the app can open them.
///
/// ONE CONTRACT with the TS side, like `parse.rs TAG_RE` ↔ the editor's `#tag`
/// rule: this list and `SURFACED_EXTS` in `src/lib/formats.ts` are the same set.
/// Change one, change both — `src/lib/__tests__/formatsLockstep.test.ts` reads
/// this file and fails otherwise.
pub const ALLOWED_EXTS: &[&str] = &[
    // notes / text
    "md", "markdown", "mdx", "txt", "html", "htm", "canvas",
    // images
    "png", "jpg", "jpeg", "jfif", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif",
    "tiff", "tif",
    // documents
    "pdf", "docx", "xlsx", "xlsm", "pptx",
    // video / audio
    "mp4", "m4v", "mov", "webm", "mp3", "wav", "m4a", "ogg", "aac", "flac",
    // tabular / structured data
    "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "py", "rs", "go", "sh", "sql",
    // archives
    "zip",
];

/// The CRDT note family: the only extensions that become server `notes` and ride
/// the md↔CRDT bridge. Everything else in `ALLOWED_EXTS` surfaces in the tree but
/// syncs as an attachment. Mirrors `NOTE_EXTS` in `src/lib/formats.ts`,
/// `src/lib/sync/registry.ts` and `src/lib/sync/inbound.ts` (same lockstep test).
pub const NOTE_EXTS: &[&str] = &["md", "markdown", "mdx", "txt", "html", "htm", "canvas"];

/// True if a directory/file name should be skipped by the tree walk & watcher.
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name) || DENIED_DIRS.contains(&name)
}

/// True if a file (by name) is an allowed, surfaceable type per `ALLOWED_EXTS`.
/// Files with no extension, or an extension not on the list, are not surfaced.
pub fn is_allowed_file(name: &str) -> bool {
    has_ext_in(name, ALLOWED_EXTS)
}

/// True if a file (by name) belongs to the CRDT note family (`NOTE_EXTS`).
pub fn is_note_file(name: &str) -> bool {
    has_ext_in(name, NOTE_EXTS)
}

/// Does the vault-root `attachments/` store feed the FILE index (`files` /
/// `files_fts`)?
///
/// **No, deliberately.** Those files are content-addressed
/// (`attachments/<16 hex>.png`), hidden from the sidebar, and reachable only
/// through the note that embeds them — so a search hit on one would name a file
/// the user cannot see, cannot locate and cannot open from the result. The note
/// that embeds it is the hit they actually want, and that one is indexed. Flip
/// this to `true` only alongside a way to show "used by <note>" on the hit.
pub const INDEX_ATTACHMENTS: bool = false;

/// The vault-root directory holding content-addressed attachments. Mirrors
/// `attachments.rs ensure_attachment_rel` and `stats.rs ATTACHMENTS_DIR`.
const ATTACHMENTS_PREFIX: &str = "attachments/";

/// True if a vault-relative path is a tree-visible binary the FILE index covers:
/// surfaced by `ALLOWED_EXTS`, outside the note family, and not somewhere the
/// walk ignores. The single authority for "does this get a `files` row",
/// shared by `Index::rebuild` and the watcher's `plan_batch` so the open-time
/// reconcile and the live path can never disagree about the set.
///
/// Note what this does NOT ask: whether the file exists. Callers that need that
/// (both of them) already have the answer from the walk or the existence check
/// that decides modified-vs-removed.
pub fn is_indexable_file(rel: &str) -> bool {
    if rel.is_empty() || rel_path_is_ignored(rel) {
        return false;
    }
    if !INDEX_ATTACHMENTS && rel.starts_with(ATTACHMENTS_PREFIX) {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    is_allowed_file(name) && !is_note_file(name)
}

/// Shared extension test: split at the LAST dot and require both halves, so a
/// dotfile (`.gitignore`) has no extension and never matches.
fn has_ext_in(name: &str, exts: &[&str]) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            exts.contains(&ext.to_ascii_lowercase().as_str())
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
    // Deliberately narrower than `NOTE_EXTS`: a folder of .txt/.html is not by
    // itself evidence that someone already uses it as a vault.
    const VAULT_MARKER_EXTS: &[&str] = &["md", "markdown", "mdx"];
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some((stem, ext)) = name.rsplit_once('.') {
            if !stem.is_empty() && VAULT_MARKER_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
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

/// What sits at a path, WITHOUT following a symbolic link at it (#216).
///
/// The tree walk and the index both skip links (`DirEntry::file_type()` /
/// WalkDir with `follow_links` off), so every check that decides whether a note
/// is still there must agree with them: a link at a note path is NOT the note.
/// `Path::exists()` / `is_file()` follow links and used to answer "present" for
/// a path the sidebar and the registry saw as gone, which kept a stale doc id
/// mapped and live beside the real file's new identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathState {
    Missing,
    Regular,
    Symlink,
    Dir,
}

impl PathState {
    /// Identity checks treat a link exactly like nothing: Baalda never syncs
    /// through links.
    pub fn is_absent(self) -> bool {
        matches!(self, PathState::Missing | PathState::Symlink)
    }
}

/// The state of the LAST component of `abs`, on `symlink_metadata`. A dangling
/// link is `Symlink`, not `Missing`. Anything else that is neither a link nor a
/// folder (a socket, a fifo) reads as `Regular`.
pub fn path_state(abs: &Path) -> PathState {
    match std::fs::symlink_metadata(abs) {
        Ok(m) if m.file_type().is_symlink() => PathState::Symlink,
        Ok(m) if m.is_dir() => PathState::Dir,
        Ok(_) => PathState::Regular,
        Err(_) => PathState::Missing,
    }
}

/// [`path_state`] for a vault-relative path, where a link in ANY component
/// below the vault root also counts: with `Old -> Business/Old`, `Old/n.md` is
/// `Symlink`, because `symlink_metadata` only declines to follow the FINAL
/// component and would report the real file behind the folder link as
/// `Regular`. The walk never descends into `Old`, so the identity checks must
/// not either. The vault root itself is not inspected (a vault opened through a
/// link is still a vault). A missing or non-folder ancestor is `Missing`.
pub fn vault_path_state(vault: &Path, rel: &str) -> PathState {
    let segs: Vec<&str> = rel
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segs.is_empty() {
        return path_state(vault);
    }
    let mut cur = vault.to_path_buf();
    for (i, seg) in segs.iter().enumerate() {
        cur.push(seg);
        let st = path_state(&cur);
        if i + 1 == segs.len() {
            return st;
        }
        match st {
            PathState::Dir => {}
            PathState::Symlink => return PathState::Symlink,
            PathState::Missing | PathState::Regular => return PathState::Missing,
        }
    }
    PathState::Missing
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

    /// The allow-list is one contract with `SURFACED_EXTS` in
    /// `src/lib/formats.ts` — see `formatsLockstep.test.ts`. Source code stays
    /// off it on purpose: the app can OPEN a `.js`, it just refuses to flood the
    /// sidebar with a project's worth of them.
    #[test]
    fn allowlist_matches_the_format_registry() {
        for ok in [
            "note.md", "a.markdown", "b.MDX", "readme.txt", "page.html", "board.canvas",
            "img.png", "p.JPG", "icon.svg", "shot.HEIC", "scan.tiff",
            "doc.pdf", "report.docx", "sheet.xlsx", "macro.xlsm", "deck.pptx",
            "clip.mp4", "cut.mov", "talk.mp3", "take.m4a",
            "data.csv", "tab.tsv", "map.json", "notes.yaml", "conf.toml", "feed.xml",
            "run.py", "lib.rs", "main.go", "setup.sh", "q.sql",
            "bundle.zip",
        ] {
            assert!(is_allowed_file(ok), "{ok} should be allowed");
        }
        for no in ["script.js", "types.d.ts", "styles.css", "Makefile", "LICENSE", "bundle.min.js"] {
            assert!(!is_allowed_file(no), "{no} should be rejected");
        }
    }

    /// Only the note family joins the CRDT bridge; everything else surfaced by
    /// `ALLOWED_EXTS` syncs as an attachment.
    #[test]
    fn note_family_is_narrower_than_the_allowlist() {
        for ok in ["note.md", "a.MARKDOWN", "b.mdx", "readme.txt", "page.html", "p.htm", "board.canvas"] {
            assert!(is_note_file(ok), "{ok} should be a note");
            assert!(is_allowed_file(ok), "{ok} should also be surfaced");
        }
        for no in ["img.png", "doc.pdf", "clip.mp4", "sheet.xlsx", "data.csv", ".gitignore", "Makefile"] {
            assert!(!is_note_file(no), "{no} should not be a note");
        }
    }

    #[cfg(unix)]
    #[test]
    fn path_state_sees_links_without_following_them() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path();
        std::fs::create_dir_all(v.join("Business/Old")).unwrap();
        std::fs::write(v.join("Business/Old/n.md"), "real").unwrap();
        std::fs::write(v.join("real.md"), "x").unwrap();
        symlink(v.join("real.md"), v.join("link.md")).unwrap();
        symlink(v.join("Business/Old"), v.join("Old")).unwrap();
        symlink(v.join("nowhere.md"), v.join("dangling.md")).unwrap();

        assert_eq!(path_state(&v.join("real.md")), PathState::Regular);
        assert_eq!(path_state(&v.join("link.md")), PathState::Symlink);
        assert_eq!(path_state(&v.join("Old")), PathState::Symlink);
        assert_eq!(path_state(&v.join("dangling.md")), PathState::Symlink);
        assert_eq!(path_state(&v.join("Business")), PathState::Dir);
        assert_eq!(path_state(&v.join("absent.md")), PathState::Missing);

        // Through a folder link the leaf alone looks regular; the vault-aware
        // check does not.
        assert_eq!(path_state(&v.join("Old/n.md")), PathState::Regular);
        assert_eq!(vault_path_state(v, "Old/n.md"), PathState::Symlink);
        assert_eq!(vault_path_state(v, "Business/Old/n.md"), PathState::Regular);
        assert_eq!(vault_path_state(v, "link.md"), PathState::Symlink);
        assert_eq!(vault_path_state(v, "dangling.md"), PathState::Symlink);
        assert_eq!(vault_path_state(v, "Nope/n.md"), PathState::Missing);
        assert_eq!(vault_path_state(v, "real.md/n.md"), PathState::Missing);
        assert!(PathState::Symlink.is_absent() && PathState::Missing.is_absent());
        assert!(!PathState::Regular.is_absent() && !PathState::Dir.is_absent());
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
