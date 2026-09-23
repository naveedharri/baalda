//! Integration test for the bulk sync engine's Rust half: `apply_bootstrap_batch`
//! and `materialize_notes_batch`, driven through their pure appliers
//! (`commands::apply_bootstrap_entries` / `commands::materialize_notes`) against
//! a real on-disk vault and a real `.context/index.sqlite`.
//!
//! What these pin is the SAFETY contract, not the speed: a bootstrap page must
//! never land on content, must never touch a doc this device has local CRDT for,
//! must never write outside the vault's note space, and must be safe to apply
//! twice.

use desktop_lib::commands::{
    apply_bootstrap_entries, materialize_notes, BootstrapEntry, MaterializeItem,
};
use desktop_lib::index::Index;
use desktop_lib::notefile;
use std::path::{Path, PathBuf};

fn entry(doc_id: &str, rel: &str, content: &str) -> BootstrapEntry {
    BootstrapEntry {
        doc_id: doc_id.to_string(),
        rel_path: rel.to_string(),
        content: content.to_string(),
        // The bytes are opaque to Rust — it stores them verbatim — so a
        // recognisable non-empty blob is all a fixture needs.
        snapshot: vec![1, 2, 3, 4],
        state_vector: vec![9, 9],
    }
}

fn status<'a>(out: &'a [desktop_lib::commands::BootstrapOutcome], doc_id: &str) -> &'a str {
    &out.iter()
        .find(|o| o.doc_id == doc_id)
        .unwrap_or_else(|| panic!("no outcome for {doc_id}"))
        .status
}

/// Which path the index has this doc id at, via the public listing (there is no
/// `path_for_id` on `Index`, and this test has no business adding one).
fn path_for_id(index: &Index, doc_id: &str) -> Option<String> {
    index
        .list_note_titles()
        .unwrap()
        .into_iter()
        .find(|n| n.id == doc_id)
        .map(|n| n.path)
}

fn fresh_vault(name: &str) -> (tempfile::TempDir, PathBuf, Index) {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("bootstrap-{name}-"))
        .tempdir()
        .unwrap();
    let vault = tmp.path().to_path_buf();
    let index = Index::open(&vault).unwrap();
    index.rebuild(&vault).unwrap();
    (tmp, vault, index)
}

/// Everything that decides whether two applies produced the same state.
fn db_fingerprint(index: &Index, vault: &Path, docs: &[&str]) -> Vec<String> {
    docs.iter()
        .map(|d| {
            let st = index.load_yjs_state(d).unwrap();
            let meta = path_for_id(index, d)
                .and_then(|rel| index.get_note_meta(&rel).unwrap());
            format!(
                "{d}|snapshot={:?}|updates={}|meta={meta:?}",
                st.snapshot, st.update_count
            )
        })
        .chain(std::iter::once(format!(
            "tree={:?}",
            sorted_files(vault)
        )))
        .collect()
}

fn sorted_files(vault: &Path) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = walk(vault, vault);
    out.sort();
    out
}

fn walk(root: &Path, dir: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".context" {
            continue;
        }
        if path.is_dir() {
            out.extend(walk(root, &path));
        } else {
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().to_string();
            out.push((rel, std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)));
        }
    }
    out
}

