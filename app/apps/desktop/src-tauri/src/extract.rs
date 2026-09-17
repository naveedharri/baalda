//! Plain text out of the binaries the vault surfaces, for the `files_fts`
//! half of search (`index.rs` tier 2).
//!
//! Rust extracts, not the webview: the index has to be correct with no window
//! open at all — `rebuild` runs on `open_vault`'s background thread and the
//! watcher indexes headless — and Rust already owns every byte read off disk.
//! The one format that stays a TS opt-in is PDF (no dependency-free Rust
//! extractor we would trust on malformed input), so a `.pdf` is recorded as
//! `unsupported` rather than `error`: a later `index_external_text` escape
//! hatch fed by the PDF viewer can fill exactly those rows in.
//!
//! Three rules everything here obeys:
//!
//! 1. **Caps before work.** Every constant below is a refusal, not a target.
//!    The caller ([`max_input_bytes`]) checks the file's size BEFORE reading it,
//!    so a 500 MB video never enters memory; [`extract_text`] re-checks the
//!    slice it was handed, so the refusal survives a caller that forgets.
//! 2. **Nothing trusted is parsed unguarded.** Every container parser runs
//!    inside `catch_unwind` and reports `error` — a malformed `.docx` is a file
//!    someone dropped in a folder, not a reason to take the process down. This
//!    is only sound because the crate deliberately does NOT set
//!    `panic = "abort"` (see the profile note in `Cargo.toml`).
//! 3. **Control characters are stripped from every body.** `index.rs` delimits
//!    its FTS snippets with U+0001/U+0002 sentinels and swaps them for `<mark>`
//!    after HTML-escaping. Note text cannot contain those; text pulled out of a
//!    binary very much can, and one stray byte would inject an unbalanced
//!    `<mark>` into the search panel's `dangerouslySetInnerHTML`.

use crate::parse::strip_html_tags;
use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

/// Plain-text inputs (`.csv`, `.json`, source files…) are read whole, so the cap
/// is the one that bounds memory per extraction. 2 MB of text is ~350k words;
/// past that a file is data, not prose, and [`MAX_STORED_CHARS`] would clip it
/// anyway.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// OOXML/zip containers are read whole too (the `zip` crate needs `Seek`), so
/// this is the real ceiling on an extraction's memory. 20 MB covers a long
/// report or a fat spreadsheet; the files past it are the ones stuffed with
/// images, where the text was never the point.
pub const MAX_CONTAINER_BYTES: u64 = 20 * 1024 * 1024;

/// How much extracted text is stored per file, in CHARS (not bytes — truncation
/// must land on a char boundary). FTS5 stores the body verbatim in a
/// self-contained table, so this is what bounds `.context/index.sqlite` growth
/// when a vault gains a few hundred documents.
pub const MAX_STORED_CHARS: usize = 500_000;

/// Unzip guards. A zip bomb is a 40 KB file that decompresses to petabytes, and
/// an OOXML part is just a zip entry, so the guard applies to every container —
/// `.docx` included. All three are checked from the central directory, before a
/// single byte is decompressed.
pub const MAX_ZIP_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
/// Total uncompressed size across all entries.
pub const MAX_ZIP_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
/// Entry count, which is what bounds the central-directory walk itself.
pub const MAX_ZIP_ENTRIES: usize = 5_000;
/// How many entry NAMES a plain `.zip` contributes (its whole extracted body).
pub const MAX_ZIP_NAMES: usize = 2_000;

/// What the index knows about a file's text. Stored verbatim in
/// `files.text_status`, so these strings are a schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextStatus {
    /// The row exists (size/mtime are current) but nothing has been extracted
    /// yet — the state every cheap upsert under the index mutex writes.
    Pending,
    /// Extraction ran. The body may still be empty: an image has no text, and
    /// that is a finished answer, not a failure.
    Ok,
    /// The file is over the cap for its kind. Still searchable by NAME.
    SkippedSize,
    /// Nothing here can read this format (PDF). A TS-side extractor may fill it.
    Unsupported,
    /// The parser refused or panicked on this file. Not retried until the bytes
    /// change, or the row would re-fail on every watcher event.
    Error,
}

impl TextStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TextStatus::Pending => "pending",
            TextStatus::Ok => "ok",
            TextStatus::SkippedSize => "skipped_size",
            TextStatus::Unsupported => "unsupported",
            TextStatus::Error => "error",
        }
    }
}

