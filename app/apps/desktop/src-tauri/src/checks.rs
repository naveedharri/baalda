//! Integrity checks over the open vault, for Vault Settings → Health.
//!
//! The census in `stats.rs` answers "how big is this vault"; this answers "what
//! is wrong with it". Fifteen checks, each reporting a true count, an optional
//! byte total, and up to 25 example rows. The UI owns every label, description
//! and severity (`lib/health/checks.ts`) — Rust reports only ids, counts and
//! affected files, so adding a check is one arm here and one row there.
//!
//! Shape contract: `src/lib/health/types.ts` (`VaultCheckId`, `VaultCheckItem`,
//! `VaultCheckResult`, `VaultChecks`). Every result id comes from [`CHECK_IDS`],
//! which is the `VaultCheckId` union in the same order, and every check appears
//! in the output even at count 0 — the page renders a green row for those, so a
//! missing id reads as "not checked" rather than "clean".
//!
//! Cost: it reuses `stats::census_files` for the single disk walk, then reads
//! note CONTENTS once (unlike the census, which only stats). That read is what
//! `unreadable-notes`, `bad-frontmatter` and `missing-embeds` need, and it is
//! bounded twice: nothing at or above [`MAX_NOTE_BYTES`] is read at all (it is
//! reported as oversized instead), and embed scanning stops at
//! [`MAX_EMBED_SCAN_BYTES`].

use crate::error::{AppError, AppResult};
use crate::index::Index;
use crate::parse;
use crate::stats::{census_files, now_ms, Census, SizedFile, MAX_NOTE_BYTES};
use crate::vault::resolve_in_vault;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use walkdir::WalkDir;

/// The `VaultCheckId` union, in its declaration order. The results array is
/// emitted in exactly this order, always complete.
pub const CHECK_IDS: &[&str] = &[
    "empty-notes",
    "unreadable-notes",
    "bad-frontmatter",
    "case-collisions",
    "illegal-names",
    "long-paths",
    "stale-index",
    "broken-links",
    "missing-embeds",
    "duplicate-titles",
    "unindexed-markdown",
    "oversized-notes",
    "heavy-history",
    "orphan-history",
    "trash",
];

/// Example rows per check. The count is always the true total.
const MAX_ITEMS: usize = 25;

/// Notes above this are not scanned for embeds. An embed scan is two regex
/// passes over the whole text, and a multi-megabyte note is generated output
/// (an export, a log) far more often than it is prose with images.
const MAX_EMBED_SCAN_BYTES: i64 = 2 * 1024 * 1024;

/// Vault-relative paths longer than this are flagged. Well under Windows' 260
/// MAX_PATH once a user's own vault root is prepended.
const LONG_PATH_CHARS: usize = 200;

/// `heavy-history` thresholds: history this many times the file's own size…
const HEAVY_HISTORY_RATIO: i64 = 20;
/// …but only once the history is at least this big (a 40-byte note with 2 KB of
/// history is 50× and completely harmless)…
const HEAVY_HISTORY_MIN_BYTES: i64 = 256 * 1024;
/// …or simply this many uncompacted updates, which is a compaction that is not
/// running rather than a size problem.
const HEAVY_HISTORY_MAX_UPDATES: i64 = 256;

/// Where recovery copies live. The ONE `.context` subdirectory these checks may
/// read: everything else under it is the derived index and CRDT store, which
/// nothing outside `index.rs` has any business walking.
const TRASH_DIR: &str = ".context/trash";

/// Stems Windows refuses whatever the extension (`CON.md` is unopenable there).
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Characters no Windows filename may contain. `/` is absent on purpose: these
/// are tested per path SEGMENT, so a slash cannot appear in one.
const ILLEGAL_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

// `![[target]]` / `![[target|alias]]` / `![[target#heading]]` — the wikilink
// embed. Same bracket rule as `parse.rs`'s `WIKILINK_RE`, with the leading `!`.
static EMBED_WIKI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[\[([^\]\n]+)\]\]").unwrap());
// `![alt](path)` / `![alt](path "title")` — the markdown embed.
static EMBED_MD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[[^\]\n]*\]\(([^)\n]+)\)").unwrap());

/// One affected file. `path` is vault-relative; for `orphan-history` there is no
/// file, so it carries the doc id, and for `trash` it is the path under
/// `.context/trash`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultCheckItem {
    pub path: String,
    pub doc_id: Option<String>,
    pub detail: Option<String>,
    pub bytes: Option<i64>,
}

impl VaultCheckItem {
    fn new(path: impl Into<String>, detail: impl Into<String>) -> Self {
        VaultCheckItem {
            path: path.into(),
            doc_id: None,
            detail: Some(detail.into()),
            bytes: None,
        }
    }

    fn bare(path: impl Into<String>) -> Self {
        VaultCheckItem {
            path: path.into(),
            doc_id: None,
            detail: None,
            bytes: None,
        }
    }

    fn with_doc(mut self, doc_id: impl Into<String>) -> Self {
        self.doc_id = Some(doc_id.into());
        self
    }

    fn with_bytes(mut self, bytes: i64) -> Self {
        self.bytes = Some(bytes);
        self
    }
}

/// One check's verdict. `count` is the true total even when `items` is capped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCheckResult {
    pub id: &'static str,
    pub count: i64,
    pub bytes: Option<i64>,
    pub items: Vec<VaultCheckItem>,
}

/// Every check, always all of them, in [`CHECK_IDS`] order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChecks {
    pub computed_at: i64,
    pub results: Vec<VaultCheckResult>,
}

/// What one note's bytes turned out to be. Built once, read by three checks.
struct NoteScan {
    rel: String,
    bytes: i64,
    /// False for a markdown file with no `notes` row. Those are scanned for
    /// readability only — see `scan_notes`.
    indexed: bool,
    /// The decoded text, for a note small enough to read that is valid UTF-8.
    text: Option<String>,
    /// Why the bytes are not usable as text, when that is the finding.
    unreadable: Option<String>,
}

/// Run every check. `index` must be the index of `vault`; the caller holds the
/// index mutex, so this locks nothing itself. `live_docs` is the registry's
/// `docId → relPath` map, used for the orphan rule — see `stats::collect`, whose
/// definition of an orphan this reuses exactly so the page and the sweep agree.
pub fn collect(
    vault: &Path,
    index: &Index,
    live_docs: &HashMap<String, String>,
) -> AppResult<VaultChecks> {
    let computed_at = now_ms();
    let census = census_files(vault, index)?;
    let scans = scan_notes(vault, &census);

    let mut by_id: HashMap<&'static str, VaultCheckResult> = HashMap::new();
    let mut put = |result: VaultCheckResult| {
        by_id.insert(result.id, result);
    };

    put(empty_notes(&census));
    put(unreadable_notes(&scans));
    put(bad_frontmatter(&scans));
    put(case_collisions(&census));
    put(illegal_names(&census));
    put(long_paths(&census));
    put(stale_index(&census));
    put(broken_links(index, &census, &scans)?);
    put(missing_embeds(&census, &scans));
    put(duplicate_titles(&census));
    put(unindexed_markdown(&census));
    put(oversized_notes(&census.notes, MAX_NOTE_BYTES));
    let footprints = index.history_footprints()?;
    put(heavy_history(&footprints, &census, live_docs));
    put(orphan_history(&footprints, &census, live_docs));
    put(trash(vault));

    // Emit in the union's order, with an empty result for anything unfilled, so
    // the page never has to reason about a missing id.
    let results = CHECK_IDS
        .iter()
        .map(|&id| by_id.remove(id).unwrap_or_else(|| empty_result(id)))
        .collect();
    Ok(VaultChecks {
        computed_at,
        results,
    })
}