#[test]
fn bootstrap_applies_the_eligibility_table_end_to_end() {
    let (_tmp, vault, index) = fresh_vault("eligibility");

    // `written` (missing) needs nothing set up.
    // `written` (0-byte placeholder) — the 307-stub case.
    notefile::write_note(&vault, "Stub.md", "").unwrap();
    // `unchanged` — the file already holds exactly the server's bytes (a page
    // whose files landed but whose transaction never committed).
    notefile::write_note(&vault, "Same.md", "identical bytes").unwrap();
    // `conflict` — local content the page must not touch.
    notefile::write_note(&vault, "Mine.md", "MY local edit").unwrap();
    // `rejected` — this device already holds CRDT ops for the doc.
    notefile::write_note(&vault, "Diverged.md", "").unwrap();
    index.append_yjs_update("doc-diverged", &[7, 7, 7]).unwrap();

    let entries = vec![
        entry("doc-missing", "New/Fresh.md", "# Fresh\n\nfrom the server\n"),
        entry("doc-stub", "Stub.md", "# Stub\n\nhydrated\n"),
        entry("doc-same", "Same.md", "identical bytes"),
        entry("doc-mine", "Mine.md", "the server's different text"),
        entry("doc-diverged", "Diverged.md", "server text"),
    ];
    let out = apply_bootstrap_entries(&vault, &index, &entries).unwrap();

    assert_eq!(status(&out, "doc-missing"), "written");
    assert_eq!(status(&out, "doc-stub"), "written");
    assert_eq!(status(&out, "doc-same"), "unchanged");
    assert_eq!(status(&out, "doc-mine"), "conflict");
    assert_eq!(status(&out, "doc-diverged"), "rejected");

    // Files: the two writes landed, the conflict was not touched.
    assert_eq!(
        notefile::read_note(&vault, "New/Fresh.md").unwrap(),
        "# Fresh\n\nfrom the server\n"
    );
    assert_eq!(
        notefile::read_note(&vault, "Stub.md").unwrap(),
        "# Stub\n\nhydrated\n"
    );
    assert_eq!(
        notefile::read_note(&vault, "Mine.md").unwrap(),
        "MY local edit",
        "a conflict never writes"
    );
    assert_eq!(
        notefile::read_note(&vault, "Diverged.md").unwrap(),
        "",
        "a rejected doc never writes either"
    );

    // CRDT rows: written AND unchanged both get them — that is what makes a
    // crashed page idempotent.
    for doc in ["doc-missing", "doc-stub", "doc-same"] {
        let st = index.load_yjs_state(doc).unwrap();
        assert_eq!(st.snapshot, Some(vec![1, 2, 3, 4]), "{doc} has a snapshot");
    }
    assert!(
        index.load_yjs_state("doc-mine").unwrap().snapshot.is_none(),
        "the conflicted doc got no CRDT rows"
    );
    // The bytes now on disk are the doc's disk base (#200): a later launch
    // must treat that file as "what we last synced", not as an external edit.
    assert_eq!(
        index.get_disk_base("doc-stub").unwrap(),
        Some(notefile::sha256_hex("# Stub\n\nhydrated\n"))
    );
    assert_eq!(
        index.get_disk_base("doc-same").unwrap(),
        Some(notefile::sha256_hex("identical bytes"))
    );
    assert_eq!(index.get_disk_base("doc-mine").unwrap(), None);
    assert_eq!(index.get_disk_base("doc-diverged").unwrap(), None);
    // The diverged doc's own log is intact and no snapshot was invented.
    let diverged = index.load_yjs_state("doc-diverged").unwrap();
    assert!(diverged.snapshot.is_none());
    assert_eq!(diverged.updates, vec![vec![7, 7, 7]]);

    // The state vector is the doc's line in the durable `hello` manifest.
    let manifest = index.list_yjs_state_vectors().unwrap();
    let mut ids: Vec<String> = manifest.iter().map(|m| m.doc_id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["doc-missing", "doc-same", "doc-stub"]);
    assert!(manifest.iter().all(|m| m.state_vector == vec![9, 9]));

    // The index row carries the SERVER's doc id, not a fresh local uuid —
    // without that the next pull registers the note a second time.
    for (doc, rel) in [
        ("doc-missing", "New/Fresh.md"),
        ("doc-stub", "Stub.md"),
        ("doc-same", "Same.md"),
    ] {
        assert_eq!(
            path_for_id(&index, doc).as_deref(),
            Some(rel),
            "{doc} is indexed at {rel}"
        );
    }
}

#[test]
fn a_second_identical_apply_changes_nothing() {
    let (_tmp, vault, index) = fresh_vault("idempotent");
    let entries = vec![
        entry("doc-a", "A.md", "alpha\n"),
        entry("doc-b", "Nested/B.md", "beta\n"),
    ];

    let first = apply_bootstrap_entries(&vault, &index, &entries).unwrap();
    assert!(first.iter().all(|o| o.status == "written"));
    let before = db_fingerprint(&index, &vault, &["doc-a", "doc-b"]);

    let second = apply_bootstrap_entries(&vault, &index, &entries).unwrap();
    // Every doc now HAS local CRDT, so the fast path refuses it — the TS side
    // cold-applies through `VaultDocStore`, which merges.
    assert!(
        second.iter().all(|o| o.status == "rejected"),
        "{second:?}"
    );
    assert_eq!(
        db_fingerprint(&index, &vault, &["doc-a", "doc-b"]),
        before,
        "the re-apply wrote nothing"
    );
}

