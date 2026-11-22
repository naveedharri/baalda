//! The vault's sync rules (#401): which paths the vault ignores, on top of the
//! fixed floor in `vault.rs` (`.context`, `.git`, lock and OS files; dot names and build folders unless switched on,
//! lock files, the extension allowlist).
//!
//! One setting per vault, written by its owners/admins on the server and the
//! same on every device. The desktop keeps the last copy it was given in
//! `<vault>/.context/sync-rules.json`, so a launch walks the vault with known
//! rules before the network answers; for a local-only vault that file is the
//! only copy.
//!
//! An ignored path is hidden and never synced: the tree walk, the index, the
//! watcher, the blob walk and every inbound write skip it, exactly like a dot
//! folder. Ignoring never deletes anything — the sync layer parks what it held
//! there (see `src/lib/sync/registry.ts`).
//!
//! ## The pattern language
//!
//! A gitignore subset, ONE CONTRACT with `src/lib/syncRules/match.ts`: both
//! compile a line to the same regular expression, and both run the shared
//! `src/lib/syncRules/fixtures.json` in their tests.
//!
//! - blank lines and `#` comments are skipped; `\#` / `\!` escape a leading
//!   `#` / `!`;
//! - `!` negates (re-includes) — the last matching line wins;
//! - a trailing `/` matches directories only;
//! - a pattern with a `/` anywhere but the end is anchored to the vault root
//!   (a leading `/` is dropped); without one it matches a name at any depth;
//! - `*` is any run within one segment, `?` one character, `**` any depth;
//! - matching ignores case, like every path comparison in sync.
//!
//! A path is excluded when it, or any folder above it, is excluded. As in git,
//! a file inside an excluded folder cannot be re-included.

use crate::error::{AppError, AppResult};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Caps, mirrored by the server's `sync-rules/schema.ts`. Past them a pattern
/// list is refused rather than half-applied.
pub const MAX_PATTERN_BYTES: usize = 64 * 1024;
pub const MAX_PATTERN_LINES: usize = 500;

/// Where the last-known rules live inside the vault.
const CACHE_REL: &str = ".context/sync-rules.json";

/// The wire/cache shape. Only `patterns` is read in this version; the other
/// keys are carried as given so a newer writer's settings survive a round trip.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulesDoc {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub patterns: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    /// The optional file-type groups this vault switches on (`vault.rs
    /// CODE_EXTS` / `EXTRA_EXTS`). Absent = both off, today's set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<RulesTypes>,
    /// The folder switches (`vault.rs OPT_IN_HIDDEN` / `OPT_IN_BUILD`).
    /// Absent = both off, today's set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<RulesFolders>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

/// Mirrors `SyncTypes` in `src/lib/syncRules/match.ts`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RulesTypes {
    #[serde(default)]
    pub code: bool,
    #[serde(default)]
    pub extra: bool,
}

/// Mirrors `SyncFolders` in `src/lib/syncRules/match.ts`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RulesFolders {
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub build: bool,
}

impl RulesDoc {
    /// The `vault.rs` opt-in bitmask these switches mean.
    pub fn opt_in_groups(&self) -> u8 {
        let t = self.types.unwrap_or_default();
        let f = self.folders.unwrap_or_default();
        (if t.code { crate::vault::OPT_IN_CODE } else { 0 })
            | (if t.extra { crate::vault::OPT_IN_EXTRA } else { 0 })
            | (if f.hidden { crate::vault::OPT_IN_HIDDEN } else { 0 })
            | (if f.build { crate::vault::OPT_IN_BUILD } else { 0 })
    }
}

#[derive(Debug)]
struct Rule {
    negate: bool,
    dir_only: bool,
    re: Regex,
}

/// The compiled rules for one vault.
#[derive(Debug, Default)]
pub struct SyncRules {
    rules: Vec<Rule>,
    doc: RulesDoc,
}

impl SyncRules {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Compile a rules document. Refuses patterns past the caps.
    pub fn compile(doc: RulesDoc) -> AppResult<Self> {
        if doc.patterns.len() > MAX_PATTERN_BYTES {
            return Err(AppError::new("sync rules are too long"));
        }
        let mut rules = Vec::new();
        for line in doc.patterns.lines() {
            if let Some(rule) = compile_line(line) {
                rules.push(rule);
            }
        }
        if rules.len() > MAX_PATTERN_LINES {
            return Err(AppError::new("too many sync rules"));
        }
        Ok(Self { rules, doc })
    }

