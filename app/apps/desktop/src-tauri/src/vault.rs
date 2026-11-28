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
    "md", "markdown", "mdx", "txt", "html", "htm", "canvas", "url", "webloc",
    // images
    "png", "jpg", "jpeg", "jfif", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif",
    "tiff", "tif",
    // documents
    "pdf", "docx", "xlsx", "xlsm", "pptx",
    // video / audio
    "mp4", "m4v", "mov", "webm", "mp3", "wav", "m4a", "ogg", "aac", "flac",
    // tabular / structured data
    "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "py", "rs", "go", "sh", "sql",
    // archives. Extensions are taken after the LAST dot, so `foo.tar.gz` is a
    // "gz" file: allowing "gz" admits every gzip (`log.gz` too), which is as
    // opaque a binary as a .zip and syncs the same way (#407).
    "zip", "tar", "tgz", "gz", "7z",
];

/// Optional types, surfaced only while the open vault's sync rules switch their
/// group on (#401): source code, config and other plain text. A `.baaldaignore`
/// vault switches them on (its default file hides build and dependency folders
/// instead, so a project folder still doesn't flood the vault); the old v1
/// rules shape left them off. ONE CONTRACT with `OPT_IN_EXTS.code`
/// in `src/lib/formats.ts` (lockstep test) and the server's `EXT_MIME`.
pub const CODE_EXTS: &[&str] = &[
    "js", "jsx", "mjs", "cjs",
    "ts", "tsx", "mts", "cts",
    "css",
    "scss",
    "sass",
    "less",
    "styl",
    "vue",
    "svelte",
    "astro",
    "hbs", "handlebars", "mustache", "ejs", "erb", "liquid",
    "pug", "jade",
    "j2", "jinja", "jinja2", "njk",
    "coffee",
    "php",
    "graphql", "gql",
    "c", "h",
    "cpp", "cc", "cxx", "hpp", "hh", "hxx",
    "cs",
    "java",
    "kt", "kts",
    "scala",
    "groovy", "gradle",
    "dart",
    "swift",
    "pyi", "pyw",
    "rb", "rake", "gemspec",
    "pl", "pm",
    "lua",
    "r",
    "jl",
    "bash", "zsh", "ksh", "fish",
    "ps1", "psm1", "psd1",
    "bat", "cmd",
    "tcl",
    "hs",
    "erl", "hrl",
    "ex", "exs",
    "clj", "cljs", "cljc", "edn",
    "elm",
    "ml", "mli",
    "fs", "fsi", "fsx",
    "lisp", "cl", "el",
    "scm", "ss", "rkt",
    "cr",
    "vb",
    "pas",
    "f90", "f95", "f03", "f08",
    "zig",
    "nim",
    "sol",
    "v", "sv", "svh",
    "vhd", "vhdl",
    "asm", "s",
    "proto",
    "cmake",
    "mk", "mak",
    "dockerfile",
    "ini", "cfg", "conf", "properties",
    "tf", "tfvars", "hcl",
    "prisma",
    "lock",
    "jsonc", "json5",
    "jsonl", "ndjson",
    "ipynb",
    "xsd", "xsl", "xslt", "kml", "gpx", "csproj", "fsproj", "vbproj", "props", "targets", "xaml", "resx",
    "log",
    "diff", "patch",
    "tex", "sty", "cls", "ltx",
    "bib",
    "rst",
    "adoc", "asciidoc",
    "org",
    "ics",
    "vcf",
    "srt",
    "vtt",
];

/// The other optional group ("More file types"): fonts, design files, older
/// and open Office formats, more audio/video and archives. Mirrors
/// `OPT_IN_EXTS.extra` in `src/lib/formats.ts`.
pub const EXTRA_EXTS: &[&str] = &[
    "ttf",
    "otf",
    "woff",
    "woff2",
    "psd",
    "ai",
    "eps",
    "sketch",
    "doc",
    "xls",
    "ppt",
    "odt",
    "ods",
    "odp",
    "rtf",
    "epub",
    "mkv",
    "avi",
    "opus",
    "aiff", "aif",
    "rar",
    "bz2",
    "xz",
];

