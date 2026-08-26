//! Data-volume stress benchmark for the Baalda local core.
//!
//! Generates a large synthetic vault on disk (nested folders, frontmatter,
//! tags, dense `[[wikilinks]]`, plus a sprinkling of very large notes) and
//! then times the cold index build and the hot query paths against it.
//!
//! It is `#[ignore]`d so a normal `cargo test` skips it. Run explicitly:
//!
//!   cargo test --release --test data_volume_bench -- --ignored --nocapture
//!
//! Scale knobs (env vars):
//!   BAALDA_BENCH_NOTES       total notes to generate         (default 2000)
//!   BAALDA_BENCH_LINKS       wikilinks emitted per note      (default 8)
//!   BAALDA_BENCH_LARGE_EVERY every Nth note is a "large" one  (default 50)
//!   BAALDA_BENCH_LARGE_KB    approx size of a large note (KB) (default 64)

use desktop_lib::index::Index;
use desktop_lib::notefile;
use std::path::PathBuf;
use std::time::Instant;

/// Tiny deterministic PRNG (xorshift64*) — reproducible, no external crate.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % (n as u64)) as usize
    }
}

const WORDS: &[&str] = &[
    "vault",
    "note",
    "graph",
    "link",
    "crdt",
    "merge",
    "sync",
    "index",
    "search",
    "folder",
    "markdown",
    "editor",
    "buffer",
    "snapshot",
    "debounce",
    "backlink",
    "tag",
    "frontmatter",
    "atomic",
    "local",
    "first",
    "peer",
    "presence",
    "token",
    "permission",
    "share",
    "collaborate",
    "rewrite",
    "ingest",
    "egest",
    "watcher",
    "convergence",
    "identity",
    "durable",
    "source",
    "truth",
    "bridge",
    "operation",
];

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn note_name(i: usize) -> String {
    format!("note-{i:05}")
}

/// Folder path for note `i`: two levels, ~20 areas × ~100-note folders.
fn folder_for(i: usize) -> String {
    format!("area-{:02}/topic-{:03}", i / 2000, i / 100)
}

fn body(rng: &mut Rng, target_bytes: usize, links: &[usize]) -> String {
    let mut s = String::with_capacity(target_bytes + 256);
    // paragraphs of pseudo-prose until we hit the target size
    while s.len() < target_bytes {
        let sentence_words = 8 + rng.below(14);
        for _ in 0..sentence_words {
            s.push_str(WORDS[rng.below(WORDS.len())]);
            s.push(' ');
        }
        s.push_str(".\n\n");
    }
    // a stable, searchable needle in exactly one note family
    if !links.is_empty() && links[0] % 97 == 0 {
        s.push_str("UNIQUE_NEEDLE_XYZZY appears here.\n\n");
    }
    // dense wikilinks so the graph has real fan-out
    s.push_str("## Related\n");
    for &t in links {
        s.push_str(&format!("- [[{}]]\n", note_name(t)));
    }
    s
}

fn generate(vault: &PathBuf, notes: usize, links_per: usize, large_every: usize, large_kb: usize) {
    let _ = std::fs::remove_dir_all(vault);
    std::fs::create_dir_all(vault).unwrap();
    let mut rng = Rng(0x9E3779B97F4A7C15);

    for i in 0..notes {
        let mut links = Vec::with_capacity(links_per);
        for _ in 0..links_per {
            links.push(rng.below(notes));
        }
        let tags: Vec<&str> = (0..2 + rng.below(3))
            .map(|_| WORDS[rng.below(WORDS.len())])
            .collect();

        let target = if large_every > 0 && i % large_every == 0 {
            large_kb * 1024
        } else {
            300 + rng.below(1200)
        };

        let name = note_name(i);
        let content = format!(
            "---\ntitle: {name}\ntags: [{}]\n---\n# {name}\n\n{}",
            tags.join(", "),
            body(&mut rng, target, &links),
        );
        let rel = format!("{}/{name}.md", folder_for(i));
        notefile::write_note(vault, &rel, &content).unwrap();
    }
}

