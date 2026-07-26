//! Markdown parsing: frontmatter, title, inline `#tags`, frontmatter `tags:`,
//! and `[[wiki-links]]`. This is the derivation layer — the `.md` bytes remain
//! the source of truth; everything here is recomputed from them.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::BTreeSet;

/// One `[[wiki-link]]` occurrence in a note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLink {
    /// The resolution target — the text before any `|alias` or `#heading`.
    pub target: String,
    /// The raw text inside the brackets (target plus alias/heading).
    pub raw: String,
    /// Byte offset of the link in the full file content.
    pub position: i64,
}

/// Everything we derive from a single note's bytes.
#[derive(Debug, Clone)]
pub struct ParsedNote {
    pub title: String,
    pub tags: Vec<String>,
    pub links: Vec<ParsedLink>,
    /// Parsed YAML frontmatter re-serialized as JSON (None when absent/invalid).
    pub frontmatter_json: Option<String>,
    /// The body used to feed FTS (frontmatter stripped).
    pub body: String,
}

// `#tag` — starts with a letter, may contain word chars, `/`, `-`. Must be
// preceded by start-of-string or whitespace so `#` in `# Heading` (space after)
// and `foo#bar` are not captured as tags.
static TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\s)#([\p{L}][\p{L}\p{N}_/\-]*)").unwrap());

// `[[target]]`, `[[target|alias]]`, `[[target#heading]]`.
static WIKILINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]\n]+)\]\]").unwrap());

// First ATX H1 (`# Title`) on its own line.
static H1_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#\s+(.+?)\s*$").unwrap());

/// Split leading YAML frontmatter (`---\n … \n---`) from the body.
/// Returns `(Some(yaml), body)` or `(None, whole_content)`.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    // Frontmatter must be the very first thing in the file.
    let rest = match content.strip_prefix("---\n") {
        Some(r) => r,
        None => match content.strip_prefix("---\r\n") {
            Some(r) => r,
            None => return (None, content),
        },
    };
    // Find the closing fence at the start of a line.
    for (idx, _) in rest.match_indices("---") {
        let at_line_start = idx == 0 || rest[..idx].ends_with('\n');
        let after = &rest[idx + 3..];
        let ends_line = after.is_empty() || after.starts_with('\n') || after.starts_with('\r');
        if at_line_start && ends_line {
            let yaml = &rest[..idx];
            // Body begins after the closing fence's newline.
            let body_start = idx + 3;
            let body = rest[body_start..].trim_start_matches(['\r', '\n']);
            return (Some(yaml), body);
        }
    }
    (None, content)
}

/// Frontmatter above this size is ignored — real metadata is tiny, and a large
/// blob is either junk or an attack. Bounds the bytes serde_yaml ever sees.
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
/// Max YAML anchor/alias sigils (`&`/`*`) tolerated before we refuse to parse.
/// serde_yaml (unsafe-libyaml) materializes every alias into an owned Value
/// with no expansion limit, so nested anchors/aliases are a billion-laughs DoS
/// (a few KB → billions of nodes → OOM/crash). Legitimate frontmatter uses no
/// anchors, so a small cap here defeats the bomb while leaving real notes
/// untouched; even at the cap, alias doubling stays bounded to a few thousand
/// nodes.
const MAX_FRONTMATTER_SIGILS: usize = 32;

/// Convert parsed YAML frontmatter into a compact JSON string.
fn frontmatter_to_json(yaml: &str) -> Option<(String, serde_json::Value)> {
    if yaml.trim().is_empty() {
        return None;
    }
    // Guard against YAML alias bombs before deserializing (see the consts).
    if yaml.len() > MAX_FRONTMATTER_BYTES {
        return None;
    }
    let sigils = yaml.bytes().filter(|&b| b == b'&' || b == b'*').count();
    if sigils > MAX_FRONTMATTER_SIGILS {
        return None;
    }
    match serde_yaml::from_str::<serde_json::Value>(yaml) {
        Ok(v) if !v.is_null() => serde_json::to_string(&v).ok().map(|s| (s, v)),
        _ => None,
    }
}

/// Extract `tags:` from parsed frontmatter — supports a YAML list or a
/// whitespace/comma-separated string.
fn frontmatter_tags(fm: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(tags) = fm.get("tags") {
        match tags {
            serde_json::Value::Array(arr) => {
                for t in arr {
                    if let Some(s) = t.as_str() {
                        push_tag(&mut out, s);
                    }
                }
            }
            serde_json::Value::String(s) => {
                for part in s.split([',', ' ']) {
                    push_tag(&mut out, part);
                }
            }
            _ => {}
        }
    }
    out
}

fn push_tag(out: &mut Vec<String>, raw: &str) {
    let t = raw.trim().trim_start_matches('#');
    if !t.is_empty() {
        out.push(t.to_string());
    }
}