/// Which optional groups the OPEN vault switches on: bit 0 = code, bit 1 =
/// extra. Set by `sync_rules::install` on every vault open and rules change.
/// Process-wide on purpose: the app holds one vault open at a time, and
/// `is_allowed_file` is asked from dozens of places that know only a name.
static OPT_IN_GROUPS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
pub const OPT_IN_CODE: u8 = 1;
pub const OPT_IN_EXTRA: u8 = 2;
/// The vault's "Hidden folders" switch (#401): names starting with a dot sync.
pub const OPT_IN_HIDDEN: u8 = 4;
/// The vault's "Build and dependency folders" switch: [`DENIED_DIRS`] sync.
pub const OPT_IN_BUILD: u8 = 8;

pub fn set_opt_in_groups(groups: u8) {
    OPT_IN_GROUPS.store(groups, std::sync::atomic::Ordering::SeqCst);
}

pub fn opt_in_groups() -> u8 {
    OPT_IN_GROUPS.load(std::sync::atomic::Ordering::SeqCst)
}

/// The CRDT note family: the only extensions that become server `notes` and ride
/// the md↔CRDT bridge. Everything else in `ALLOWED_EXTS` surfaces in the tree but
/// syncs as an attachment. Mirrors `NOTE_EXTS` in `src/lib/formats.ts`,
/// `src/lib/sync/registry.ts` and `src/lib/sync/inbound.ts` (same lockstep test).
pub const NOTE_EXTS: &[&str] = &["md", "markdown", "mdx", "txt", "html", "htm", "canvas", "url", "webloc"];

/// Name prefixes of the lock and owner files other apps leave NEXT TO a file
/// they hold open (#265). They are not the user's files: Word, Excel and
/// PowerPoint write `~$Report.docx` beside an open `Report.docx` (with an
/// extension the vault surfaces, so the allowlist alone lets it through) and
/// remove it on close; LibreOffice writes `.~lock.Report.docx#`, which the dot
/// rule already covers but is listed so the contract names it. Synced, each one
/// was a server row, an upload attempt, a delete and a tombstone, and a ghost
/// file appearing and vanishing in every teammate's sidebar.
///
/// ONE CONTRACT with `TRANSIENT_PREFIXES` in `src/lib/formats.ts` (pinned by
/// `formatsLockstep.test.ts`) and the server's `registry/transient.ts`.
pub const TRANSIENT_PREFIXES: &[&str] = &["~$", ".~lock."];

/// True for an app's transient lock/temp file (see [`TRANSIENT_PREFIXES`]),
/// plus the `~*.tmp` family Office writes while saving (`~WRL0001.tmp`,
/// `~WRD0003.tmp`). `tmp` is not in `ALLOWED_EXTS`, so that half is
/// belt-and-braces: it keeps the rule true if the allowlist ever grows one.
///
/// Deliberately narrow, because an ignored name drops out of the tree, the
/// index and every sync pass: a prefix only counts on a surfaced NON-NOTE file
/// (the only thing an owner file ever shadows), so a note or a folder somebody
/// happened to name `~$…` keeps syncing exactly as before, and a user's own
/// `~notes.md` is theirs. Nothing is ever deleted because of this rule — an
/// already-registered lock file simply stops being re-uploaded.
pub fn is_transient_name(name: &str) -> bool {
    if TRANSIENT_PREFIXES.iter().any(|p| name.starts_with(p))
        && is_allowed_file(name)
        && !is_note_file(name)
    {
        return true;
    }
    name.starts_with('~') && name.len() > 5 && name.to_ascii_lowercase().ends_with(".tmp")
}

/// Operating-system bookkeeping that is per computer and never content.
pub const OS_JUNK: &[&str] = &[
    ".DS_Store",
    ".Trashes",
    ".Trash",
    ".Spotlight-V100",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    "Thumbs.db",
    "desktop.ini",
];

/// Names that never sync whatever the vault's switches or rules say (#401):
/// each is a design problem, not a preference. Baalda's own data (`.context`),
/// a Git repository's internals (`.git`, a database two computers cannot
/// share file by file), app lock files, Baalda's own save-in-progress temp
/// files (`notefile.rs temp_sibling`), and OS bookkeeping (`._x` AppleDouble
/// shadows, `.DS_Store`, `Thumbs.db`…).
pub fn is_floor_name(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
        || is_transient_name(name)
        || name.starts_with(".~lock.")
        || name.starts_with("._")
        || OS_JUNK.iter().any(|j| name.eq_ignore_ascii_case(j))
        || (name.starts_with('.') && name.to_ascii_lowercase().ends_with(".tmp"))
        || name.eq_ignore_ascii_case(crate::sync_rules::RULES_FILE)
}