    pub fn from_json(json: &str) -> AppResult<Self> {
        let doc: RulesDoc = serde_json::from_str(json)
            .map_err(|e| AppError::new(format!("invalid sync rules: {e}")))?;
        Self::compile(doc)
    }

    pub fn doc(&self) -> &RulesDoc {
        &self.doc
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The verdict for this path ALONE, ignoring the folders above it. Right
    /// for a top-down walk, which never reaches a child of an excluded folder.
    pub fn excludes_entry(&self, rel: &str, is_dir: bool) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            return false;
        }
        let mut excluded = false;
        for rule in &self.rules {
            if rule.dir_only && !is_dir {
                continue;
            }
            if rule.re.is_match(rel) {
                excluded = !rule.negate;
            }
        }
        excluded
    }

    /// Is this vault-relative path excluded, itself or through a folder above it?
    pub fn excludes(&self, rel: &str, is_dir: bool) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let rel = rel.trim_matches('/');
        let mut end = 0usize;
        // Every proper ancestor folder, shortest first.
        for (i, ch) in rel.char_indices() {
            if ch == '/' {
                if i > end && self.excludes_entry(&rel[..i], true) {
                    return true;
                }
                end = i + 1;
            }
        }
        self.excludes_entry(rel, is_dir)
    }
}

/// One line of the pattern language → a rule, or `None` for a blank/comment.
/// Mirrors `compileLine` in `src/lib/syncRules/match.ts`.
fn compile_line(raw: &str) -> Option<Rule> {
    let mut line = raw.trim_end_matches(['\r', ' ', '\t']).trim_start_matches([' ', '\t']);
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut negate = false;
    if let Some(rest) = line.strip_prefix('!') {
        negate = true;
        line = rest;
    } else if line.starts_with("\\!") || line.starts_with("\\#") {
        line = &line[1..];
    }
    let dir_only = line.ends_with('/');
    let line = line.trim_end_matches('/');
    if line.is_empty() {
        return None;
    }
    let anchored = line.contains('/');
    let line = line.trim_start_matches('/');
    if line.is_empty() {
        return None;
    }
    let body = glob_to_regex(line);
    let src = if anchored {
        format!("(?i)^{body}$")
    } else {
        format!("(?i)^(?:.*/)?{body}$")
    };
    Regex::new(&src).ok().map(|re| Rule { negate, dir_only, re })
}

/// Characters escaped in the regex body. Identical set on the TS side, and
/// every one of them is a legal escape in both regex dialects.
const REGEX_SPECIAL: &str = "\\.+()|[]{}^$#&-~";

