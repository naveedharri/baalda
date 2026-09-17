//! Integration test: build a real on-disk test vault (nested folders, tags,
//! wiki-links) in the OS temp dir, then exercise the public index logic
//! against it end-to-end.

use desktop_lib::index::Index;
use desktop_lib::notefile;
use std::path::PathBuf;

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