/// True if a directory/file name should be skipped by the tree walk & watcher:
/// the floor, plus dot names and build folders unless the open vault switched
/// them on (`OPT_IN_HIDDEN` / `OPT_IN_BUILD`). Off by default, which is the
/// behaviour every vault had before the switches existed.
pub fn is_ignored_name(name: &str) -> bool {
    is_ignored_name_with(name, opt_in_groups())
}

pub fn is_ignored_name_with(name: &str, groups: u8) -> bool {
    is_floor_name(name)
        || (name.starts_with('.') && groups & OPT_IN_HIDDEN == 0)
        || (DENIED_DIRS.contains(&name) && groups & OPT_IN_BUILD == 0)
}

/// The fixed rule from before the switches, for boundaries that are about
/// what a web view may read rather than what syncs (dashboard leases).
pub fn is_hidden_name_strict(name: &str) -> bool {
    is_floor_name(name) || name.starts_with('.') || DENIED_DIRS.contains(&name)
}

/// True if a file (by name) is an allowed, surfaceable type per `ALLOWED_EXTS`,
/// or an optional type whose group the open vault switched on
/// ([`CODE_EXTS`], [`EXTRA_EXTS`]). Files with no extension, or an extension
/// not on any list, are not surfaced.
pub fn is_allowed_file(name: &str) -> bool {
    is_allowed_with(name, opt_in_groups())
}