fn empty_result(id: &'static str) -> VaultCheckResult {
    VaultCheckResult {
        id,
        count: 0,
        bytes: None,
        items: Vec::new(),
    }
}

/// A check with no size dimension: items in path order, count = items found.
fn tally(id: &'static str, mut items: Vec<VaultCheckItem>) -> VaultCheckResult {
    items.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.detail.cmp(&b.detail)));
    let count = items.len() as i64;
    items.truncate(MAX_ITEMS);
    VaultCheckResult {
        id,
        count,
        bytes: None,
        items,
    }
}

/// A check about size: items largest first, `bytes` = the total across ALL of
/// them (not just the ones that fit in `items`).
fn tally_by_bytes(id: &'static str, mut items: Vec<VaultCheckItem>) -> VaultCheckResult {
    items.sort_by(|a, b| {
        b.bytes
            .unwrap_or(0)
            .cmp(&a.bytes.unwrap_or(0))
            .then_with(|| a.path.cmp(&b.path))
    });
    let count = items.len() as i64;
    let bytes = items.iter().map(|i| i.bytes.unwrap_or(0)).sum();
    items.truncate(MAX_ITEMS);
    VaultCheckResult {
        id,
        count,
        bytes: Some(bytes),
        items,
    }
}

// ---- The note read pass ---------------------------------------------------

/// Read every note once, plus every markdown file the index does NOT know.
///
/// That second group is why `unreadable-notes` is not a dead check: a file that
/// is not valid UTF-8 cannot be indexed at all (`Index::index_one` reads with
/// `read_to_string`), so the very files this check exists to find are exactly
/// the ones with no `notes` row. They are scanned for readability only — the
/// frontmatter and embed checks stay on real notes, since an unindexed file's
/// first problem is that it is unindexed.
///
/// A note at or above the server cap is NOT read (its finding is
/// `oversized-notes`), and a file that disappeared mid-run is simply absent from
/// the scans rather than an error — this is a snapshot of a vault a person and a
/// sync engine are both still writing to.
fn scan_notes(vault: &Path, census: &Census) -> Vec<NoteScan> {
    let unindexed = census.others.iter().filter(|f| is_markdown(&f.path));
    let mut out = Vec::with_capacity(census.notes.len());
    for (note, indexed) in census
        .notes
        .iter()
        .map(|n| (n, true))
        .chain(unindexed.map(|n| (n, false)))
    {
        if note.bytes >= MAX_NOTE_BYTES {
            continue;
        }
        let Ok(abs) = resolve_in_vault(vault, &note.path) else {
            continue;
        };
        let Ok(raw) = std::fs::read(&abs) else {
            continue;
        };
        let (text, unreadable) = match String::from_utf8(raw) {
            Err(_) => (None, Some("not valid UTF-8".to_string())),
            // A NUL is legal UTF-8 and completely fatal downstream: SQLite
            // truncates the FTS body at it and the editor cannot round-trip it.
            Ok(s) if s.contains('\0') => (None, Some("contains NUL bytes".to_string())),
            Ok(s) => (Some(s), None),
        };
        out.push(NoteScan {
            rel: note.path.clone(),
            bytes: note.bytes,
            indexed,
            text,
            unreadable,
        });
    }
    out
}