/// The result of one extraction: the body to index and why it looks that way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub text: String,
    pub status: TextStatus,
}

impl Extracted {
    fn empty(status: TextStatus) -> Self {
        Extracted {
            text: String::new(),
            status,
        }
    }
}

/// Which extractor an extension gets.
///
/// ONE CONTRACT with `src/lib/formats.ts`, whose `textExtract` field is the same
/// decision on the TS side (and the key the plan names): `utf8` → [`Utf8`],
/// `docx`/`xlsx` → the OOXML arms, `csv` → [`Utf8`] (a CSV *is* text; the
/// spreadsheet parser is for the binary format), `pdf` → [`Unsupported`],
/// `none` → [`NameOnly`]. Change one, change both.
///
/// [`Utf8`]: Extractor::Utf8
/// [`Unsupported`]: Extractor::Unsupported
/// [`NameOnly`]: Extractor::NameOnly
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extractor {
    /// Read as UTF-8 (lossy — a `.csv` exported from Excel is often Latin-1).
    Utf8,
    /// Markup stripped, so FTS matches the words a reader sees.
    Html,
    Docx,
    Xlsx,
    Pptx,
    /// Entry names only: what is IN the archive is the only searchable thing
    /// about it without unpacking the whole thing.
    Zip,
    /// No body at all — the file name carries every word we have (images,
    /// audio, video). `files_fts.name` is what makes those findable.
    NameOnly,
    /// A format with real text we decline to parse here (PDF).
    Unsupported,
}

/// The extractor for a lowercase, dotless extension.
pub fn extractor_for(ext: &str) -> Extractor {
    match ext {
        // Text and text-shaped data. `md`/`markdown`/`mdx`/`txt`/`canvas` are
        // note-family and never reach the `files` table, but they are listed so
        // this function answers for every surfaced extension rather than
        // silently defaulting.
        "md" | "markdown" | "mdx" | "txt" | "canvas" | "csv" | "tsv" | "json" | "yaml" | "yml"
        | "toml" | "xml" | "py" | "rs" | "go" | "sh" | "sql" => Extractor::Utf8,
        "html" | "htm" => Extractor::Html,
        "docx" => Extractor::Docx,
        "xlsx" | "xlsm" => Extractor::Xlsx,
        "pptx" => Extractor::Pptx,
        "zip" => Extractor::Zip,
        "pdf" => Extractor::Unsupported,
        // Images, audio, video — and anything new that reaches here before this
        // table learns about it. Name-only is the safe default: it indexes
        // something true and reads nothing.
        _ => Extractor::NameOnly,
    }
}

/// The `files.kind` column: the format's family, mirroring `FormatCategory` in
/// `src/lib/formats.ts` so the UI can badge a hit without a second table.
pub fn kind_for(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" | "mdx" | "txt" | "canvas" => "note",
        "html" | "htm" => "text",
        "png" | "jpg" | "jpeg" | "jfif" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
        | "heic" | "heif" | "tiff" | "tif" => "image",
        "pdf" => "pdf",
        "docx" => "office-doc",
        "xlsx" | "xlsm" => "spreadsheet",
        "pptx" => "presentation",
        "mp4" | "m4v" | "mov" | "webm" => "video",
        "mp3" | "wav" | "m4a" | "ogg" | "aac" | "flac" => "audio",
        "zip" => "archive",
        _ => "data",
    }
}

/// The largest file this extractor will READ. `0` means "never read it" — the
/// caller must not open the file at all (name-only and unsupported kinds).
///
/// This is the cheap half of the cap: the worker stats the file and compares,
/// so an oversized `.mp4` costs one `metadata()` call rather than 500 MB of
/// allocation. [`extract_text`] re-checks what it was actually handed.
pub fn max_input_bytes(extractor: Extractor) -> u64 {
    match extractor {
        Extractor::Utf8 | Extractor::Html => MAX_TEXT_BYTES,
        Extractor::Docx | Extractor::Xlsx | Extractor::Pptx | Extractor::Zip => {
            MAX_CONTAINER_BYTES
        }
        Extractor::NameOnly | Extractor::Unsupported => 0,
    }
}

