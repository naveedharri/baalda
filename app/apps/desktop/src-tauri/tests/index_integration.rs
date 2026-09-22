//! Integration test: build a real on-disk test vault (nested folders, tags,
//! wiki-links) in the OS temp dir, then exercise the public index logic
//! against it end-to-end.

use desktop_lib::extract_worker;
use desktop_lib::index::Index;
use desktop_lib::notefile;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::Mutex;

fn scratch_vault() -> PathBuf {
    std::env::temp_dir().join("context-test-vault")
}

fn seed(vault: &PathBuf) {
    // Fresh vault each run.
    let _ = std::fs::remove_dir_all(vault);
    std::fs::create_dir_all(vault).unwrap();

    notefile::write_note(
        vault,
        "Index.md",
        "---\ntitle: Home\ntags: [moc]\n---\n# Home\n\nStart at [[Projects/Baalda]] and [[Daily/2026-07-13]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Projects/Baalda.md",
        "# Baalda\n\nA local-first #project. Relates to [[Index]].\nSee also [[Daily/2026-07-13]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Daily/2026-07-13.md",
        "# 2026-07-13\n\nWorked on #project baalda. Quick brown fox jumps. Link [[Projects/Baalda]].\n",
    )
    .unwrap();
    notefile::write_note(
        vault,
        "Daily/Notes/Scratch.md",
        "# Scratch\n\nDangling [[Nowhere]] plus a #idea tag.\n",
    )
    .unwrap();
    // A non-markdown member of the note family: it indexes like the rest, but
    // its `#` and `[[…]]` are plain characters (see `parse.rs parse_plain`).
    notefile::write_note(
        vault,
        "Daily/Errands.txt",
        "buy #stamps\npost [[Nowhere]]\nsardonic marmalade\n",
    )
    .unwrap();
}

#[test]
fn full_index_lifecycle_on_disk_vault() {
    let vault = scratch_vault();
    seed(&vault);

    let idx = Index::open(&vault).unwrap();
    idx.rebuild(&vault).unwrap();

    // 5 notes discovered across nested folders (4 markdown + 1 plain text).
    let titles = idx.list_note_titles().unwrap();
    assert_eq!(titles.len(), 5, "expected 5 notes, got {}", titles.len());

    // FTS: "quick brown" only appears in the daily note.
    let hits = idx.search_notes("quick brown").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "2026-07-13");
    assert!(hits[0].snippet.contains("<mark>"));

    // Wiki-link resolution (path-style target).
    let resolved = idx.resolve_wikilink("Projects/Baalda").unwrap().unwrap();
    assert_eq!(resolved.path, "Projects/Baalda.md");

    // Backlinks: Baalda is linked from Index + Daily → 2 backlinks.
    let baalda = idx.get_note_meta("Projects/Baalda.md").unwrap().unwrap();
    let backlinks = idx.get_backlinks(&baalda.id).unwrap();
    assert_eq!(backlinks.len(), 2, "baalda backlinks: {:?}", backlinks);

    // Tags surfaced on the daily note.
    let daily = idx.get_note_meta("Daily/2026-07-13.md").unwrap().unwrap();
    assert!(daily.tags.contains(&"project".to_string()));

    // The `.txt` is a first-class note: searchable, titled by its stem — and
    // its `#stamps`/`[[Nowhere]]` are text, not a tag and not a link.
    let errands = idx.get_note_meta("Daily/Errands.txt").unwrap().unwrap();
    assert_eq!(errands.title, "Errands");
    assert!(errands.tags.is_empty());
    let txt_hits = idx.search_notes("sardonic").unwrap();
    assert_eq!(txt_hits.len(), 1);
    assert_eq!(txt_hits[0].path, "Daily/Errands.txt");

    // Dangling link ([[Nowhere]]) is recorded but unresolved (no backlink).
    let dangling = idx.resolve_wikilink("Nowhere").unwrap();
    assert!(dangling.is_none());

    // Identity is stable across a rebuild.
    let id_before = baalda.id.clone();
    idx.rebuild(&vault).unwrap();
    let id_after = idx.get_note_meta("Projects/Baalda.md").unwrap().unwrap().id;
    assert_eq!(id_before, id_after);

    // A move keeps inbound links pointing at the same doc_id.
    std::fs::create_dir_all(vault.join("Archive")).unwrap();
    std::fs::rename(
        vault.join("Projects/Baalda.md"),
        vault.join("Archive/Baalda.md"),
    )
    .unwrap();
    idx.rename_note(
        &vault,
        &vault.join("Projects/Baalda.md"),
        &vault.join("Archive/Baalda.md"),
    )
    .unwrap();
    let moved = idx.get_note_meta("Archive/Baalda.md").unwrap().unwrap();
    assert_eq!(moved.id, id_before);
    assert_eq!(idx.get_backlinks(&moved.id).unwrap().len(), 2);
}