fn is_markdown(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

// ---- The checks -----------------------------------------------------------

fn empty_notes(census: &Census) -> VaultCheckResult {
    tally(
        "empty-notes",
        census
            .notes
            .iter()
            .filter(|f| f.bytes == 0)
            .map(|f| VaultCheckItem::bare(&f.path))
            .collect(),
    )
}

fn unreadable_notes(scans: &[NoteScan]) -> VaultCheckResult {
    tally(
        "unreadable-notes",
        scans
            .iter()
            .filter_map(|s| {
                s.unreadable
                    .as_ref()
                    .map(|why| VaultCheckItem::new(&s.rel, why))
            })
            .collect(),
    )
}

fn bad_frontmatter(scans: &[NoteScan]) -> VaultCheckResult {
    tally(
        "bad-frontmatter",
        scans
            .iter()
            .filter(|s| s.indexed)
            .filter_map(|s| {
                let text = s.text.as_deref()?;
                frontmatter_problem(text).map(|why| VaultCheckItem::new(&s.rel, why))
            })
            .collect(),
    )
}

/// Why a leading `---` block is not usable frontmatter, or `None` when it is
/// fine (or absent). Two failure modes, as the contract says: it never closes,
/// or it closes but holds a line that is not YAML-ish.
///
/// The fence rules come from `parse::split_frontmatter` rather than being
/// re-derived here, so this reports on exactly the block the indexer parses.
fn frontmatter_problem(content: &str) -> Option<String> {
    if !(content.starts_with("---\n") || content.starts_with("---\r\n")) {
        return None;
    }
    let Some(yaml) = parse::split_frontmatter(content).0 else {
        return Some("no closing `---` line".to_string());
    };
    if yaml.len() > parse::MAX_FRONTMATTER_BYTES {
        return Some(format!(
            "no closing `---` line within {} KB",
            parse::MAX_FRONTMATTER_BYTES / 1024
        ));
    }
    for line in yaml.lines() {
        let trimmed = line.trim();
        // Blank, comment, indented continuation, or a list item: all YAML-ish.
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if trimmed == "-" || trimmed.starts_with("- ") {
            continue;
        }
        // Otherwise it must be `key: value` (or `key:`) with a non-empty key.
        match line.find(':') {
            Some(i) if i > 0 => continue,
            _ => return Some(format!("`{}` is not `key: value`", ellipsis(trimmed, 40))),
        }
    }
    None
}

/// Paths that differ only in case. One file on macOS/Windows, two rows on the
/// server — the shape behind the case-collision sync loop (#98), so this is the
/// check that names it before it costs anyone a day.
fn case_collisions(census: &Census) -> VaultCheckResult {
    let mut groups: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for path in every_path(census) {
        groups.entry(path.to_lowercase()).or_default().push(path);
    }
    let mut items = Vec::new();
    for (_, members) in groups.iter_mut().filter(|(_, m)| m.len() > 1) {
        // Sorted so the sibling a row names is the same on every run, whatever
        // order the walk happened to return the colliding files in.
        members.sort_unstable();
        for path in members.iter() {
            let others: Vec<&str> = members.iter().copied().filter(|p| p != path).collect();
            let detail = match others.split_first() {
                Some((first, [])) => format!("also `{first}`"),
                Some((first, rest)) => format!("also `{first}` and {} more", rest.len()),
                None => continue,
            };
            items.push(VaultCheckItem::new(*path, detail));
        }
    }
    tally("case-collisions", items)
}

fn illegal_names(census: &Census) -> VaultCheckResult {
    tally(
        "illegal-names",
        every_path(census)
            .filter_map(|path| {
                path.split('/')
                    .find_map(illegal_reason)
                    .map(|why| VaultCheckItem::new(path, why))
            })
            .collect(),
    )
}

/// Why one path segment is unusable on Windows, or `None`.
fn illegal_reason(seg: &str) -> Option<String> {
    if let Some(c) = seg.chars().find(|c| ILLEGAL_CHARS.contains(c)) {
        return Some(format!("contains `{c}`"));
    }
    if let Some(c) = seg.chars().find(|c| c.is_control()) {
        return Some(format!("contains a control character (U+{:04X})", c as u32));
    }
    if seg.ends_with('.') {
        return Some("ends with `.`".to_string());
    }
    if seg.ends_with(' ') {
        return Some("ends with a space".to_string());
    }
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    if RESERVED_STEMS.contains(&stem.as_str()) {
        return Some(format!("`{stem}` is a reserved name on Windows"));
    }
    None
}

fn long_paths(census: &Census) -> VaultCheckResult {
    tally(
        "long-paths",
        every_path(census)
            .filter_map(|path| {
                let len = path.chars().count();
                (len > LONG_PATH_CHARS)
                    .then(|| VaultCheckItem::new(path, format!("{len} characters")))
            })
            .collect(),
    )
}

/// Index rows the files have moved on from. mtime, not sha256: re-hashing every
/// note would make this check cost more than the re-index it recommends, and a
/// changed file always carries a changed mtime (the indexer keys on the same
/// signal — see `Index::rebuild`).
fn stale_index(census: &Census) -> VaultCheckResult {
    let on_disk: HashMap<&str, &SizedFile> =
        census.notes.iter().map(|f| (f.path.as_str(), f)).collect();
    tally(
        "stale-index",
        census
            .note_rows
            .iter()
            .filter_map(|row| {
                let item = match on_disk.get(row.path.as_str()) {
                    None => VaultCheckItem::new(&row.path, "file missing"),
                    // The index stores SECONDS; the census carries milliseconds.
                    Some(file) if file.mtime / 1000 != row.mtime => {
                        VaultCheckItem::new(&row.path, "file changed since indexed")
                    }
                    Some(_) => return None,
                };
                Some(item.with_doc(&row.id))
            })
            .collect(),
    )
}

/// Dangling `[[wikilinks]]`, rolled up per SOURCE note — `count` is how many
/// notes have at least one, not how many links dangle (`VaultStats.brokenLinks`
/// already carries that total).
fn broken_links(index: &Index, census: &Census, scans: &[NoteScan]) -> AppResult<VaultCheckResult> {
    let mut by_source: Vec<(String, String, i64)> = Vec::new();
    // Validate old index rows against current bytes, including indexes built before
    // literal code examples were excluded from link extraction.
    let live: HashMap<&str, Vec<String>> = scans
        .iter()
        .filter_map(|scan| {
            scan.text.as_ref().map(|text| {
                (
                    scan.rel.as_str(),
                    parse::parse_note(text, "")
                        .links
                        .into_iter()
                        .map(|link| link.raw)
                        .collect(),
                )
            })
        })
        .collect();
    for (src, raw) in index.unresolved_links()? {
        if let Some(path) = census.path_by_id.get(&src) {
            if let Some(targets) = live.get(path.as_str()) {
                if !targets.contains(&raw) {
                    continue;
                }
            }
        }
        match by_source.last_mut() {
            Some((last_src, _, n)) if *last_src == src => *n += 1,
            _ => by_source.push((src, raw, 1)),
        }
    }
    let items = by_source
        .into_iter()
        .filter_map(|(src, first, n)| {
            let path = census.path_by_id.get(&src)?;
            let detail = if n > 1 {
                format!("`{first}` and {} more", n - 1)
            } else {
                format!("`{first}`")
            };
            Some(VaultCheckItem::new(path, detail).with_doc(src))
        })
        .collect();
    Ok(tally("broken-links", items))
}

/// `![[file]]` and `![](path)` embeds whose target is nowhere in the vault.
fn missing_embeds(census: &Census, scans: &[NoteScan]) -> VaultCheckResult {
    let resolver = EmbedResolver::build(census);
    let mut items = Vec::new();
    for scan in scans.iter().filter(|s| s.indexed) {
        let Some(text) = scan.text.as_deref() else {
            continue;
        };
        if scan.bytes > MAX_EMBED_SCAN_BYTES {
            continue;
        }
        let mut seen: HashSet<String> = HashSet::new();
        for target in embed_targets(text) {
            if !seen.insert(target.clone()) {
                continue; // the same broken image ten times is one finding
            }
            if !resolver.resolves(&scan.rel, &target) {
                items.push(VaultCheckItem::new(&scan.rel, format!("`{target}`")));
            }
        }
    }
    tally("missing-embeds", items)
}

/// Every embed target in a note, alias and heading already stripped, external
/// and inline-data URLs already dropped.
fn embed_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for cap in EMBED_WIKI_RE.captures_iter(text) {
        let raw = cap[1].trim();
        let target = raw
            .split('|')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
    }
    for cap in EMBED_MD_RE.captures_iter(text) {
        // `(path "title")` and `(<path with spaces>)` are both legal.
        let inner = cap[1].trim();
        let path = inner
            .strip_prefix('<')
            .and_then(|r| r.split('>').next())
            .unwrap_or_else(|| inner.split_whitespace().next().unwrap_or(""));
        let path = percent_decode(path.trim());
        if path.is_empty() || path.starts_with('#') || path.contains("://") {
            continue; // an anchor, or a remote image nothing local can be missing
        }
        if path.starts_with("data:") || path.starts_with("mailto:") {
            continue;
        }
        out.push(path);
    }
    out
}

/// `%20` and friends. Editors percent-encode spaces into markdown links, so
/// without this every `![](my%20photo.png)` reads as missing.
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// The lowercase lookups an embed is resolved against. Case-insensitive
/// throughout, exactly like `Index::resolve_wikilink`'s `lower(path)` queries —
/// a vault whose disk says `Attachments/` and whose link says `attachments/`
/// works on macOS and must not be reported as broken.
struct EmbedResolver {
    /// Every file's vault-relative path, lowercased.
    files: HashSet<String>,
    /// Every file's basename, lowercased.
    basenames: HashSet<String>,
    /// Every note's basename without `.md`, and every note title, lowercased —
    /// so `![[Some Note]]` (an embedded NOTE, not a file) resolves.
    note_names: HashSet<String>,
}