/// Extract searchable text from one file's bytes.
///
/// `path` is only ever used for the log line on a failure; the decision is made
/// from `ext` (lowercase, no dot) so a caller cannot get a different answer than
/// the one [`max_input_bytes`] was asked about.
///
/// Never returns an `Err`: every failure mode is a [`TextStatus`], because a
/// file that will not parse must still get a row (searchable by name) instead of
/// failing a whole batch.
pub fn extract_text(path: &Path, ext: &str, bytes: &[u8]) -> Extracted {
    let extractor = extractor_for(ext);
    match extractor {
        Extractor::NameOnly => return Extracted::empty(TextStatus::Ok),
        Extractor::Unsupported => return Extracted::empty(TextStatus::Unsupported),
        _ => {}
    }
    if bytes.len() as u64 > max_input_bytes(extractor) {
        return Extracted::empty(TextStatus::SkippedSize);
    }

    // Every parser below walks attacker-shaped input (a file someone dropped in
    // a folder). `catch_unwind` turns a panic into one bad row; without it a
    // malformed `.xlsx` would take down the extraction thread and, with it,
    // every later file in the vault.
    let result = catch_unwind(AssertUnwindSafe(|| match extractor {
        Extractor::Utf8 => Ok(String::from_utf8_lossy(bytes).into_owned()),
        Extractor::Html => Ok(strip_html_tags(&String::from_utf8_lossy(bytes))),
        Extractor::Docx => docx_text(bytes),
        Extractor::Xlsx => xlsx_text(bytes),
        Extractor::Pptx => pptx_text(bytes),
        Extractor::Zip => zip_names(bytes),
        Extractor::NameOnly | Extractor::Unsupported => unreachable!("handled above"),
    }));

    match result {
        Ok(Ok(text)) => Extracted {
            text: clean(text),
            status: TextStatus::Ok,
        },
        Ok(Err(status)) => Extracted::empty(status),
        Err(_) => {
            log::warn!("[extract] {} panicked while parsing; indexed by name only", path.display());
            Extracted::empty(TextStatus::Error)
        }
    }
}

/// Strip the control characters that would break the FTS snippet contract, then
/// clip to [`MAX_STORED_CHARS`].
///
/// Tab, newline and carriage return survive (they are how a spreadsheet's rows
/// stay rows); everything else below U+0020 goes. Filtering BEFORE truncating
/// means junk cannot eat the budget, and taking whole `char`s means the cut can
/// never land inside a multi-byte sequence.
fn clean(text: String) -> String {
    text.chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}'))
        .take(MAX_STORED_CHARS)
        .collect()
}

// ---- containers -----------------------------------------------------------

type Archive<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

/// Open the container and refuse a bomb before decompressing anything.
///
/// Sizes come from the central directory, which is metadata: a lying header
/// cannot make us allocate, because every entry is ALSO read through a
/// `take(MAX_ZIP_ENTRY_BYTES)` in [`read_entry`].
fn open_archive(bytes: &[u8]) -> Result<Archive<'_>, TextStatus> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| TextStatus::Error)?;
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err(TextStatus::SkippedSize);
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|_| TextStatus::Error)?;
        let size = entry.size();
        if size > MAX_ZIP_ENTRY_BYTES {
            return Err(TextStatus::SkippedSize);
        }
        total = total.saturating_add(size);
        if total > MAX_ZIP_TOTAL_BYTES {
            return Err(TextStatus::SkippedSize);
        }
    }
    Ok(zip)
}