fn dir_size(path: &PathBuf) -> u64 {
    std::fs::read_dir(path)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

#[test]
#[ignore]
fn data_volume_bench() {
    let notes = env_usize("BAALDA_BENCH_NOTES", 2000);
    let links_per = env_usize("BAALDA_BENCH_LINKS", 8);
    let large_every = env_usize("BAALDA_BENCH_LARGE_EVERY", 50);
    let large_kb = env_usize("BAALDA_BENCH_LARGE_KB", 64);

    let vault = std::env::temp_dir().join(format!("baalda-bench-{notes}"));

    println!("\n=== Baalda data-volume benchmark ===");
    println!(
        "notes={notes} links/note={links_per} large-every={large_every} large-size={large_kb}KB"
    );

    let t = Instant::now();
    generate(&vault, notes, links_per, large_every, large_kb);
    let gen_ms = t.elapsed().as_millis();
    let bytes: u64 = walk_bytes(&vault);
    println!(
        "generate:        {gen_ms:>6} ms  ({notes} .md files, {:.1} MB on disk)",
        bytes as f64 / 1_048_576.0
    );

    // Cold open + full index build — the dominant startup cost for a big vault.
    let t = Instant::now();
    let idx = Index::open(&vault).unwrap();
    println!("index open:      {:>6} ms", t.elapsed().as_millis());

    let t = Instant::now();
    idx.rebuild(&vault).unwrap();
    let build_ms = t.elapsed().as_millis();
    println!(
        "index rebuild:   {build_ms:>6} ms  ({:.2} ms/note)",
        build_ms as f64 / notes as f64
    );

    // List every note title (sidebar / quick-switcher backing query).
    let t = Instant::now();
    let titles = idx.list_note_titles().unwrap();
    println!(
        "list titles:     {:>6} ms  ({} notes indexed)",
        t.elapsed().as_millis(),
        titles.len()
    );
    assert_eq!(titles.len(), notes, "all notes should be indexed");

    // FTS: a common word (many hits) and a rare needle (few hits).
    for q in ["graph merge", "convergence", "UNIQUE_NEEDLE_XYZZY"] {
        let t = Instant::now();
        let hits = idx.search_notes(q).unwrap();
        println!(
            "search {:<22} {:>6} µs  ({} hits)",
            format!("{:?}", q),
            t.elapsed().as_micros(),
            hits.len()
        );
    }

    // Backlink resolution on a note (graph-view / backlinks-panel query).
    let sample = title_path(&titles, notes / 2);
    let meta = idx.get_note_meta(&sample).unwrap().unwrap();
    let t = Instant::now();
    let backlinks = idx.get_backlinks(&meta.id).unwrap();
    println!(
        "backlinks(1):    {:>6} µs  ({} inbound to {})",
        t.elapsed().as_micros(),
        backlinks.len(),
        meta.title
    );

    // Wikilink resolution by name.
    let t = Instant::now();
    let resolved = idx.resolve_wikilink(&note_name(notes / 3)).unwrap();
    println!(
        "resolve link:    {:>6} µs  (resolved={})",
        t.elapsed().as_micros(),
        resolved.is_some()
    );

    // ---- batch (re)index of an existing set of notes ----------------------
    //
    // The watcher path: N already-known files change at once. The old code ran
    // `index_note` per path, and each call re-resolved EVERY link in the vault in
    // its own transaction — O(N × links). `index_notes` does one pass for the
    // batch. Both are timed here so the ratio is visible.
    let batch_n = env_usize("BAALDA_BENCH_BATCH", 200).min(notes);
    let batch: Vec<PathBuf> = (0..batch_n)
        .map(|i| vault.join(format!("{}/{}.md", folder_for(i), note_name(i))))
        .collect();

    let t = Instant::now();
    let failures = idx.index_notes(&vault, &batch).unwrap();
    let batched_ms = t.elapsed().as_millis();
    assert!(failures.is_empty(), "batch reported failures: {failures:?}");
    println!(
        "index_notes({batch_n}):  {batched_ms:>6} ms  ({:.2} ms/note, 1 link pass)",
        batched_ms as f64 / batch_n as f64
    );

    // The same work the old way: one call, one transaction, one link pass each.
    let per_file_n = batch_n.min(env_usize("BAALDA_BENCH_PER_FILE", 50));
    let t = Instant::now();
    for abs in batch.iter().take(per_file_n) {
        idx.index_note(&vault, abs).unwrap();
    }
    let per_file_ms = t.elapsed().as_millis();
    println!(
        "index_note ×{per_file_n:<4}     {per_file_ms:>6} ms  ({:.2} ms/note, {per_file_n} link passes)",
        per_file_ms as f64 / per_file_n as f64
    );

    // ---- the reported failure mode: drop N brand-new files at once ---------
    //
    // "Copy 1000 notes into the vault". Every file is new, so every one is a
    // fresh insert AND (the old way) a whole-vault link pass.
    let drop_n = env_usize("BAALDA_BENCH_DROP", 1000);
    let mut dropped: Vec<PathBuf> = Vec::with_capacity(drop_n);
    let mut rng = Rng(0xDEADBEEFCAFEF00D);
    for i in 0..drop_n {
        let name = format!("dropped-{i:05}");
        let links: Vec<usize> = (0..links_per).map(|_| rng.below(notes)).collect();
        let content = format!("# {name}\n\n{}", body(&mut rng, 600, &links));
        let rel = format!("Dropped/batch-{:03}/{name}.md", i / 100);
        notefile::write_note(&vault, &rel, &content).unwrap();
        dropped.push(vault.join(&rel));
    }
    let t = Instant::now();
    let failures = idx.index_notes(&vault, &dropped).unwrap();
    let drop_ms = t.elapsed().as_millis();
    assert!(failures.is_empty(), "drop reported failures: {failures:?}");
    println!(
        "drop {drop_n} + index:  {drop_ms:>6} ms  ({:.2} ms/note)",
        drop_ms as f64 / drop_n as f64
    );
    assert_eq!(
        idx.list_note_titles().unwrap().len(),
        notes + drop_n,
        "every dropped note should be indexed"
    );

    // And removing them again, batched.
    let t = Instant::now();
    idx.remove_notes(&vault, &dropped).unwrap();
    let rm_ms = t.elapsed().as_millis();
    println!(
        "remove {drop_n}:        {rm_ms:>6} ms  ({:.2} ms/note)",
        rm_ms as f64 / drop_n as f64
    );
    assert_eq!(idx.list_note_titles().unwrap().len(), notes);

    let sqlite_bytes = dir_size(&vault.join(".context"));
    println!(
        "index.sqlite dir:        {:.1} MB",
        sqlite_bytes as f64 / 1_048_576.0
    );
    println!("=== done ({}) ===\n", vault.display());

    let _ = std::fs::remove_dir_all(&vault);
}

fn walk_bytes(root: &PathBuf) -> u64 {
    let mut total = 0;
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
    }
    total
}

fn title_path(titles: &[desktop_lib::index::NoteTitle], _n: usize) -> String {
    // pick a note that has inbound links with high probability: any note works,
    // the middle one keeps it deterministic.
    titles[titles.len() / 2].path.clone()
}