impl EmbedResolver {
    fn build(census: &Census) -> Self {
        let mut files = HashSet::new();
        let mut basenames = HashSet::new();
        for file in census
            .notes
            .iter()
            .chain(&census.attachments)
            .chain(&census.others)
        {
            let lower = file.path.to_lowercase();
            basenames.insert(basename(&lower).to_string());
            files.insert(lower);
        }
        let mut note_names = HashSet::new();
        for row in &census.note_rows {
            let lower = row.path.to_lowercase();
            note_names.insert(basename(&lower).trim_end_matches(".md").to_string());
            if !row.title.is_empty() {
                note_names.insert(row.title.to_lowercase());
            }
        }
        EmbedResolver {
            files,
            basenames,
            note_names,
        }
    }

    /// The app's own resolution order: relative to the embedding note, then
    /// vault-root-relative, then the `attachments/` store, then the basename
    /// anywhere, then (for an extensionless target) a note by name or title.
    fn resolves(&self, note_rel: &str, target: &str) -> bool {
        let target = target.to_lowercase();
        let base = basename(&target).to_string();
        let dir = note_rel.to_lowercase();
        let dir = dir.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let relative = if dir.is_empty() {
            target.clone()
        } else {
            format!("{dir}/{target}")
        };
        if self.files.contains(&normalize_rel(&relative)) {
            return true;
        }
        if self.files.contains(&normalize_rel(&target)) {
            return true;
        }
        if self.files.contains(&format!("attachments/{base}")) {
            return true;
        }
        if self.basenames.contains(&base) {
            return true;
        }
        // An embedded note: `![[Meeting Notes]]` carries no extension and
        // resolves by basename or title, like any other wikilink.
        !base.contains('.') && self.note_names.contains(&base)
    }
}

/// Collapse `.` and `..` in a forward-slash relative path.
fn normalize_rel(rel: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Notes sharing one derived title. `[[Title]]` resolves to whichever of them
/// the index happens to return first, so the link is a coin flip.
fn duplicate_titles(census: &Census) -> VaultCheckResult {
    let mut groups: BTreeMap<String, Vec<&crate::index::NoteRow>> = BTreeMap::new();
    for row in &census.note_rows {
        if row.title.trim().is_empty() {
            continue;
        }
        groups
            .entry(row.title.to_lowercase())
            .or_default()
            .push(row);
    }
    let mut items = Vec::new();
    for (_, rows) in groups.iter().filter(|(_, r)| r.len() > 1) {
        for row in rows {
            items.push(VaultCheckItem::new(&row.path, &row.title).with_doc(&row.id));
        }
    }
    tally("duplicate-titles", items)
}

/// Markdown on disk the index never picked up — invisible to search, backlinks
/// and sync until a re-index.
fn unindexed_markdown(census: &Census) -> VaultCheckResult {
    tally(
        "unindexed-markdown",
        census
            .others
            .iter()
            .filter(|f| is_markdown(&f.path))
            .map(|f| VaultCheckItem::bare(&f.path).with_bytes(f.bytes))
            .collect(),
    )
}

/// Notes at or above the server's per-note ceiling. `cap` is a parameter only so
/// the test can exercise the rule without writing a 10 MB file.
fn oversized_notes(notes: &[SizedFile], cap: i64) -> VaultCheckResult {
    tally_by_bytes(
        "oversized-notes",
        notes
            .iter()
            .filter(|f| f.bytes >= cap)
            .map(|f| {
                VaultCheckItem::new(&f.path, format!("{} MB", f.bytes / (1024 * 1024)))
                    .with_bytes(f.bytes)
            })
            .collect(),
    )
}

/// Docs carrying far more CRDT history than their file is worth. Orphans are
/// deliberately excluded — they have no file to compare against and are reported
/// by `orphan-history`, which is also where their remedy lives.
fn heavy_history(
    footprints: &[crate::index::DocHistory],
    census: &Census,
    live_docs: &HashMap<String, String>,
) -> VaultCheckResult {
    let file_bytes: HashMap<&str, i64> = census
        .notes
        .iter()
        .map(|f| (f.path.as_str(), f.bytes))
        .collect();
    let mut items = Vec::new();
    for doc in footprints {
        let Some(path) = doc_path(&doc.doc_id, census, live_docs) else {
            continue;
        };
        let on_disk = file_bytes.get(path.as_str()).copied().unwrap_or(0);
        let ratio_heavy =
            doc.bytes >= HEAVY_HISTORY_MIN_BYTES && doc.bytes > HEAVY_HISTORY_RATIO * on_disk;
        if !ratio_heavy && doc.updates <= HEAVY_HISTORY_MAX_UPDATES {
            continue;
        }
        let detail = if on_disk > 0 {
            format!("{} updates, {}× the file", doc.updates, doc.bytes / on_disk)
        } else {
            format!("{} updates, the file is empty", doc.updates)
        };
        items.push(
            VaultCheckItem::new(path, detail)
                .with_doc(&doc.doc_id)
                .with_bytes(doc.bytes),
        );
    }
    tally_by_bytes("heavy-history", items)
}

/// History no live id claims. EXACTLY `stats::collect`'s orphan rule: not in
/// `notes.id` and not in the registry's doc-id map, which is what
/// `prune_yjs_docs` would actually remove.
fn orphan_history(
    footprints: &[crate::index::DocHistory],
    census: &Census,
    live_docs: &HashMap<String, String>,
) -> VaultCheckResult {
    tally_by_bytes(
        "orphan-history",
        footprints
            .iter()
            .filter(|doc| doc_path(&doc.doc_id, census, live_docs).is_none())
            .map(|doc| {
                VaultCheckItem::new(&doc.doc_id, format!("{} updates", doc.updates))
                    .with_doc(&doc.doc_id)
                    .with_bytes(doc.bytes)
            })
            .collect(),
    )
}

/// The path a doc id still belongs to, from the index first and the registry
/// second. `None` means orphan.
fn doc_path(doc_id: &str, census: &Census, live_docs: &HashMap<String, String>) -> Option<String> {
    census
        .path_by_id
        .get(doc_id)
        .or_else(|| live_docs.get(doc_id))
        .cloned()
}

/// Recovery copies under `.context/trash`, newest stamp first. These are
/// unsendable local edits plus deleted-note copies retained by older versions.
/// `count` is files, `bytes` their total; each item is one timestamp directory.
fn trash(vault: &Path) -> VaultCheckResult {
    let root = vault.join(TRASH_DIR);
    let mut items: Vec<(i64, VaultCheckItem)> = Vec::new(); // (mtime, item)
    let mut total_files = 0i64;
    let mut total_bytes = 0i64;
    let Ok(entries) = std::fs::read_dir(&root) else {
        return VaultCheckResult {
            id: "trash",
            count: 0,
            bytes: Some(0),
            items: Vec::new(),
        };
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let (files, bytes) = dir_totals(&entry.path());
        total_files += files;
        total_bytes += bytes;
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let detail = if files == 1 {
            "1 file".to_string()
        } else {
            format!("{files} files")
        };
        items.push((mtime, VaultCheckItem::new(name, detail).with_bytes(bytes)));
    }
    // Newest first — a stamp directory IS a timestamp, and the copy someone
    // wants back is almost always the last one made.
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.path.cmp(&a.1.path)));
    let mut items: Vec<VaultCheckItem> = items.into_iter().map(|(_, item)| item).collect();
    items.truncate(MAX_ITEMS);
    VaultCheckResult {
        id: "trash",
        count: total_files,
        bytes: Some(total_bytes),
        items,
    }
}