/// One entry as a string, or `None` when the part is absent (a `.xlsx` with no
/// `sharedStrings.xml` is perfectly legal — every cell is inline or numeric).
fn read_entry(zip: &mut Archive<'_>, name: &str) -> Option<String> {
    let entry = zip.by_name(name).ok()?;
    let mut text = String::new();
    // The second half of the bomb guard: whatever the header claimed, stop
    // reading at the per-entry cap.
    entry
        .take(MAX_ZIP_ENTRY_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// Entry names matching a prefix/suffix, ordered by the NUMBER in their name
/// (`slide2.xml` before `slide10.xml`, which a lexical sort gets wrong) and then
/// by name, so two runs over the same file produce the same text.
fn parts_in_order(zip: &Archive<'_>, prefix: &str, suffix: &str) -> Vec<String> {
    let mut names: Vec<String> = zip
        .file_names()
        .filter(|n| n.starts_with(prefix) && n.ends_with(suffix))
        .map(|n| n.to_string())
        .collect();
    names.sort_by_key(|n| (trailing_number(n), n.clone()));
    names
}

/// The run of digits at the end of the stem (`…/sheet12.xml` → 12), or 0.
fn trailing_number(name: &str) -> u64 {
    let stem = name.rsplit('/').next().unwrap_or(name);
    let stem = stem.split('.').next().unwrap_or(stem);
    let digits: String = stem
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.chars().rev().collect::<String>().parse().unwrap_or(0)
}

/// `word/document.xml`: the text of every `<w:t>` run, one line per `<w:p>`
/// paragraph. Tables, headers and footnotes live in other parts and are
/// deliberately left out — the document body is the searchable thing.
fn docx_text(bytes: &[u8]) -> Result<String, TextStatus> {
    let mut zip = open_archive(bytes)?;
    let xml = read_entry(&mut zip, "word/document.xml").ok_or(TextStatus::Error)?;
    Ok(xml_text(&xml, &["t"], &["p"]))
}

/// `ppt/slides/slideN.xml`: every `<a:t>` run, one line per `<a:p>`, slides in
/// their real order. This is what gives `.pptx` — which has no viewer, only a
/// card — a searchable outline.
fn pptx_text(bytes: &[u8]) -> Result<String, TextStatus> {
    let mut zip = open_archive(bytes)?;
    let slides = parts_in_order(&zip, "ppt/slides/slide", ".xml");
    let mut out = String::new();
    for name in slides {
        let Some(xml) = read_entry(&mut zip, &name) else {
            continue;
        };
        // No separator between slides: `xml_text` already terminates every
        // paragraph with a newline, so a blank line here would only pad the
        // stored body.
        out.push_str(&xml_text(&xml, &["t"], &["p"]));
    }
    Ok(out)
}

/// Pull the text of `text_tags`, breaking a line whenever a `break_tag` closes.
///
/// Tags are matched on their LOCAL name, so a part that declares the OOXML
/// namespace as the default (`<t>` rather than `<w:t>`) reads the same. Runs
/// inside one paragraph are joined with a space: a `.docx` splits a sentence
/// across runs at every formatting change, and concatenating them bare would
/// glue "the" and "word" into "theword" — which no search would then match.
fn xml_text(xml: &str, text_tags: &[&str], break_tags: &[&str]) -> String {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut out = String::new();
    let mut line = String::new();
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if matches_local(e.local_name().as_ref(), text_tags) {
                    depth += 1;
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                if matches_local(local.as_ref(), text_tags) {
                    depth = depth.saturating_sub(1);
                } else if matches_local(local.as_ref(), break_tags) {
                    push_line(&mut out, &mut line);
                }
            }
            Ok(Event::Text(e)) if depth > 0 => {
                let text = e.unescape().unwrap_or_default();
                if !text.is_empty() {
                    if !line.is_empty() && !line.ends_with(' ') {
                        line.push(' ');
                    }
                    line.push_str(&text);
                }
            }
            Ok(Event::Eof) => break,
            // A malformed tail is not a reason to throw away the text before
            // it: an OOXML part truncated by a bad upload still has a body.
            Err(_) => break,
            _ => {}
        }
    }
    push_line(&mut out, &mut line);
    out
}

fn matches_local(local: &[u8], tags: &[&str]) -> bool {
    tags.iter().any(|t| t.as_bytes() == local)
}

fn push_line(out: &mut String, line: &mut String) {
    let trimmed = line.trim();
    if !trimmed.is_empty() {
        out.push_str(trimmed);
        out.push('\n');
    }
    line.clear();
}

/// `xl/sharedStrings.xml` plus every `xl/worksheets/sheetN.xml`: one line per
/// row, cells separated by a space.
///
/// A spreadsheet stores repeated strings once, by index, in the shared table, so
/// a sheet read without it is a grid of integers. Numbers are indexed as
/// written (`<v>` verbatim), which is what makes an invoice total findable.
fn xlsx_text(bytes: &[u8]) -> Result<String, TextStatus> {
    use quick_xml::events::Event;
    let mut zip = open_archive(bytes)?;
    let shared: Vec<String> = match read_entry(&mut zip, "xl/sharedStrings.xml") {
        Some(xml) => shared_strings(&xml),
        None => Vec::new(),
    };

    let mut out = String::new();
    for name in parts_in_order(&zip, "xl/worksheets/sheet", ".xml") {
        let Some(xml) = read_entry(&mut zip, &name) else {
            continue;
        };
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut row = String::new();
        // `t="s"` on the cell means "<v> is an index into the shared table";
        // `t="inlineStr"` means the text is in a nested <is><t>.
        let mut shared_cell = false;
        let mut in_value = false;
        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                    b"c" => {
                        shared_cell = e
                            .try_get_attribute("t")
                            .ok()
                            .flatten()
                            .is_some_and(|a| a.value.as_ref() == b"s");
                    }
                    b"v" | b"t" => in_value = true,
                    _ => {}
                },
                Ok(Event::End(e)) => match e.local_name().as_ref() {
                    b"v" | b"t" => in_value = false,
                    b"row" => push_line(&mut out, &mut row),
                    _ => {}
                },
                Ok(Event::Text(e)) if in_value => {
                    let raw = e.unescape().unwrap_or_default();
                    let value = if shared_cell {
                        raw.trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| shared.get(i))
                            .cloned()
                            .unwrap_or_default()
                    } else {
                        raw.to_string()
                    };
                    if !value.is_empty() {
                        if !row.is_empty() {
                            row.push(' ');
                        }
                        row.push_str(&value);
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
        }
        push_line(&mut out, &mut row);
    }
    Ok(out)
}