/// [`is_allowed_file`] for an explicit set of switched-on groups.
pub fn is_allowed_with(name: &str, groups: u8) -> bool {
    if has_ext_in(name, ALLOWED_EXTS) {
        return true;
    }
    (groups & OPT_IN_CODE != 0 && has_ext_in(name, CODE_EXTS))
        || (groups & OPT_IN_EXTRA != 0 && has_ext_in(name, EXTRA_EXTS))
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

/// Is this path out of the vault's sync: the fixed floor above
/// ([`rel_path_is_ignored`]) or the vault's own sync rules (#401,
/// `sync_rules.rs`)? The one question every walk, index pass and inbound write
/// asks; the floor-only form stays for paths that are not in a vault (imports).
pub fn is_excluded(vault: &Path, rel: &str, is_dir: bool) -> bool {
    rel_path_is_ignored(rel) || crate::sync_rules::excludes(vault, rel, is_dir)
}

/// [`is_excluded`] for a path that may be gone, so its kind is unknown: either
/// reading counts. Only ever used to DROP work (a watcher event, an index row),
/// never to decide that something may be written.
pub fn is_excluded_any_kind(vault: &Path, rel: &str) -> bool {
    rel_path_is_ignored(rel)
        || crate::sync_rules::excludes(vault, rel, false)
        || crate::sync_rules::excludes(vault, rel, true)
}

/// The refusal every write gives for a path the vault's sync rules exclude.
/// The desktop matches on "sync rules" (`lib/syncRules/store.ts`).
pub fn excluded_refusal(rel: &str) -> AppError {
    AppError::new(format!("This path is excluded by the vault's sync rules. ({rel})"))
}

/// Refuse a write to a path the vault's own rules exclude. The floor has its
/// own, older refusals at each call site; this is the rules half.
pub fn refuse_excluded(vault: &Path, rel: &str, is_dir: bool) -> AppResult<()> {
    if crate::sync_rules::excludes(vault, rel, is_dir) {
        return Err(excluded_refusal(rel));
    }
    Ok(())
}

/// [`is_indexable_file`] in a vault: also not excluded by its sync rules.
pub fn is_indexable_in(vault: &Path, rel: &str) -> bool {
    is_indexable_file(rel) && !crate::sync_rules::excludes(vault, rel, false)
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

/// Refuse a write whose vault root is no longer a folder (#221).
///
/// Every write path below creates missing parent folders, which is right inside
/// a vault and exactly wrong when the vault itself moved, was renamed or its
/// drive unmounted while the app was open: a late egest, placeholder or
/// download would quietly re-create the OLD folder with a stray file in it.
/// Follows links, like the watcher's root check.
pub fn require_vault_root(vault: &Path) -> AppResult<()> {
    if vault.is_dir() {
        Ok(())
    } else {
        Err(AppError::new(
            "the vault folder is missing: it moved, was renamed or its drive was unmounted",
        ))
    }
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
    fn ignores_office_and_editor_lock_files() {
        // Office owner files carry a surfaced extension: the allowlist alone
        // would sync them (#265).
        assert!(is_ignored_name("~$Report.docx"));
        assert!(is_ignored_name("~$dget.xlsx"));
        assert!(is_ignored_name("~$eck.pptx"));
        assert!(is_ignored_name("~WRL0001.tmp"));
        assert!(is_ignored_name("~WRD0003.TMP"));
        assert!(is_ignored_name(".~lock.Report.docx#"));
        assert!(rel_path_is_ignored("Team/Docs/~$Report.docx"));
        assert!(!is_indexable_file("Team/~$Report.docx"));
        // Narrow on purpose: a note or folder named like one keeps syncing.
        assert!(!is_ignored_name("~$draft.md"));
        assert!(!is_ignored_name("~$Archive"));
        assert!(!rel_path_is_ignored("~$Archive/notes.md"));
        // A user's own tilde-named files are theirs.
        assert!(!is_ignored_name("~notes.md"));
        assert!(!is_ignored_name("~.tmp"));
        assert!(!is_ignored_name("Report~$.docx"));
        assert!(!is_ignored_name("~é.md"));
        assert!(!rel_path_is_ignored("Team/Report.docx"));
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
            "bundle.zip", "backup.tar", "site.tgz", "site.tar.gz", "dump.gz", "photos.7z",
        ] {
            assert!(is_allowed_file(ok), "{ok} should be allowed");
        }
        for no in ["script.js", "types.d.ts", "styles.css", "Makefile", "LICENSE", "bundle.min.js"] {
            assert!(!is_allowed_file(no), "{no} should be rejected");
        }
    }

    /// The optional groups surface only while switched on (#401), and never
    /// change the note family.
    #[test]
    fn optional_types_follow_the_vault_switches() {
        // The pure form: the process-wide switch is shared with parallel tests.
        for no in ["app.ts", "main.rb", "font.woff2", "old.doc"] {
            assert!(!is_allowed_with(no, 0), "{no} is off by default");
        }
        let code = OPT_IN_CODE;
        assert!(is_allowed_with("app.ts", code) && is_allowed_with("main.RB", code));
        assert!(is_allowed_with("x.d.ts", code) && is_allowed_with("note.md", code));
        assert!(!is_allowed_with("font.woff2", code));
        assert!(!is_note_file("app.ts"));
        let both = OPT_IN_CODE | OPT_IN_EXTRA;
        assert!(is_allowed_with("font.woff2", both) && is_allowed_with("old.doc", both));
        assert!(!is_allowed_with("Makefile", both) && !is_allowed_with("tool.exe", both));
    }

    /// Dot names and build folders follow the vault's switches; the floor never moves.
    #[test]
    fn folder_switches_open_dot_and_build_folders_but_never_the_floor() {
        let all = OPT_IN_CODE | OPT_IN_EXTRA | OPT_IN_HIDDEN | OPT_IN_BUILD;
        for off in [".github", ".obsidian", "node_modules", "dist", "venv"] {
            assert!(is_ignored_name_with(off, 0), "{off} hidden by default");
        }
        assert!(!is_ignored_name_with(".github", OPT_IN_HIDDEN));
        assert!(is_ignored_name_with("node_modules", OPT_IN_HIDDEN));
        assert!(!is_ignored_name_with("node_modules", OPT_IN_BUILD));
        assert!(is_ignored_name_with(".github", OPT_IN_BUILD));
        for floor in [
            ".context", ".git", ".DS_Store", "._photo.jpg", "Thumbs.db", "desktop.ini",
            ".~lock.Report.docx#", "~$Report.docx", ".note.md.123.4.tmp", ".Trashes",
        ] {
            assert!(is_ignored_name_with(floor, all), "{floor} never syncs");
        }
        assert!(!is_ignored_name_with("Projects", all));
        // The dashboard boundary keeps the old rule whatever the switches say.
        assert!(is_hidden_name_strict(".github") && is_hidden_name_strict("node_modules"));
        // A dotfile with one dot has no extension, on every layer.
        assert!(!is_allowed_with(".md", all) && !is_allowed_with(".gitignore", all));
        assert!(is_allowed_with("ci.yml", 0));
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