#[test]
fn a_page_whose_rows_never_committed_re_applies() {
    // The crash case the `unchanged` row exists for: files on disk, no CRDT.
    let (_tmp, vault, index) = fresh_vault("half-applied");
    notefile::write_note(&vault, "Half.md", "landed before the crash\n").unwrap();

    let entries = vec![entry("doc-half", "Half.md", "landed before the crash\n")];
    let out = apply_bootstrap_entries(&vault, &index, &entries).unwrap();

    assert_eq!(status(&out, "doc-half"), "unchanged");
    assert_eq!(
        index.load_yjs_state("doc-half").unwrap().snapshot,
        Some(vec![1, 2, 3, 4]),
        "an unchanged file STILL gets its CRDT rows, or the doc is stranded"
    );
}

#[test]
fn bootstrap_refuses_paths_outside_the_note_space() {
    let (_tmp, vault, index) = fresh_vault("paths");
    notefile::write_atomic_fsync(
        &vault.join(".context").join("config.json"),
        br#"{"organizationId":"org-1"}"#,
    )
    .unwrap();

    let entries = vec![
        entry("doc-dotdot", "../escape.md", "nope"),
        entry("doc-abs", "/etc/passwd.md", "nope"),
        entry("doc-ctx", ".context/config.json", "{}"),
        entry("doc-ctx-note", ".context/evil.md", "nope"),
        entry("doc-git", ".git/config.md", "nope"),
        entry("doc-hidden", "Notes/.hidden/x.md", "nope"),
        entry("doc-attach", "attachments/abc123.md", "nope"),
        entry("doc-binary", "Notes/report.pdf", "nope"),
        entry("doc-denied", "node_modules/pkg/readme.md", "nope"),
    ];
    let out = apply_bootstrap_entries(&vault, &index, &entries).unwrap();

    assert!(
        out.iter().all(|o| o.status == "rejected"),
        "every unsafe path is refused: {out:?}"
    );
    assert!(out.iter().all(|o| o.reason.is_some()), "with a reason");

    // Nothing was created anywhere, and the vault's doc-id map is untouched.
    assert_eq!(
        std::fs::read_to_string(vault.join(".context/config.json")).unwrap(),
        r#"{"organizationId":"org-1"}"#
    );
    assert!(sorted_files(&vault).is_empty(), "no files were written");
    assert!(!vault.join("..").join("escape.md").exists());
}

#[test]
fn a_diverged_doc_is_never_fast_pathed() {
    // Both shapes of "local CRDT": an update log, and a snapshot row (including
    // the snapshot-NULL, state-vector-only row `save_yjs_state_vectors` writes).
    let (_tmp, vault, index) = fresh_vault("diverged");
    index.append_yjs_update("doc-log", &[1]).unwrap();
    index
        .save_yjs_snapshot("doc-snap", &[5, 5], &[6], None)
        .unwrap();
    index
        .save_yjs_state_vectors(&[("doc-sv".to_string(), vec![4, 4])])
        .unwrap();

    let entries = vec![
        entry("doc-log", "Log.md", "server text"),
        entry("doc-snap", "Snap.md", "server text"),
        entry("doc-sv", "Sv.md", "server text"),
    ];
    let out = apply_bootstrap_entries(&vault, &index, &entries).unwrap();

    assert!(out.iter().all(|o| o.status == "rejected"), "{out:?}");
    assert!(sorted_files(&vault).is_empty(), "no file was written");
    assert_eq!(
        index.load_yjs_state("doc-snap").unwrap().snapshot,
        Some(vec![5, 5]),
        "the local snapshot was not overwritten"
    );
}

#[test]
fn the_batch_lands_the_same_state_as_the_one_at_a_time_path() {
    // The fast path must be an optimisation, not a second behaviour. Two vaults,
    // same input: one bootstrapped, one built the old way (write_note +
    // index_note + rebind + save_yjs_snapshot).
    let (_a, batched, batch_idx) = fresh_vault("equiv-batch");
    let (_b, serial, serial_idx) = fresh_vault("equiv-serial");

    let entries = vec![
        entry("doc-1", "One.md", "# One\n\nlinks to [[Two]]\n"),
        entry("doc-2", "Folder/Two.md", "# Two\n\n#tagged back to [[One]]\n"),
    ];
    apply_bootstrap_entries(&batched, &batch_idx, &entries).unwrap();

    for e in &entries {
        notefile::write_note(&serial, &e.rel_path, &e.content).unwrap();
        let abs = serial.join(&e.rel_path);
        serial_idx.index_note(&serial, &abs).unwrap();
        serial_idx.rebind_note_id(&e.rel_path, &e.doc_id).unwrap();
        serial_idx
            .save_yjs_snapshot(&e.doc_id, &e.snapshot, &e.state_vector, None)
            .unwrap();
    }

    for e in &entries {
        assert_eq!(
            notefile::read_note(&batched, &e.rel_path).unwrap(),
            notefile::read_note(&serial, &e.rel_path).unwrap()
        );
        assert_eq!(
            batch_idx.load_yjs_state(&e.doc_id).unwrap().snapshot,
            serial_idx.load_yjs_state(&e.doc_id).unwrap().snapshot
        );
        assert_eq!(
            path_for_id(&batch_idx, &e.doc_id),
            path_for_id(&serial_idx, &e.doc_id)
        );
    }
    // Backlinks survive the batched rebind exactly as they do the serial one —
    // this is what the two-ids-in-`touched` rule buys.
    let mut batched_backlinks: Vec<String> = batch_idx
        .get_backlinks("doc-1")
        .unwrap()
        .into_iter()
        .map(|b| b.path)
        .collect();
    let mut serial_backlinks: Vec<String> = serial_idx
        .get_backlinks("doc-1")
        .unwrap()
        .into_iter()
        .map(|b| b.path)
        .collect();
    batched_backlinks.sort();
    serial_backlinks.sort();
    assert_eq!(batched_backlinks, vec!["Folder/Two.md".to_string()]);
    assert_eq!(batched_backlinks, serial_backlinks);
}