/// `*` → within a segment, `?` → one character, `**` → any depth.
/// Mirrors `globToRegex` in `src/lib/syncRules/match.ts`.
fn glob_to_regex(glob: &str) -> String {
    let chars: Vec<char> = glob.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' && chars.get(i + 1) == Some(&'*') {
            let at_seg_start = i == 0 || chars[i - 1] == '/';
            if at_seg_start && chars.get(i + 2) == Some(&'/') {
                // `**/` — zero or more whole folders.
                out.push_str("(?:.*/)?");
                i += 3;
            } else {
                out.push_str(".*");
                i += 2;
            }
            continue;
        }
        match c {
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            _ if REGEX_SPECIAL.contains(c) => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

// ---- the active rules, per open vault ---------------------------------------

/// The rules each vault folder currently uses, keyed by the vault path the
/// app opened it under (the same `PathBuf` every command resolves against).
/// A map, not one slot: tests open many vaults side by side, and a stale
/// entry for a closed vault costs nothing.
static ACTIVE: Lazy<RwLock<HashMap<PathBuf, Arc<SyncRules>>>> = Lazy::new(|| RwLock::new(HashMap::new()));

/// The rules in force for `vault`, if any were installed.
pub fn active(vault: &Path) -> Option<Arc<SyncRules>> {
    let map = ACTIVE.read().ok()?;
    map.get(vault).filter(|r| !r.is_empty()).cloned()
}

/// Make `rules` the ones `vault` uses from now on.
pub fn install(vault: &Path, rules: SyncRules) {
    // The type switches follow the vault installed last: the one the app has open.
    crate::vault::set_opt_in_groups(rules.doc().opt_in_groups());
    if let Ok(mut map) = ACTIVE.write() {
        map.insert(vault.to_path_buf(), Arc::new(rules));
    }
}

/// Is this path excluded by the vault's own rules (the floor aside)?
pub fn excludes(vault: &Path, rel: &str, is_dir: bool) -> bool {
    active(vault).is_some_and(|r| r.excludes(rel, is_dir))
}

/// Read the cached rules from `<vault>/.context/sync-rules.json`. A missing or
/// unreadable cache is "no rules", which is today's behaviour.
pub fn read_cached(vault: &Path) -> Option<RulesDoc> {
    let bytes = std::fs::read(vault.join(CACHE_REL)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Load the cached rules and install them. Called on every vault open, BEFORE
/// the index rebuild and the first tree walk.
pub fn load_and_install(vault: &Path) {
    let rules = read_cached(vault)
        .and_then(|doc| match SyncRules::compile(doc) {
            Ok(r) => Some(r),
            Err(e) => {
                log::warn!("[sync-rules] ignoring the cached rules for {}: {e}", vault.display());
                None
            }
        })
        .unwrap_or_default();
    install(vault, rules);
}

/// Persist `doc` as the vault's cached rules and install it. The cache write is
/// atomic (temp + rename), so a crash leaves the old rules or the new ones.
pub fn save_and_install(vault: &Path, doc: RulesDoc) -> AppResult<()> {
    let rules = SyncRules::compile(doc)?;
    let json = serde_json::to_vec(rules.doc()).map_err(|e| AppError::new(e.to_string()))?;
    let target = vault.join(CACHE_REL);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::notefile::write_atomic_fsync(&target, &json)?;
    install(vault, rules);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        patterns: String,
        cases: Vec<(String, bool, bool)>,
    }

    /// The SAME fixtures the TS matcher runs (`match.test.ts`): a drift between
    /// the two implementations fails here or there, never silently.
    #[test]
    fn shared_fixtures() {
        let raw = include_str!("../../src/lib/syncRules/fixtures.json");
        let fixtures: Vec<Fixture> = serde_json::from_str(raw).unwrap();
        assert!(!fixtures.is_empty());
        for f in fixtures {
            let rules = SyncRules::compile(RulesDoc {
                patterns: f.patterns.clone(),
                ..Default::default()
            })
            .unwrap();
            for (path, is_dir, want) in &f.cases {
                assert_eq!(
                    rules.excludes(path, *is_dir),
                    *want,
                    "fixture {:?}: {path} (dir={is_dir})",
                    f.name
                );
            }
        }
    }

    #[test]
    fn empty_rules_exclude_nothing() {
        let r = SyncRules::empty();
        assert!(!r.excludes("projects/code/README.md", false));
        assert!(active(Path::new("/definitely/not/open")).is_none());
    }

    #[test]
    fn caps_refuse_rather_than_truncate() {
        let many = "a\n".repeat(MAX_PATTERN_LINES + 1);
        assert!(SyncRules::compile(RulesDoc { patterns: many, ..Default::default() }).is_err());
        let long = "a".repeat(MAX_PATTERN_BYTES + 1);
        assert!(SyncRules::compile(RulesDoc { patterns: long, ..Default::default() }).is_err());
    }

    fn vault_with_code_checkout() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("projects/my-app/code/src")).unwrap();
        std::fs::write(v.join("projects/my-app/context.md"), "# Context").unwrap();
        std::fs::write(v.join("projects/my-app/code/README.md"), "# Readme").unwrap();
        std::fs::write(v.join("projects/my-app/code/src/main.py"), "print(1)").unwrap();
        std::fs::write(v.join("projects/my-app/code/diagram.png"), [0u8; 4]).unwrap();
        dir
    }

    fn rule(v: &Path, patterns: &str) {
        save_and_install(v, RulesDoc { version: 1, patterns: patterns.into(), ..Default::default() }).unwrap();
    }

    fn paths(node: &crate::tree::TreeNode, out: &mut Vec<String>) {
        if !node.path.is_empty() {
            out.push(node.path.clone());
        }
        for c in node.children.iter().flatten() {
            paths(c, out);
        }
    }

    #[test]
    fn the_tree_and_the_lazy_listing_hide_an_excluded_folder() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        rule(v, "projects/my-app/code/\n");
        let mut all = Vec::new();
        paths(&crate::tree::list_tree(v).unwrap(), &mut all);
        assert!(all.contains(&"projects/my-app/context.md".to_string()));
        assert!(all.iter().all(|p| !p.contains("/code")), "{all:?}");
        let kids: Vec<String> = crate::tree::list_children(v, "projects/my-app")
            .unwrap()
            .into_iter()
            .map(|n| n.path)
            .collect();
        assert_eq!(kids, vec!["projects/my-app/context.md".to_string()]);
        // Asked directly for the excluded folder: nothing.
        assert!(crate::tree::list_children(v, "projects/my-app/code").unwrap().is_empty());
        // Lifting the rule brings everything back, untouched.
        rule(v, "");
        let mut back = Vec::new();
        paths(&crate::tree::list_tree(v).unwrap(), &mut back);
        assert!(back.contains(&"projects/my-app/code/README.md".to_string()));
        assert!(back.contains(&"projects/my-app/code/src/main.py".to_string()));
    }

    #[test]
    fn sync_never_writes_into_or_deletes_from_an_excluded_folder() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        rule(v, "code/\n");
        let n = crate::notefile::write_note_if_missing(v, "projects/my-app/code/new.md", "x");
        assert!(n.unwrap_err().0.contains("sync rules"));
        assert!(!v.join("projects/my-app/code/new.md").exists());
        let d = crate::notefile::delete_file(v, "projects/my-app/code/README.md");
        assert!(d.unwrap_err().0.contains("sync rules"));
        assert!(v.join("projects/my-app/code/README.md").exists());
        assert!(!crate::notefile::delete_folder_if_empty(v, "projects/my-app/code/src").unwrap());
        assert!(crate::notefile::ensure_folder(v, "projects/my-app/code/new").is_err());
        assert!(crate::notefile::rename_path(v, "projects/my-app/context.md", "projects/my-app/code/context.md").is_err());
        assert!(crate::attachments::write_tree_binary(v, "projects/my-app/code/x.png", &[1]).is_err());
        // Outside the rule everything still works.
        assert!(crate::notefile::write_note_if_missing(v, "projects/my-app/new.md", "x").unwrap());
    }

    #[test]
    fn the_watcher_drops_events_under_an_excluded_folder() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        rule(v, "code/\n");
        let plan = crate::watcher::plan_batch(
            v,
            vec![
                v.join("projects/my-app/code/README.md"),
                v.join("projects/my-app/code/gone.md"),
                v.join("projects/my-app/context.md"),
            ],
        );
        let rels: Vec<&str> = plan.changes.iter().map(|c| c.rel.as_str()).collect();
        assert_eq!(rels, vec!["projects/my-app/context.md"]);
        // …but an excluded path that EXISTS is still named, apart from
        // `changes`, for the delete drain's move pairing; a gone one is not.
        assert_eq!(plan.ignored, vec!["projects/my-app/code/README.md".to_string()]);
    }

    #[test]
    fn excluded_hashes_name_only_files_under_excluded_paths() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        rule(v, "code/\n");
        let out = crate::commands::excluded_hashes_impl(
            v,
            &["projects/my-app/code".to_string(), "projects/my-app/context.md".to_string()],
        );
        let paths: Vec<&str> = out.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.contains(&"projects/my-app/code/README.md"));
        assert!(!paths.iter().any(|p| p.ends_with("context.md")));
        let readme = out.iter().find(|h| h.path == "projects/my-app/code/README.md").unwrap();
        assert!(readme.is_note);
        let text = std::fs::read_to_string(v.join("projects/my-app/code/README.md")).unwrap();
        assert_eq!(readme.sha256, crate::notefile::sha256_hex(&text));
    }

    #[test]
    fn only_the_sync_layer_may_follow_a_move_into_an_excluded_folder() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        rule(v, "code/\n");
        let to = "projects/my-app/code/context.md";
        assert!(crate::notefile::rename_path(v, "projects/my-app/context.md", to).is_err());
        assert_eq!(
            crate::notefile::rename_path_opts(v, "projects/my-app/context.md", to, true).unwrap(),
            to
        );
        assert!(v.join(to).exists());
        // The floor still refuses, allowed or not.
        std::fs::write(v.join("a.md"), "a").unwrap();
        assert!(crate::notefile::rename_path_opts(v, "a.md", ".git/a.md", true).is_err());
    }

    #[test]
    fn the_index_drops_excluded_notes_and_keeps_their_crdt() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        let index = crate::index::Index::open(v).unwrap();
        index.rebuild(v).unwrap();
        let id = index.get_note_meta("projects/my-app/code/README.md").unwrap().unwrap().id;
        index.append_yjs_update(&id, &[1, 2, 3]).unwrap();
        rule(v, "code/\n");
        index.rebuild(v).unwrap();
        assert!(index.get_note_meta("projects/my-app/code/README.md").unwrap().is_none());
        assert!(index.get_note_meta("projects/my-app/context.md").unwrap().is_some());
        // The CRDT is keyed by doc_id, which no rebuild touches.
        assert!(index.has_local_crdt(&id).unwrap());
        rule(v, "");
        index.rebuild(v).unwrap();
        // The row comes back; the sync layer re-keys it to the id it parked
        // (`registry.ts unpark` → `rebind_note_id`), and the history is intact.
        assert!(index.get_note_meta("projects/my-app/code/README.md").unwrap().is_some());
        index.rebind_note_id("projects/my-app/code/README.md", &id).unwrap();
        assert_eq!(index.get_note_meta("projects/my-app/code/README.md").unwrap().unwrap().id, id);
        assert!(index.has_local_crdt(&id).unwrap());
    }

    #[test]
    fn preview_counts_what_a_candidate_would_hide_and_show() {
        let dir = vault_with_code_checkout();
        let v = dir.path();
        let cand = SyncRules::compile(RulesDoc { patterns: "code/\n".into(), ..Default::default() }).unwrap();
        let p = crate::commands::preview_rules(v, None, 0, &cand);
        // README.md, main.py, diagram.png — every surfaced file under code/.
        assert_eq!(p.candidate.files, 3);
        assert_eq!(p.candidate.folders, 1);
        assert_eq!(p.newly_hidden, vec!["projects/my-app/code".to_string()]);
        assert_eq!(p.current.files, 0);
        let back = crate::commands::preview_rules(v, Some(&cand), 0, &SyncRules::empty());
        assert_eq!(back.newly_shown, vec!["projects/my-app/code".to_string()]);
    }

    #[test]
    fn cache_round_trip_installs_per_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(!excludes(vault, "code/a.md", false));
        save_and_install(
            vault,
            RulesDoc { version: 1, patterns: "code/\n".into(), ..Default::default() },
        )
        .unwrap();
        assert!(excludes(vault, "code/a.md", false));
        assert!(!excludes(vault, "context.md", false));
        // A fresh load reads the same rules back from disk.
        install(vault, SyncRules::empty());
        assert!(!excludes(vault, "code/a.md", false));
        load_and_install(vault);
        assert!(excludes(vault, "code/a.md", false));
        // Unknown keys survive the round trip, and so do the type switches.
        let doc: RulesDoc = serde_json::from_str(
            r#"{"version":1,"patterns":"x","types":{"code":true},"folders":{"hidden":true},"later":{"a":1}}"#,
        )
        .unwrap();
        assert_eq!(doc.opt_in_groups(), crate::vault::OPT_IN_CODE | crate::vault::OPT_IN_HIDDEN);
        save_and_install(vault, doc).unwrap();
        let back = read_cached(vault).unwrap();
        assert_eq!(back.rest.get("later").unwrap()["a"], 1);
        assert_eq!(back.types, Some(RulesTypes { code: true, extra: false }));
        assert_eq!(back.folders, Some(RulesFolders { hidden: true, build: false }));
        install(vault, SyncRules::empty());
    }
}