/// Files and bytes under `path` (which may itself be a file). Never follows
/// symlinks — a link into the vault proper would otherwise double-count it, and
/// a link out of it would report someone's home directory as trash.
fn dir_totals(path: &Path) -> (i64, i64) {
    let mut files = 0i64;
    let mut bytes = 0i64;
    for entry in WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            files += 1;
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0) as i64;
        }
    }
    (files, bytes)
}

// ---- Empty trash ----------------------------------------------------------

/// What one [`empty_trash`] pass freed.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmptyTrashReport {
    pub files_removed: i64,
    pub bytes_freed: i64,
}

/// Delete every recovery copy under `<vault>/.context/trash`, leaving the
/// directory itself in place and empty.
///
/// The path is derived from the vault root and a constant — no caller-supplied
/// component reaches it, so there is nothing to traverse out of. A trash
/// directory that is a SYMLINK is refused rather than followed: `remove_dir_all`
/// through a link would delete whatever it points at, and nothing this app
/// writes ever creates one.
pub fn empty_trash(vault: &Path) -> AppResult<EmptyTrashReport> {
    let root = vault.join(TRASH_DIR);
    let Ok(meta) = std::fs::symlink_metadata(&root) else {
        // Nothing has ever been deleted in this vault. Not an error.
        return Ok(EmptyTrashReport::default());
    };
    if meta.file_type().is_symlink() {
        return Err(AppError::new(
            "refusing to empty a trash directory that is a symlink",
        ));
    }
    if !meta.is_dir() {
        return Err(AppError::new(".context/trash is not a directory"));
    }
    let (files_removed, bytes_freed) = dir_totals(&root);
    std::fs::remove_dir_all(&root)?;
    std::fs::create_dir_all(&root)?;
    Ok(EmptyTrashReport {
        files_removed,
        bytes_freed,
    })
}

// ---- Small helpers --------------------------------------------------------

/// Every path the name/path checks apply to: notes, attachments, other files
/// and folders. Folders count because an illegal or colliding FOLDER name breaks
/// every note under it.
fn every_path(census: &Census) -> impl Iterator<Item = &str> {
    census
        .notes
        .iter()
        .chain(&census.attachments)
        .chain(&census.others)
        .map(|f| f.path.as_str())
        .chain(census.folders.iter().map(|f| f.as_str()))
}