/// The shared-string table, in index order. One `<si>` may hold several `<t>`
/// runs (a cell with mixed formatting), which concatenate into one string.
fn shared_strings(xml: &str) -> Vec<String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut strings: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"si" => {
                    in_item = true;
                    current.clear();
                }
                b"t" => in_text = true,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"si" => {
                    in_item = false;
                    strings.push(std::mem::take(&mut current));
                }
                b"t" => in_text = false,
                _ => {}
            },
            Ok(Event::Text(e)) if in_item && in_text => {
                current.push_str(&e.unescape().unwrap_or_default());
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    strings
}

/// A plain `.zip` contributes its entry NAMES and nothing else: unpacking an
/// archive to index its contents would mean extracting formats we refused to
/// read standalone, at a size we refused to read at all.
fn zip_names(bytes: &[u8]) -> Result<String, TextStatus> {
    let zip = open_archive(bytes)?;
    let mut names: Vec<&str> = zip.file_names().take(MAX_ZIP_NAMES).collect();
    names.sort_unstable();
    Ok(names.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Fixtures are BUILT here rather than committed: a binary `.docx` in git is
    /// a file nobody can review, and the shapes we care about (a `<w:t>` run, a
    /// shared string, a slide) are three lines of XML each.
    fn zip_of(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    fn docx(body: &str) -> Vec<u8> {
        zip_of(&[(
            "word/document.xml",
            &format!(
                r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>{body}</w:body></w:document>"#
            ),
        )])
    }

    fn extract(ext: &str, bytes: &[u8]) -> Extracted {
        extract_text(Path::new("fixture"), ext, bytes)
    }

    #[test]
    fn docx_joins_runs_into_paragraph_lines() {
        let bytes = docx(
            "<w:p><w:r><w:t>Quarterly</w:t></w:r><w:r><w:t>revenue</w:t></w:r></w:p>\
             <w:p><w:r><w:t>Sardonic marmalade</w:t></w:r></w:p>",
        );
        let out = extract("docx", &bytes);
        assert_eq!(out.status, TextStatus::Ok);
        assert_eq!(out.text, "Quarterly revenue\nSardonic marmalade\n");
    }

    /// The reason `clean` exists: `index.rs` swaps U+0001/U+0002 for `<mark>`
    /// AFTER escaping, so a body carrying one would open a tag nothing closes.
    #[test]
    fn control_characters_never_survive_extraction() {
        let bytes = docx("<w:p><w:r><w:t>before\u{1}after\u{2}end\u{7}.</w:t></w:r></w:p>");
        let out = extract("docx", &bytes);
        assert_eq!(out.text, "beforeafterend.\n");
        assert!(!out.text.contains('\u{1}') && !out.text.contains('\u{2}'));
    }

    #[test]
    fn xlsx_resolves_shared_strings_and_keeps_numbers() {
        let bytes = zip_of(&[
            (
                "xl/sharedStrings.xml",
                r#"<sst><si><t>Widget</t></si><si><t>Total</t></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData>
                   <row><c t="s"><v>0</v></c><c><v>42</v></c></row>
                   <row><c t="s"><v>1</v></c><c t="inlineStr"><is><t>inline cell</t></is></c></row>
                   </sheetData></worksheet>"#,
            ),
        ]);
        let out = extract("xlsx", &bytes);
        assert_eq!(out.status, TextStatus::Ok);
        assert_eq!(out.text, "Widget 42\nTotal inline cell\n");
    }

    /// Sheets and slides are ordered by their number, not lexically, or
    /// `sheet10` would sort between `sheet1` and `sheet2`.
    #[test]
    fn pptx_reads_slides_in_numeric_order() {
        let slide = |t: &str| format!(r#"<p:sld xmlns:a="x"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let bytes = zip_of(&[
            ("ppt/slides/slide10.xml", &slide("tenth")),
            ("ppt/slides/slide2.xml", &slide("second")),
            ("ppt/slides/slide1.xml", &slide("first")),
        ]);
        let out = extract("pptx", &bytes);
        assert_eq!(out.text, "first\nsecond\ntenth\n");
    }

    #[test]
    fn zip_indexes_entry_names_only() {
        let bytes = zip_of(&[
            ("docs/report.txt", "secret body text"),
            ("docs/photo.png", "binary"),
        ]);
        let out = extract("zip", &bytes);
        assert_eq!(out.text, "docs/photo.png\ndocs/report.txt");
        assert!(!out.text.contains("secret"), "contents are never unpacked");
    }

    #[test]
    fn a_pdf_is_unsupported_and_an_image_is_name_only() {
        let pdf = extract("pdf", b"%PDF-1.7 whatever");
        assert_eq!(pdf.status, TextStatus::Unsupported);
        assert!(pdf.text.is_empty());

        let png = extract("png", b"\x89PNG\r\n");
        assert_eq!(png.status, TextStatus::Ok);
        assert!(png.text.is_empty(), "the file NAME is the searchable part");

        // And neither is ever read off disk.
        assert_eq!(max_input_bytes(Extractor::Unsupported), 0);
        assert_eq!(max_input_bytes(Extractor::NameOnly), 0);
    }

    #[test]
    fn text_is_truncated_at_the_char_cap_on_a_char_boundary() {
        // Multi-byte on purpose: a byte-wise cut would split it.
        let body = "é".repeat(MAX_STORED_CHARS + 500);
        let out = extract("csv", body.as_bytes());
        assert_eq!(out.status, TextStatus::Ok);
        assert_eq!(out.text.chars().count(), MAX_STORED_CHARS);
    }

    #[test]
    fn an_oversized_input_is_skipped_rather_than_read() {
        let big = vec![b'a'; (MAX_TEXT_BYTES + 1) as usize];
        assert_eq!(extract("csv", &big).status, TextStatus::SkippedSize);
        assert_eq!(max_input_bytes(Extractor::Utf8), MAX_TEXT_BYTES);
    }

    /// The bomb guard reads the central directory only: this fixture claims
    /// nothing, it simply has more entries than we will walk.
    #[test]
    fn too_many_entries_is_skipped_not_parsed() {
        let names: Vec<String> = (0..=MAX_ZIP_ENTRIES).map(|i| format!("f{i}.txt")).collect();
        let parts: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), "x")).collect();
        let bytes = zip_of(&parts);
        assert_eq!(extract("zip", &bytes).status, TextStatus::SkippedSize);
    }

    #[test]
    fn a_container_that_is_not_a_container_is_an_error_not_a_panic() {
        assert_eq!(extract("docx", b"not a zip at all").status, TextStatus::Error);
        // A real zip with no `word/document.xml` is equally not a docx.
        let bytes = zip_of(&[("hello.txt", "hi")]);
        assert_eq!(extract("docx", &bytes).status, TextStatus::Error);
    }

    #[test]
    fn html_is_stripped_and_utf8_is_lossy() {
        let out = extract("html", b"<p>hello <b>world</b></p><script>bad()</script>");
        assert_eq!(out.text, "hello world");
        // Invalid UTF-8 must not fail the file — it is replaced.
        let out = extract("csv", b"caf\xe9,2");
        assert_eq!(out.status, TextStatus::Ok);
        assert!(out.text.ends_with(",2"));
    }

    #[test]
    fn the_extractor_table_matches_the_format_registry() {
        assert_eq!(extractor_for("docx"), Extractor::Docx);
        assert_eq!(extractor_for("xlsm"), Extractor::Xlsx);
        assert_eq!(extractor_for("csv"), Extractor::Utf8);
        assert_eq!(extractor_for("mp4"), Extractor::NameOnly);
        assert_eq!(extractor_for("pdf"), Extractor::Unsupported);
        assert_eq!(kind_for("mp3"), "audio");
        assert_eq!(kind_for("zip"), "archive");
        assert_eq!(kind_for("py"), "data");
    }
}