/// A minimal but REAL `.docx`: a zip with a `word/document.xml` holding one
/// paragraph. Built here rather than committed — a binary fixture in git is a
/// file nobody can review, and this is the shape the parser actually walks.
fn write_docx(path: &PathBuf, text: &str) {
    let mut buf = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        writer
            .start_file("word/document.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(
            writer,
            r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
        )
        .unwrap();
        writer.finish().unwrap();
    }
    std::fs::write(path, buf).unwrap();
}

/// Tier 2 end to end on a real vault: the rebuild registers the binaries and
/// hands back the paths whose text is stale, the worker extracts them off the
/// lock, and search answers over both tables at once.
#[test]
fn files_are_indexed_extracted_and_searchable() {
    let vault = std::env::temp_dir().join("context-test-files-vault");
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(vault.join("Reports")).unwrap();
    std::fs::create_dir_all(vault.join("attachments")).unwrap();

    notefile::write_note(&vault, "Index.md", "# Home\n\nSee the reports.\n").unwrap();
    std::fs::write(
        vault.join("Reports/regions.csv"),
        "region,total\nnorth,42\nsouth,rhubarb\n",
    )
    .unwrap();
    write_docx(
        &vault.join("Reports/Q3.docx"),
        "Revenue grew on sardonic marmalade",
    );
    // A stub video: never opened, findable by name.
    std::fs::write(vault.join("Reports/demo.mp4"), b"\x00\x00\x00 ftypmp42").unwrap();
    // The attachments store is hash-named and hidden — never indexed.
    write_docx(&vault.join("attachments/deadbeef01234567.docx"), "marmalade");

    let index = Mutex::new(Index::open(&vault).unwrap());
    let pending = index.lock().unwrap().rebuild(&vault).unwrap();
    assert_eq!(pending.len(), 3, "csv + docx + mp4, and nothing from attachments/");
    for path in pending {
        extract_worker::run(&vault, &index, &path).unwrap();
    }

    let guard = index.lock().unwrap();

    // A phrase that exists ONLY inside the .docx.
    let hits = guard.search_all("marmalade").unwrap();
    assert_eq!(hits.len(), 1, "attachments must not answer: {hits:?}");
    assert_eq!(hits[0].kind, "file");
    assert_eq!(hits[0].path, "Reports/Q3.docx");
    assert_eq!(hits[0].ext.as_deref(), Some("docx"));
    assert!(hits[0].snippet.contains("<mark>"));

    // A cell that exists only inside the .csv.
    let csv = guard.search_all("rhubarb").unwrap();
    assert_eq!(csv.len(), 1);
    assert_eq!(csv[0].path, "Reports/regions.csv");

    // The video has no body at all; its NAME is what makes it findable.
    let video = guard.search_all("demo").unwrap();
    assert_eq!(video.len(), 1);
    assert_eq!(video[0].path, "Reports/demo.mp4");

    // Binaries are never `notes` rows — that is the CRDT contract.
    let notes: Vec<String> = guard
        .list_note_titles()
        .unwrap()
        .into_iter()
        .map(|n| n.path)
        .collect();
    assert_eq!(notes, vec!["Index.md".to_string()]);

    // And the text is available to the sync layer by path.
    let text = guard.file_text("Reports/Q3.docx").unwrap().unwrap();
    assert_eq!(text.status, "ok");
    assert!(text.chars > 0 && text.text.contains("sardonic marmalade"));
    assert_eq!(text.sha256.len(), 64);
}