/// Truncate for a one-line detail, on a char boundary.
fn ellipsis(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn result<'a>(checks: &'a VaultChecks, id: &str) -> &'a VaultCheckResult {
        checks
            .results
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no result for {id}"))
    }

    fn paths(r: &VaultCheckResult) -> Vec<&str> {
        r.items.iter().map(|i| i.path.as_str()).collect()
    }

    impl VaultChecks {
        fn count_of(&self, id: &str) -> i64 {
            self.results.iter().find(|r| r.id == id).unwrap().count
        }
    }

    /// A synthetic census, for the checks whose trigger a real filesystem cannot
    /// reproduce portably (macOS folds `Foo.md` and `foo.md` into ONE file, which
    /// is the whole reason `case-collisions` exists).
    fn census_of(files: &[&str], folders: &[&str]) -> Census {
        Census {
            notes: files
                .iter()
                .map(|p| SizedFile {
                    path: (*p).to_string(),
                    bytes: 1,
                    mtime: 0,
                })
                .collect(),
            attachments: Vec::new(),
            others: Vec::new(),
            folders: folders.iter().map(|f| (*f).to_string()).collect(),
            note_rows: Vec::new(),
            id_by_path: HashMap::new(),
            path_by_id: HashMap::new(),
        }
    }

    #[test]
    fn broken_links_ignore_literal_examples_even_with_old_index_rows() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Example.md"), "[[wikilink]]").unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        assert_eq!(run(&tmp, &index).count_of("broken-links"), 1);
        fs::write(
            tmp.path().join("Example.md"),
            "Type `[[wikilink]]` to insert a link.",
        )
        .unwrap();
        assert_eq!(run(&tmp, &index).count_of("broken-links"), 0);
    }

    /// One vault that trips most checks at once, so each is tested against the
    /// others' noise rather than in isolation.
    fn fixture() -> (tempfile::TempDir, Index) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Clean control note: nothing should flag it.
        fs::write(root.join("Good.md"), "# Good\n\nplain text\n").unwrap();
        // empty-notes
        fs::write(root.join("Empty.md"), "").unwrap();
        // bad-frontmatter x2: never closes / not `key: value`.
        fs::write(root.join("Unclosed.md"), "---\ntitle: x\n\nbody\n").unwrap();
        fs::write(root.join("NotYaml.md"), "---\njust a sentence\n---\nbody\n").unwrap();
        // broken-links (2 wikilinks + the unresolvable embed) + missing-embeds (2).
        fs::write(
            root.join("Links.md"),
            "see [[Nowhere]] and [[AlsoNowhere]]\n\n![[missing.png]]\n![](gone.png)\n",
        )
        .unwrap();
        // duplicate-titles
        fs::create_dir_all(root.join("dup")).unwrap();
        fs::write(root.join("dup/a.md"), "---\ntitle: Same Title\n---\n").unwrap();
        fs::write(root.join("dup/b.md"), "---\ntitle: same title\n---\n").unwrap();
        // An attachment that DOES exist, so resolvable embeds are covered too.
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("attachments/there.png"), [1u8, 2, 3]).unwrap();
        fs::write(
            root.join("Embeds.md"),
            "![](attachments/there.png)\n![](there.png)\n",
        )
        .unwrap();

        let index = Index::open(root).unwrap();
        index.rebuild(root).unwrap();

        // Both of these are written AFTER the rebuild, so neither has a `notes`
        // row. Latin1.md CANNOT have one: `Index::index_one` reads with
        // `read_to_string`, so a non-UTF-8 file fails to index (and, today, fails
        // the whole `rebuild` — which is why it cannot be in the vault above).
        fs::write(root.join("Unindexed.md"), "# later\n").unwrap();
        fs::write(root.join("Latin1.md"), [b'a', 0xE9, b'b']).unwrap();
        // trash
        fs::create_dir_all(root.join(".context/trash/s1")).unwrap();
        fs::write(root.join(".context/trash/s1/gone.md"), "recovered text").unwrap();

        (tmp, index)
    }

    fn run(tmp: &tempfile::TempDir, index: &Index) -> VaultChecks {
        collect(tmp.path(), index, &HashMap::new()).unwrap()
    }

    #[test]
    fn every_id_is_reported_in_union_order() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);
        let ids: Vec<&str> = checks.results.iter().map(|r| r.id).collect();
        assert_eq!(ids, CHECK_IDS.to_vec());
        assert_eq!(checks.results.len(), 15);
        assert!(checks.computed_at > 0);
    }

    #[test]
    fn a_clean_vault_reports_every_check_at_zero() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Only.md"), "# Only\n\ntext\n").unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        let checks = collect(tmp.path(), &index, &HashMap::new()).unwrap();

        assert_eq!(checks.results.len(), 15);
        for r in &checks.results {
            assert_eq!(r.count, 0, "{} should be clean", r.id);
            assert!(r.items.is_empty(), "{} should have no items", r.id);
        }
    }

    #[test]
    fn finds_empty_and_unreadable_notes() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);

        assert_eq!(paths(result(&checks, "empty-notes")), vec!["Empty.md"]);

        let unreadable = result(&checks, "unreadable-notes");
        assert_eq!(paths(unreadable), vec!["Latin1.md"]);
        assert_eq!(
            unreadable.items[0].detail.as_deref(),
            Some("not valid UTF-8")
        );
    }

    #[test]
    fn a_nul_byte_makes_a_note_unreadable_too() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Nul.md"), b"before\0after").unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        let checks = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        let unreadable = result(&checks, "unreadable-notes");
        assert_eq!(paths(unreadable), vec!["Nul.md"]);
        assert_eq!(
            unreadable.items[0].detail.as_deref(),
            Some("contains NUL bytes")
        );
    }

    #[test]
    fn finds_bad_frontmatter_in_indexed_notes() {
        let (tmp, index) = fixture();
        let fm = result(&run(&tmp, &index), "bad-frontmatter").clone();
        assert_eq!(fm.count, 2);
        assert_eq!(paths(&fm), vec!["NotYaml.md", "Unclosed.md"]);
        let unclosed = fm.items.iter().find(|i| i.path == "Unclosed.md").unwrap();
        assert_eq!(unclosed.detail.as_deref(), Some("no closing `---` line"));
        let not_yaml = fm.items.iter().find(|i| i.path == "NotYaml.md").unwrap();
        assert!(not_yaml
            .detail
            .as_deref()
            .unwrap()
            .contains("not `key: value`"));
    }

    #[test]
    fn frontmatter_predicate_accepts_real_yaml_and_rejects_prose() {
        assert_eq!(frontmatter_problem("no frontmatter here"), None);
        assert_eq!(
            frontmatter_problem("---\ntitle: A\ntags:\n  - one\n  - two\n# a comment\n\n---\nbody"),
            None
        );
        assert_eq!(frontmatter_problem("---\n- one\n- two\n---\nbody"), None);
        assert_eq!(
            frontmatter_problem("---\nopen: yes\n"),
            Some("no closing `---` line".to_string())
        );
        assert!(frontmatter_problem("---\nplain sentence\n---\nbody")
            .unwrap()
            .contains("not `key: value`"));
        // A `---` that is not at the very start is a horizontal rule, not a fence.
        assert_eq!(frontmatter_problem("intro\n\n---\n\nrest"), None);
        // A key that is empty is not `key: value` either.
        assert!(frontmatter_problem("---\n: orphaned\n---\nbody").is_some());
    }

    #[test]
    fn case_collisions_name_their_siblings() {
        // Synthetic: a case-insensitive filesystem cannot hold both of these.
        let census = census_of(&["Foo.md", "foo.md", "Only.md"], &["Docs", "docs"]);
        let r = case_collisions(&census);
        assert_eq!(r.count, 4, "two files and two folders");
        assert_eq!(paths(&r), vec!["Docs", "Foo.md", "docs", "foo.md"]);
        let foo = r.items.iter().find(|i| i.path == "Foo.md").unwrap();
        assert_eq!(foo.detail.as_deref(), Some("also `foo.md`"));
        assert!(!paths(&r).contains(&"Only.md"));
    }

    #[test]
    fn a_three_way_collision_counts_the_rest() {
        let census = census_of(&["A.md", "a.md", "A.MD"], &[]);
        let r = case_collisions(&census);
        assert_eq!(r.count, 3);
        assert_eq!(paths(&r), vec!["A.MD", "A.md", "a.md"]);
        // Each row names one sibling and counts the rest.
        let a_md = r.items.iter().find(|i| i.path == "A.md").unwrap();
        assert_eq!(a_md.detail.as_deref(), Some("also `A.MD` and 1 more"));
    }

    #[test]
    fn a_real_vault_with_no_collisions_reports_none() {
        let (tmp, index) = fixture();
        assert_eq!(run(&tmp, &index).count_of("case-collisions"), 0);
    }

    #[test]
    fn illegal_name_predicate_covers_every_windows_rule() {
        assert_eq!(illegal_reason("ordinary name.md"), None);
        assert_eq!(illegal_reason("a<b.md").as_deref(), Some("contains `<`"));
        assert_eq!(illegal_reason("a|b.md").as_deref(), Some("contains `|`"));
        assert_eq!(illegal_reason("a:b.md").as_deref(), Some("contains `:`"));
        assert_eq!(
            illegal_reason("trailing.").as_deref(),
            Some("ends with `.`")
        );
        assert_eq!(
            illegal_reason("trailing ").as_deref(),
            Some("ends with a space")
        );
        assert!(illegal_reason("CON.md").unwrap().contains("reserved"));
        assert!(illegal_reason("com9.txt").unwrap().contains("reserved"));
        assert!(illegal_reason("a\u{1}b")
            .unwrap()
            .contains("control character"));
        // Not reserved: a longer stem that merely starts with one.
        assert_eq!(illegal_reason("CONTENTS.md"), None);
    }

    #[test]
    fn illegal_names_and_long_paths_read_every_bucket() {
        let long = "L".repeat(198); // + ".md" = 201 characters
        let census = census_of(&["CON.md", "ok.md", &format!("{long}.md")], &["a<b"]);
        let illegal = illegal_names(&census);
        assert_eq!(paths(&illegal), vec!["CON.md", "a<b"]);
        assert!(illegal.items[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("reserved"));

        let long = long_paths(&census);
        assert_eq!(long.count, 1);
        assert_eq!(long.items[0].detail.as_deref(), Some("201 characters"));
        // 200 exactly is fine; the rule is strictly greater.
        assert_eq!(
            long_paths(&census_of(&["x".repeat(200).as_str()], &[])).count,
            0
        );
    }

    /// Only on a filesystem that will hold such a name — Windows refuses them,
    /// which is the entire point of the check.
    #[cfg(not(windows))]
    #[test]
    fn a_reserved_name_on_disk_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("CON.md"), "# reserved\n").unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        let checks = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        assert_eq!(paths(result(&checks, "illegal-names")), vec!["CON.md"]);
    }

    #[test]
    fn stale_index_sees_a_touched_file_and_a_deleted_one() {
        let (tmp, index) = fixture();
        // Nothing has changed since the rebuild.
        assert_eq!(run(&tmp, &index).count_of("stale-index"), 0);

        // A file the index still has a row for, now gone from disk.
        fs::remove_file(tmp.path().join("Good.md")).unwrap();
        // A file whose mtime is plainly older than the one recorded at index time.
        let touched = tmp.path().join("NotYaml.md");
        let ten_min_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let handle = fs::File::options().write(true).open(&touched).unwrap();
        handle
            .set_times(fs::FileTimes::new().set_modified(ten_min_ago))
            .unwrap();

        let checks = run(&tmp, &index);
        let stale = result(&checks, "stale-index");
        assert_eq!(stale.count, 2);
        let missing = stale.items.iter().find(|i| i.path == "Good.md").unwrap();
        assert_eq!(missing.detail.as_deref(), Some("file missing"));
        assert!(missing.doc_id.is_some(), "the remedy needs the doc id");
        let changed = stale.items.iter().find(|i| i.path == "NotYaml.md").unwrap();
        assert_eq!(
            changed.detail.as_deref(),
            Some("file changed since indexed")
        );
    }

    #[test]
    fn broken_links_roll_up_per_source_note() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);
        let broken = result(&checks, "broken-links");
        assert_eq!(broken.count, 1, "one SOURCE note, not three links");
        assert_eq!(broken.items[0].path, "Links.md");
        // In document order: `[[Nowhere]]`, `[[AlsoNowhere]]`, `![[missing.png]]`.
        assert_eq!(
            broken.items[0].detail.as_deref(),
            Some("`Nowhere` and 2 more")
        );
        assert!(broken.items[0].doc_id.is_some());
    }

    #[test]
    fn missing_embeds_flags_only_targets_that_are_really_absent() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);
        let missing = result(&checks, "missing-embeds");
        assert_eq!(missing.count, 2);
        assert!(missing.items.iter().all(|i| i.path == "Links.md"));
        let details: Vec<&str> = missing
            .items
            .iter()
            .map(|i| i.detail.as_deref().unwrap())
            .collect();
        assert!(details.contains(&"`missing.png`"));
        assert!(details.contains(&"`gone.png`"));
        // Embeds.md resolves both of its targets and is absent entirely.
        assert!(!paths(missing).contains(&"Embeds.md"));
    }

    #[test]
    fn embed_resolution_follows_the_apps_own_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::create_dir_all(root.join("Notes/sub")).unwrap();
        fs::write(root.join("attachments/pic.png"), [1u8]).unwrap();
        fs::write(root.join("Notes/sub/local.png"), [1u8]).unwrap();
        fs::write(root.join("Notes/Target.md"), "# Target\n").unwrap();
        fs::write(root.join("Notes/sub/n.md"), "x").unwrap();
        let index = Index::open(root).unwrap();
        index.rebuild(root).unwrap();
        let census = census_files(root, &index).unwrap();
        let r = EmbedResolver::build(&census);

        let from = "Notes/sub/n.md";
        assert!(r.resolves(from, "local.png"), "next to the note");
        assert!(r.resolves(from, "./local.png"), "explicit ./");
        assert!(r.resolves(from, "../../attachments/pic.png"), "via ..");
        assert!(
            r.resolves(from, "attachments/pic.png"),
            "vault-root relative"
        );
        assert!(r.resolves(from, "pic.png"), "basename anywhere");
        assert!(r.resolves(from, "PIC.PNG"), "case-insensitive");
        assert!(r.resolves(from, "Target"), "an embedded note by name");
        assert!(!r.resolves(from, "nope.png"));
        assert!(!r.resolves(from, "Nope"));
    }

    #[test]
    fn embed_targets_skip_remote_and_decode_escapes() {
        let found = embed_targets(
            "![](https://example.com/a.png)\n![](data:image/png;base64,AAA)\n\
             ![alt](my%20photo.png)\n![](<spaced name.png>)\n![](local.png \"title\")\n\
             ![[wiki.png|200]]\n![[note#heading]]\n",
        );
        assert_eq!(
            found,
            vec![
                "wiki.png",
                "note",
                "my photo.png",
                "spaced name.png",
                "local.png",
            ]
        );
    }

    #[test]
    fn duplicate_titles_pair_up_case_insensitively() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);
        let dupes = result(&checks, "duplicate-titles");
        assert_eq!(dupes.count, 2);
        assert_eq!(paths(dupes), vec!["dup/a.md", "dup/b.md"]);
        assert_eq!(dupes.items[0].detail.as_deref(), Some("Same Title"));
        assert!(dupes.items[0].doc_id.is_some());
    }

    #[test]
    fn unindexed_markdown_is_what_the_index_never_saw() {
        let (tmp, index) = fixture();
        let checks = run(&tmp, &index);
        assert_eq!(
            paths(result(&checks, "unindexed-markdown")),
            vec!["Latin1.md", "Unindexed.md"]
        );
        // The attachment is not markdown and is not reported here.
        assert!(!paths(result(&checks, "unindexed-markdown")).contains(&"attachments/there.png"));
    }

    #[test]
    fn oversized_notes_use_the_server_cap_and_sum_their_bytes() {
        let notes = vec![
            SizedFile {
                path: "small.md".into(),
                bytes: 10,
                mtime: 0,
            },
            SizedFile {
                path: "big.md".into(),
                bytes: 500,
                mtime: 0,
            },
            SizedFile {
                path: "huge.md".into(),
                bytes: 900,
                mtime: 0,
            },
        ];
        // The cap is a parameter only so this can run without writing 10 MB twice.
        let r = oversized_notes(&notes, 100);
        assert_eq!(r.count, 2);
        assert_eq!(r.bytes, Some(1400));
        assert_eq!(paths(&r), vec!["huge.md", "big.md"], "largest first");
        assert_eq!(r.items[0].bytes, Some(900));
        // At the cap, not merely above it.
        assert_eq!(oversized_notes(&notes, 500).count, 2);
        assert_eq!(oversized_notes(&notes, 901).count, 0);
        // And the production cap is the server's.
        assert_eq!(MAX_NOTE_BYTES, 10 * 1024 * 1024);
    }

    #[test]
    fn heavy_history_catches_an_uncompacted_update_log() {
        let (tmp, index) = fixture();
        let doc = index
            .note_rows()
            .unwrap()
            .into_iter()
            .find(|r| r.path == "Good.md")
            .unwrap()
            .id;
        for _ in 0..(HEAVY_HISTORY_MAX_UPDATES + 1) {
            index.append_yjs_update(&doc, &[0u8; 4]).unwrap();
        }
        let checks = run(&tmp, &index);
        let heavy = result(&checks, "heavy-history");
        assert_eq!(heavy.count, 1);
        assert_eq!(heavy.items[0].path, "Good.md");
        assert_eq!(heavy.items[0].doc_id.as_deref(), Some(doc.as_str()));
        assert!(heavy.items[0]
            .detail
            .as_deref()
            .unwrap()
            .starts_with("257 updates"));
        assert_eq!(heavy.bytes, Some(257 * 4));
    }

    #[test]
    fn a_small_note_with_a_little_history_is_not_heavy() {
        let (tmp, index) = fixture();
        let doc = index
            .note_rows()
            .unwrap()
            .into_iter()
            .find(|r| r.path == "Good.md")
            .unwrap()
            .id;
        // 2 KB of history over a ~21-byte file is ~100×, but far under the floor.
        index.append_yjs_update(&doc, &[0u8; 2048]).unwrap();
        assert_eq!(run(&tmp, &index).count_of("heavy-history"), 0);
    }

    #[test]
    fn an_orphan_is_never_also_reported_as_heavy() {
        let (tmp, index) = fixture();
        for _ in 0..300 {
            index.append_yjs_update("no-such-doc", &[0u8; 4]).unwrap();
        }
        let checks = run(&tmp, &index);
        assert_eq!(checks.count_of("heavy-history"), 0, "orphans have no file");
        assert_eq!(checks.count_of("orphan-history"), 1);
    }

    #[test]
    fn orphan_history_matches_the_stats_rule_including_registry_ids() {
        let (tmp, index) = fixture();
        index
            .append_yjs_update("registry-only", &[0u8; 64])
            .unwrap();
        index.append_yjs_update("truly-orphan", &[0u8; 32]).unwrap();

        // With no registry map, both are orphans.
        let checks = run(&tmp, &index);
        let orphans = result(&checks, "orphan-history");
        assert_eq!(orphans.count, 2);
        assert_eq!(orphans.bytes, Some(96));
        assert_eq!(paths(orphans), vec!["registry-only", "truly-orphan"]);
        assert_eq!(orphans.items[0].doc_id.as_deref(), Some("registry-only"));

        // A registry id claims one of them: it stops being reclaimable, exactly
        // as in `stats::collect`.
        let mut live = HashMap::new();
        live.insert("registry-only".to_string(), "Good.md".to_string());
        let checks = collect(tmp.path(), &index, &live).unwrap();
        let orphans = result(&checks, "orphan-history");
        assert_eq!(orphans.count, 1);
        assert_eq!(orphans.bytes, Some(32));
        assert_eq!(paths(orphans), vec!["truly-orphan"]);
    }

    #[test]
    fn trash_counts_files_and_lists_stamp_dirs() {
        let (tmp, index) = fixture();
        fs::create_dir_all(tmp.path().join(".context/trash/s2")).unwrap();
        fs::write(tmp.path().join(".context/trash/s2/a.md"), "aa").unwrap();
        fs::write(tmp.path().join(".context/trash/s2/b.md"), "bbb").unwrap();

        let checks = run(&tmp, &index);
        let t = result(&checks, "trash");
        assert_eq!(t.count, 3, "files, not stamps");
        assert_eq!(t.bytes, Some("recovered text".len() as i64 + 5));
        assert_eq!(t.items.len(), 2);
        let s2 = t.items.iter().find(|i| i.path == "s2").unwrap();
        assert_eq!(s2.detail.as_deref(), Some("2 files"));
        assert_eq!(s2.bytes, Some(5));
        // Trash never leaks into the vault's own counts.
        assert_eq!(checks.count_of("unindexed-markdown"), 2);
    }

    #[test]
    fn empty_trash_removes_everything_and_keeps_the_directory() {
        let (tmp, index) = fixture();
        let report = empty_trash(tmp.path()).unwrap();
        assert_eq!(report.files_removed, 1);
        assert_eq!(report.bytes_freed, "recovered text".len() as i64);
        assert!(tmp.path().join(".context/trash").is_dir(), "dir survives");
        assert!(!tmp.path().join(".context/trash/s1").exists());

        // The check agrees afterwards, and a second pass is a no-op.
        assert_eq!(run(&tmp, &index).count_of("trash"), 0);
        assert_eq!(
            empty_trash(tmp.path()).unwrap(),
            EmptyTrashReport::default()
        );

        // Notes and the index itself are untouched — this only ever reaches
        // `.context/trash`.
        assert!(tmp.path().join("Good.md").is_file());
        assert!(tmp.path().join(".context/index.sqlite").is_file());
    }

    #[test]
    fn empty_trash_on_a_vault_that_never_deleted_anything_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            empty_trash(tmp.path()).unwrap(),
            EmptyTrashReport::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn empty_trash_refuses_a_symlinked_trash_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::write(elsewhere.path().join("precious.md"), "do not delete").unwrap();
        fs::create_dir_all(tmp.path().join(".context")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), tmp.path().join(".context/trash")).unwrap();

        assert!(empty_trash(tmp.path()).is_err());
        assert!(elsewhere.path().join("precious.md").is_file());
    }

    #[test]
    fn items_are_capped_at_25_but_the_count_is_true() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..40 {
            fs::write(tmp.path().join(format!("e{i:03}.md")), "").unwrap();
        }
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        let checks = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        let empty = result(&checks, "empty-notes");
        assert_eq!(empty.count, 40);
        assert_eq!(empty.items.len(), MAX_ITEMS);
        assert_eq!(empty.items[0].path, "e000.md", "path order");
    }

    #[test]
    fn serialises_to_the_camel_case_typescript_contract() {
        let (tmp, index) = fixture();
        index.append_yjs_update("orphan", &[0u8; 8]).unwrap();
        let json = serde_json::to_value(run(&tmp, &index)).unwrap();

        assert!(json.get("computedAt").is_some());
        assert!(json.get("results").is_some());
        assert_eq!(json.as_object().unwrap().len(), 2);

        let results = json["results"].as_array().unwrap();
        assert_eq!(results.len(), 15);
        let ids: Vec<&str> = results.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, CHECK_IDS.to_vec());
        for r in results {
            for key in ["id", "count", "bytes", "items"] {
                assert!(r.get(key).is_some(), "result is missing {key}");
            }
            assert_eq!(r.as_object().unwrap().len(), 4);
        }

        // Item keys, on a check the fixture guarantees is non-empty.
        let empty_notes = results.iter().find(|r| r["id"] == "empty-notes").unwrap();
        let item = &empty_notes["items"][0];
        for key in ["path", "docId", "detail", "bytes"] {
            assert!(item.get(key).is_some(), "item is missing {key}");
        }
        assert_eq!(item.as_object().unwrap().len(), 4);

        // An orphan carries its doc id in BOTH fields, since it has no path.
        let orphans = results
            .iter()
            .find(|r| r["id"] == "orphan-history")
            .unwrap();
        assert_eq!(orphans["items"][0]["path"], "orphan");
        assert_eq!(orphans["items"][0]["docId"], "orphan");
    }

    #[test]
    fn empty_trash_report_serialises_camel_case() {
        let json = serde_json::to_value(EmptyTrashReport {
            files_removed: 3,
            bytes_freed: 99,
        })
        .unwrap();
        assert_eq!(json["filesRemoved"], 3);
        assert_eq!(json["bytesFreed"], 99);
        assert_eq!(json.as_object().unwrap().len(), 2);
    }
}