#[test]
fn materialize_creates_only_and_rebinds_in_one_pass() {
    let (_tmp, vault, index) = fresh_vault("materialize");
    // A file that is already there with content must survive untouched.
    notefile::write_note(&vault, "Existing.md", "do not touch me").unwrap();
    index
        .index_note(&vault, &vault.join("Existing.md"))
        .unwrap();

    let items = vec![
        MaterializeItem {
            rel_path: "Existing.md".into(),
            doc_id: Some("doc-existing".into()),
        },
        MaterializeItem {
            rel_path: "New/Placeholder.md".into(),
            doc_id: Some("doc-new".into()),
        },
        MaterializeItem {
            rel_path: "NoId.md".into(),
            doc_id: None,
        },
        MaterializeItem {
            rel_path: ".context/config.json".into(),
            doc_id: Some("doc-evil".into()),
        },
    ];
    let out = materialize_notes(&vault, &index, &items).unwrap();

    assert_eq!(out[0].rel_path, "Existing.md");
    assert!(!out[0].created, "an existing file is never re-created");
    assert!(out[0].rebound);
    assert_eq!(
        notefile::read_note(&vault, "Existing.md").unwrap(),
        "do not touch me"
    );

    assert!(out[1].created && out[1].rebound);
    assert_eq!(notefile::read_note(&vault, "New/Placeholder.md").unwrap(), "");
    assert_eq!(path_for_id(&index, "doc-new").as_deref(), Some("New/Placeholder.md"));

    assert!(out[2].created && !out[2].rebound, "no doc id, no rebind");

    assert!(!out[3].created && !out[3].rebound, "`.context` is refused");
    assert!(!vault.join(".context/config.json").exists());

    // Re-running is a no-op: nothing is created, everything is already bound.
    let again = materialize_notes(&vault, &index, &items).unwrap();
    assert!(again.iter().all(|o| !o.created));
    assert!(again[0].rebound && again[1].rebound);
}

#[test]
fn a_five_thousand_entry_page_applies_in_one_pass() {
    // Not a benchmark — a ceiling. A page is 256 docs server-side, so 5,000 is
    // ~20 pages' worth in one call; if this is slow, the per-note cost is wrong
    // (an accidental link pass per doc is what it would look like).
    let (_tmp, vault, index) = fresh_vault("scale");
    let entries: Vec<BootstrapEntry> = (0..5_000)
        .map(|i| {
            entry(
                &format!("doc-{i:05}"),
                &format!("Bulk/{:03}/note-{i:05}.md", i % 50),
                &format!("# Note {i}\n\nbody with a [[link-{}]]\n", i % 97),
            )
        })
        .collect();

    let started = std::time::Instant::now();
    let out = apply_bootstrap_entries(&vault, &index, &entries).unwrap();
    let elapsed = started.elapsed();
    println!(
        "apply_bootstrap_batch: 5,000 entries in {} ms ({:.2} ms/doc)",
        elapsed.as_millis(),
        elapsed.as_secs_f64() * 1000.0 / 5000.0
    );

    assert_eq!(out.len(), 5_000);
    assert!(out.iter().all(|o| o.status == "written"), "all written");
    assert_eq!(index.list_yjs_state_vectors().unwrap().len(), 5_000);
    assert!(
        elapsed.as_secs() < 60,
        "5,000 entries took {:?}, which is past any sane bound",
        elapsed
    );
}