/// Derive a display title: frontmatter `title:`, else first H1, else the
/// filename stem (passed in by the caller).
fn derive_title(fm: Option<&serde_json::Value>, body: &str, fallback_stem: &str) -> String {
    if let Some(fm) = fm {
        if let Some(t) = fm.get("title").and_then(|v| v.as_str()) {
            if !t.trim().is_empty() {
                return t.trim().to_string();
            }
        }
    }
    if let Some(cap) = H1_RE.captures(body) {
        return cap[1].trim().to_string();
    }
    fallback_stem.to_string()
}

/// Parse a note's full content. `stem` is the filename without extension,
/// used as the title fallback.
pub fn parse_note(content: &str, stem: &str) -> ParsedNote {
    let (fm_yaml, body) = split_frontmatter(content);
    let fm = fm_yaml.and_then(frontmatter_to_json);
    let (fm_json, fm_val) = match fm {
        Some((j, v)) => (Some(j), Some(v)),
        None => (None, None),
    };

    // Tags: frontmatter + inline, deduped, order-stable-ish via BTreeSet.
    let mut tag_set: BTreeSet<String> = BTreeSet::new();
    if let Some(fm) = fm_val.as_ref() {
        for t in frontmatter_tags(fm) {
            tag_set.insert(t);
        }
    }
    for cap in TAG_RE.captures_iter(body) {
        tag_set.insert(cap[1].to_string());
    }
    let tags: Vec<String> = tag_set.into_iter().collect();

    // Wiki-links — positions are offsets into the *full* content.
    let offset = content.len() - body.len();
    let mut links = Vec::new();
    for cap in WIKILINK_RE.captures_iter(body) {
        let m = cap.get(0).unwrap();
        let raw = cap[1].trim().to_string();
        // target = strip alias (`|`) and heading (`#`).
        let target = raw
            .split('|')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if target.is_empty() {
            continue;
        }
        links.push(ParsedLink {
            target,
            raw,
            position: (offset + m.start()) as i64,
        });
    }

    let title = derive_title(fm_val.as_ref(), body, stem);

    ParsedNote {
        title,
        tags,
        links,
        frontmatter_json: fm_json,
        body: body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_title_and_tags() {
        let content = "---\ntitle: My Note\ntags: [alpha, beta]\n---\n# Ignored H1\n\nbody #gamma here";
        let p = parse_note(content, "file-stem");
        assert_eq!(p.title, "My Note");
        assert!(p.tags.contains(&"alpha".to_string()));
        assert!(p.tags.contains(&"beta".to_string()));
        assert!(p.tags.contains(&"gamma".to_string()));
        assert!(p.frontmatter_json.is_some());
    }

    #[test]
    fn title_falls_back_to_h1_then_stem() {
        let p = parse_note("# Heading Title\n\ntext", "stem");
        assert_eq!(p.title, "Heading Title");
        let p2 = parse_note("no heading here", "the-stem");
        assert_eq!(p2.title, "the-stem");
    }

    #[test]
    fn extracts_wikilinks_with_alias_and_heading() {
        let p = parse_note("see [[Target Note]] and [[Other|alias]] and [[Third#sec]]", "s");
        let targets: Vec<_> = p.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["Target Note", "Other", "Third"]);
    }

    #[test]
    fn heading_hash_is_not_a_tag() {
        let p = parse_note("# Real Heading\n\n#actualtag", "s");
        assert!(p.tags.contains(&"actualtag".to_string()));
        assert!(!p.tags.contains(&"Real".to_string()));
    }

    #[test]
    fn no_frontmatter_leaves_body_intact() {
        let (fm, body) = split_frontmatter("just body\nmore");
        assert!(fm.is_none());
        assert_eq!(body, "just body\nmore");
    }

    #[test]
    fn frontmatter_string_tags() {
        let p = parse_note("---\ntags: one two three\n---\nbody", "s");
        assert!(p.tags.contains(&"one".to_string()));
        assert!(p.tags.contains(&"three".to_string()));
    }

    #[test]
    fn yaml_alias_bomb_is_refused_not_expanded() {
        // A billion-laughs frontmatter must be skipped (returns quickly, no
        // frontmatter, no OOM) rather than deserialized. Nested anchor/alias
        // chains push the sigil count over the cap, so parsing is refused.
        let anchors = ['a', 'b', 'c', 'd', 'e', 'f'];
        let mut yaml = String::from("a: &a [x,x,x,x,x,x,x,x,x,x]\n");
        for w in anchors.windows(2) {
            let (prev, cur) = (w[0], w[1]);
            let refs = vec![format!("*{prev}"); 10].join(",");
            yaml.push_str(&format!("{cur}: &{cur} [{refs}]\n"));
        }
        let content = format!("---\n{yaml}---\nbody");
        let p = parse_note(&content, "s");
        // Refused: no frontmatter materialized, body still intact.
        assert!(p.frontmatter_json.is_none());
        assert_eq!(p.body.trim(), "body");
    }
}
