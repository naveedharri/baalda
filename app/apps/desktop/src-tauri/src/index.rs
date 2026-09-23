//! The local SQLite index (spec 02 §3). A derived, rebuildable layer over the
//! `.md` files: FTS5 search, backlinks, tags, and the stable `doc_id` ↔ path map.
//!
//! Identity rule: notes are keyed by `doc_id` (a UUID), never by path. The
//! open-time `rebuild` reconciles against the `.md` files incrementally,
//! preserving existing ids by matching on path, so reopening a vault never
//! forks a note's identity. On rename we update the path column by id, so
//! inbound links (which store `dst_note_id`) never break.

use crate::attachments::HashEntry;
use crate::error::{io_ctx, AppError, AppResult};
use crate::extract::kind_for;
use crate::notefile::sha256_hex;
use crate::parse::{parse_html, parse_note, parse_plain, ParsedNote};
use crate::stats::now_ms;
use crate::vault::{is_ignored_name, is_indexable_file, is_note_file, rel_from_abs};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;
use walkdir::WalkDir;

/// Which derivation a note-family file gets.
///
/// Only markdown runs the markdown parser. `parse.rs` owns the `#tag` ↔ editor
/// contract and the `[[wikilink]]` rules, and both are meaningless outside
/// markdown — so `.txt`/`.canvas` are indexed as plain text under their stem and
/// `.html` as its stripped text. All of them still get a `notes` row, an FTS
/// row and a stable `doc_id`, which is what makes them searchable and
/// rename-safe like every other note.
fn parse_for(abs: &Path, content: &str, stem: &str) -> ParsedNote {
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => parse_note(content, stem),
        "html" | "htm" => parse_html(content, stem),
        _ => parse_plain(content, stem),
    }
}

/// Only log a batch's timing past this many files: a single-note save goes
/// through the same code and must stay silent.
const BATCH_LOG_MIN: usize = 50;

/// Files above this are indexed by title only — never parsed for body text or
/// links. Mirrors the sync layer's `MAX_NOTE_BYTES` (contentUpload.ts): a note
/// too big to upload is a note too big to fully index. See `index_one`.
const MAX_INDEX_BYTES: u64 = 10 * 1024 * 1024;

/// Which links a resolution pass has to reconsider.
pub enum LinkScope<'a> {
    /// Every link in the vault. Correct but O(all links): only for `rebuild`,
    /// where we are rewriting everything anyway.
    All,
    /// Only the links a batch can have changed the answer for (see
    /// `Index::resolve_links` for why this set is sufficient). These are the
    /// note ids the batch created, re-parsed, renamed or removed.
    Touched(&'a [String]),
}

/// What one `index_one` call did with a file.
///
/// The distinction is the point of the hash gate: an `Unchanged` file cost one
/// read and one sha256 and wrote nothing, so it must not join the link pass and
/// the UI must not be told to act on it.
enum IndexedNote {
    /// The note's rows were (re)written. Carries the doc_id.
    Indexed(String),
    /// The bytes on disk already hash to the `notes.sha256` stored for this
    /// path: nothing was rewritten (at most `mtime` was refreshed). No id,
    /// because the only thing a caller can do with this file is leave it alone —
    /// it is out of the link pass by construction.
    Unchanged,
}

/// What a batch [`Index::index_notes`] did, per path.
///
/// `failures` are per-path and non-fatal (one unreadable file must not cost the
/// rest of the batch); `unchanged` are the paths the hash gate skipped, which
/// the watcher forwards to the UI as `unchanged: true`.
#[derive(Debug, Default)]
pub struct IndexOutcome {
    pub failures: Vec<(PathBuf, AppError)>,
    pub unchanged: Vec<PathBuf>,
}

/// One doc of a bootstrap page, as far as the index is concerned: the file is
/// already on disk, these are the rows it needs.
#[derive(Debug, Clone)]
pub struct BootstrapRow {
    /// The SERVER's doc id — the identity every layer keys by.
    pub doc_id: String,
    pub rel_path: String,
    /// The merged Yjs snapshot for `yjs_snapshot.snapshot`.
    pub snapshot: Vec<u8>,
    /// Its state vector, i.e. this doc's line in the durable `hello` manifest.
    pub state_vector: Vec<u8>,
    /// sha256 of the content now on disk — recorded as the doc's disk base
    /// (`yjs_disk_base`) in the same transaction as the snapshot.
    pub content_sha: String,
}

/// Upsert one `yjs_disk_base` row on any connection or transaction.
fn set_disk_base_on(conn: &Connection, doc_id: &str, sha256: &str) -> AppResult<()> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO yjs_disk_base (doc_id, sha256, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(doc_id) DO UPDATE SET sha256 = excluded.sha256,
                                           updated_at = excluded.updated_at",
        params![doc_id, sha256, now_ms],
    )?;
    Ok(())
}

pub struct Index {
    conn: Connection,
    /// Test-only: how many times `resolve_links` has run. The entire point of
    /// the batch entry points is ONE link pass per batch instead of one per file,
    /// and that difference is only observable by counting.
    #[cfg(test)]
    resolve_calls: std::cell::Cell<usize>,
    /// Test-only: how many `folders` rows `upsert_folder` has written. A clean
    /// reopen must write none, and that difference is only observable by
    /// counting — the resulting table is identical either way.
    #[cfg(test)]
    folder_writes: std::cell::Cell<usize>,
}

/// One search hit, from EITHER tier. `kind` is what tells the panel whether
/// `id` is a note doc_id or a `files.id`, and whether to badge the row.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub path: String,
    pub title: String,
    pub snippet: String,
    /// "note" | "file".
    pub kind: String,
    /// Lowercase extension, no dot — `None` only for a path without one.
    pub ext: Option<String>,
}

/// A hit plus its raw bm25 score, before the two tiers are merged. SQLite's
/// bm25() is NEGATIVE and sorts ascending (more negative = better match), which
/// is why the file penalty below is added rather than subtracted.
#[derive(Debug, Clone)]
struct RankedHit {
    score: f64,
    result: SearchResult,
}

/// How much worse a file hit has to be before it outranks a note.
///
/// The vault is a note-taking app: when a phrase appears in a note AND in a
/// spreadsheet someone dropped next to it, the note is the answer. bm25 gaps
/// between genuinely different matches run to whole units, so a tenth breaks a
/// tie (and a near-tie) without ever burying a strong file match under a weak
/// note.
const FILE_RANK_PENALTY: f64 = 0.1;

/// Ceiling on a merged result set — the same 100 each tier was capped at.
const SEARCH_LIMIT: usize = 100;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub id: String,
    pub path: String,
    pub title: String,
    pub link_text: String,
}

/// One resolved directed edge of the note graph (`source` links to `target`,
/// both note ids). Serialized field names match the front-end `GraphEdge`.
#[derive(Debug, Serialize, Clone)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub sha256: String,
    pub frontmatter: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteTitle {
    pub id: String,
    pub path: String,
    pub title: String,
}

/// One `#tag` and how many notes carry it. Feeds the editor's `#` completion,
/// where "how often do I actually use this" is the only sensible ranking.
#[derive(Debug, Serialize, Clone)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

/// One frontmatter key and how many notes carry it — the ordering the
/// Properties panel's key suggestions use.
#[derive(Debug, Serialize, Clone)]
pub struct PropertyKeyCount {
    pub key: String,
    pub count: i64,
}

/// A JSON scalar as the panel would show it. Objects and arrays are skipped:
/// a value suggestion has to be something a single field can hold.
fn scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub id: String,
    pub path: String,
}

impl Index {
    /// Open (creating if needed) the index at `<vault>/.context/index.sqlite`.
    pub fn open(vault: &Path) -> AppResult<Self> {
        let context_dir = vault.join(".context");
        // Named + logged rather than a bare `?`: this is one of the three I/O
        // calls that can fail an open with "The system cannot find the file
        // specified. (os error 2)" and, until #128, the only way to tell them
        // apart was to guess.
        std::fs::create_dir_all(&context_dir)
            .map_err(io_ctx("create the folder", &context_dir))?;
        let db_path = context_dir.join("index.sqlite");
        let conn = Connection::open(&db_path).map_err(|e| {
            AppError::new(format!(
                "Couldn't open the index at {}: {e}",
                db_path.display()
            ))
        })?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Wait up to 5s for a contended lock instead of failing immediately with
        // "database is locked" — a big index build and a concurrent read/sync
        // can briefly overlap, and a short wait is far better than an error.
        conn.pragma_update(None, "busy_timeout", 5000)?;
        // NORMAL, not the default FULL: under WAL this stops fsync'ing the WAL on
        // every commit, which is what made a bulk index (one transaction per file)
        // disk-bound. The safety trade is bounded and acceptable here — WAL+NORMAL
        // can lose the last transaction(s) on an OS/power crash but never corrupts
        // the database, and everything in this file is either derived from the
        // `.md` files (rebuildable by `rebuild`) or a CRDT update log whose peer
        // copies (the open Y.Doc and the server) re-supply anything lost.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let idx = Index::new(conn);
        idx.migrate()?;
        Ok(idx)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        let idx = Index::new(conn);
        idx.migrate()?;
        Ok(idx)
    }

    fn new(conn: Connection) -> Self {
        Index {
            conn,
            #[cfg(test)]
            resolve_calls: std::cell::Cell::new(0),
            #[cfg(test)]
            folder_writes: std::cell::Cell::new(0),
        }
    }

    /// Test-only accessor for the link-pass counter (see `resolve_calls`).
    #[cfg(test)]
    fn resolve_call_count(&self) -> usize {
        self.resolve_calls.get()
    }

    /// Test-only accessor for the folder-write counter (see `folder_writes`).
    #[cfg(test)]
    fn folder_write_count(&self) -> usize {
        self.folder_writes.get()
    }

    fn migrate(&self) -> AppResult<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS notes (
                id           TEXT PRIMARY KEY,
                path         TEXT UNIQUE NOT NULL,
                title        TEXT,
                mtime        INTEGER,
                sha256       TEXT,
                frontmatter  TEXT
            );

            -- Spec 02 §3 describes a contentless FTS5 table, but SQLite's
            -- contentless (content='') tables cannot serve snippet()/highlight(),
            -- which the search UI relies on. We therefore keep a self-contained
            -- FTS5 table (still fully rebuildable from the .md files) whose rowid
            -- mirrors notes.rowid, and feed it explicitly on each write.
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                title, body,
                tokenize='unicode61 remove_diacritics 2'
            );

            CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY,
                name TEXT UNIQUE
            );

            CREATE TABLE IF NOT EXISTS note_tags (
                note_id TEXT,
                tag_id  INTEGER,
                PRIMARY KEY (note_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS links (
                id           INTEGER PRIMARY KEY,
                src_note_id  TEXT NOT NULL,
                dst_note_id  TEXT,
                dst_path_raw TEXT,
                link_text    TEXT,
                position     INTEGER
            );

            CREATE TABLE IF NOT EXISTS folders (
                id        TEXT PRIMARY KEY,
                parent_id TEXT,
                name      TEXT,
                path      TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_note_id);
            CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_note_id);
            CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);

            -- Phase 1: local CRDT persistence (spec 02 §4). An append-only Yjs
            -- update log plus a periodic per-doc snapshot. These are keyed by
            -- doc_id and are NOT touched by `rebuild()` (which only wipes the
            -- file-derived tables), so CRDT state survives a re-index.
            CREATE TABLE IF NOT EXISTS yjs_updates (
                id         INTEGER PRIMARY KEY,
                doc_id     TEXT,
                "update"   BLOB,
                created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS yjs_snapshot (
                doc_id       TEXT PRIMARY KEY,
                snapshot     BLOB,
                state_vector BLOB,
                seq          INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_yjs_updates_doc ON yjs_updates(doc_id);

            -- The "disk base" of each CRDT doc (#200): the sha256 of the bytes
            -- this device last wrote to the doc's `.md` (egest, bootstrap) or
            -- last read INTO the doc (ingest, seed). A file whose hash still
            -- equals it was never touched outside the app since we last synced
            -- it, so a doc that differs is simply AHEAD of its file (a write
            -- that failed or was cut short by a quit) — the doc must be written
            -- out, never diffed against those older bytes, which would turn the
            -- newest text into deletions. Keyed by doc_id like the other
            -- `yjs_*` tables, untouched by `rebuild()`. `CREATE IF NOT EXISTS`
            -- is the whole migration: an existing vault simply has no rows yet,
            -- which the bridge reads as "unknown" (the old behaviour).
            CREATE TABLE IF NOT EXISTS yjs_disk_base (
                doc_id     TEXT PRIMARY KEY,
                sha256     TEXT NOT NULL,
                updated_at INTEGER
            );

            -- Per-note editor UI state (Stage 3b: which sections are folded).
            -- Keyed by doc_id and NOT touched by `rebuild()`, exactly like the
            -- `yjs_*` tables above: it describes how you were reading a note,
            -- which a re-index has no business forgetting. The `state` column is
            -- opaque JSON owned by the TS layer (`lib/editor/folding.ts`), so a
            -- new kind of UI state costs no migration here. Orphan rows are
            -- swept by `prune_yjs_docs`.
            CREATE TABLE IF NOT EXISTS note_ui_state (
                doc_id     TEXT PRIMARY KEY,
                state      TEXT,
                updated_at INTEGER
            );

            -- Tier 2: the tree-visible files that are NOT notes (a .docx, a
            -- .mp4, a .csv). Deliberately a separate table from `notes`:
            -- `notes.id` IS the CRDT doc_id and `list_note_titles` feeds the
            -- sync layer's `registerNote`, so a binary in there would be
            -- registered as a note and pushed into the bridge. Same identity
            -- rule though — `files.id` is stable across a rename, preserved by
            -- path on every rebuild, which is what lets the server half of PR3
            -- register these as `files` rows later.
            --
            -- `text_status` is `extract.rs TextStatus`: pending | ok |
            -- skipped_size | unsupported | error. `text_sha` is the sha256 of
            -- the bytes the stored text came from, which is also the
            -- `file_text` cache key.
            CREATE TABLE IF NOT EXISTS files (
                id          TEXT PRIMARY KEY,
                path        TEXT UNIQUE NOT NULL,
                ext         TEXT,
                kind        TEXT,
                size        INTEGER,
                mtime       INTEGER,
                sha256      TEXT,
                text_sha    TEXT,
                text_status TEXT,
                indexed_at  INTEGER
            );

            -- Self-contained like `notes_fts` and for the same reason:
            -- snippet() needs the content. `name` is the file name, so an
            -- image or a video — which have no body at all — is still findable
            -- by what it is called. rowid mirrors files.rowid.
            CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                name, body,
                tokenize='unicode61 remove_diacritics 2'
            );

            -- Extracted text, keyed by CONTENT. A rename, a copy or a file that
            -- came back after a delete costs a sha256 instead of a re-parse, and
            -- two copies of the same attachment store their text once. Swept by
            -- `prune_file_text` once the extraction queue drains.
            CREATE TABLE IF NOT EXISTS file_text (
                sha256     TEXT PRIMARY KEY,
                chars      INTEGER,
                body       TEXT,
                created_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);

            -- sha256 cache for the vault-root `attachments/` store.
            --
            -- A separate table from `files` and not a bug: attachments are
            -- deliberately OUTSIDE the file index (`vault::INDEX_ATTACHMENTS`
            -- is false, because a search hit on `attachments/<16hex>.png`
            -- names something the user cannot see or open), so there are no
            -- `files` rows to hang these hashes off. What this feeds is the
            -- attachment SYNC diff, which is by content hash: without it every
            -- watcher-driven reconcile re-reads every byte under
            -- `attachments/` to recompute hashes that did not change.
            --
            -- Fully derived from disk — safe to drop, and `rebuild()` does not
            -- touch it either way. `mtime_ns` pairs with `size` as the validity
            -- key (see `attachments.rs HashEntry`).
            CREATE TABLE IF NOT EXISTS attachment_hashes (
                path     TEXT PRIMARY KEY,
                size     INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                sha256   TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    // ---- Attachment hash cache -------------------------------------------

    /// Every cached attachment hash, keyed by vault-relative path.
    ///
    /// Read in one go rather than queried per file: the whole point is to avoid
    /// per-file work, and the table has one row per attachment (hundreds, not
    /// millions). The caller holds it for the duration of ONE walk and hands
    /// back the map to persist, so the index lock is never held while a 500 MB
    /// file is being hashed.
    pub fn attachment_hash_cache(&self) -> AppResult<HashMap<String, HashEntry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, size, mtime_ns, sha256 FROM attachment_hashes")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                HashEntry {
                    size: r.get::<_, i64>(1)? as u64,
                    mtime_ns: r.get::<_, i64>(2)?,
                    sha256: r.get::<_, String>(3)?,
                },
            ))
        })?;
        let mut out = HashMap::new();
        for row in rows {
            let (path, entry) = row?;
            out.insert(path, entry);
        }
        Ok(out)
    }

    /// Replace the cache with exactly what the last walk saw.
    ///
    /// Replace, not merge: the walk's map IS the set of files that exist, so
    /// wiping first is also how a deleted attachment's row is pruned — one
    /// transaction, no separate sweep to forget.
    pub fn save_attachment_hash_cache(
        &self,
        cache: &HashMap<String, HashEntry>,
    ) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM attachment_hashes", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO attachment_hashes (path, size, mtime_ns, sha256)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (path, e) in cache {
                stmt.execute(params![path, e.size as i64, e.mtime_ns, e.sha256])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---- Write path -------------------------------------------------------

    /// Reconcile the index with the `.md` files on disk, re-parsing only what
    /// changed. This runs on vault open; keying each note on its stored `mtime`
    /// lets an unchanged vault reopen without re-reading a single file — and
    /// without the long write transaction a full re-index held, which was the
    /// source of the "database is locked" errors on large vaults. New files are
    /// indexed, changed files (a different mtime) re-indexed in place with the
    /// doc_id preserved, and files gone from disk dropped. Links are only
    /// re-resolved when the note set actually changed.
    ///
    /// `mtime` has one-second granularity, so an *external* edit landing in the
    /// same wall-clock second as the last index could slip past this check — but
    /// live edits are indexed by the file watcher through `index_note`, so this
    /// only governs changes made while the app was closed, where mtimes differ.
    ///
    /// Tier 2 (`files`) is reconciled in the SAME walk, on the same terms: ids
    /// preserved by path, rows for vanished paths dropped. What it deliberately
    /// does NOT do is extract any text — opening a vault must not pay for
    /// parsing every `.docx` in it — so it RETURNS the paths whose text is
    /// stale and the caller hands them to the extraction worker
    /// (`watcher::ExtractQueue`), which does that work off this thread and
    /// outside the index mutex.
    pub fn rebuild(&self, vault: &Path) -> AppResult<Vec<PathBuf>> {
        let started = Instant::now();
        let mut touched = 0usize;
        let tx = self.conn.unchecked_transaction()?;

        // Snapshot what's already indexed: path -> (id, mtime, rowid).
        let mut indexed: HashMap<String, (String, i64, i64)> = HashMap::new();
        {
            let mut stmt = tx.prepare("SELECT path, id, mtime, rowid FROM notes")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    r.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (path, id, mtime, rowid) = row?;
                indexed.insert(path, (id, mtime, rowid));
            }
        }

        // Snapshot indexed folders: path -> (parent_id, name). An unchanged
        // folder then costs a hash lookup instead of a write. `rebuild` used to
        // re-upsert every folder of an untouched vault on every open — 1,458 of
        // them on the vault this was measured against — dirtying that many pages
        // inside the transaction that holds the index mutex, which is the lock
        // every index reader (titles, search, backlinks, the sync manifest)
        // waits on at launch.
        let mut indexed_folders: HashMap<String, (Option<String>, String)> = HashMap::new();
        {
            let mut stmt = tx.prepare("SELECT path, parent_id, name FROM folders")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (path, parent, name) = row?;
                indexed_folders.insert(path, (parent, name));
            }
        }

        // Snapshot the tier-2 rows the same way, so a vault whose binaries did
        // not move costs one hash lookup per file rather than a SELECT.
        let mut indexed_files: HashMap<String, FileState> = HashMap::new();
        {
            let mut stmt =
                tx.prepare("SELECT path, id, size, mtime, text_status FROM files")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    FileState {
                        id: r.get::<_, String>(1)?,
                        size: r.get::<_, Option<i64>>(2)?.unwrap_or(-1),
                        mtime: r.get::<_, Option<i64>>(3)?.unwrap_or(-1),
                        status: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    },
                ))
            })?;
            for row in rows {
                let (path, state) = row?;
                indexed_files.insert(path, state);
            }
        }

        let mut seen_notes: HashSet<String> = HashSet::new();
        let mut seen_files: HashSet<String> = HashSet::new();
        let mut pending_files: Vec<PathBuf> = Vec::new();
        let mut seen_folders: HashSet<String> = HashSet::new();
        // Two flags, not one. Links resolve against note basenames and titles
        // only (see `resolve_links`), so a `folders` row appearing or going
        // cannot change any link's answer — but a single removed folder used to
        // set the one `changed` flag and charge a whole-vault `resolve_links`
        // pass (91,702 rows on the measured vault) to a reopen that changed no
        // note at all. If link resolution ever grows a folder-aware rule, this
        // split is what would have to go with it.
        let mut notes_changed = false;
        let mut folders_changed = false;
        let mut folders_written = 0usize;
        let mut stale = 0usize;

        for entry in WalkDir::new(vault)
            .into_iter()
            .filter_entry(|e| {
                // Skip ignored dirs entirely (don't descend into .context/.git/dotfolders).
                let name = e.file_name().to_string_lossy();
                !(e.depth() > 0 && is_ignored_name(&name))
            })
            .filter_map(|e| e.ok())
        {
            let abs = entry.path();
            if entry.file_type().is_dir() {
                if entry.depth() > 0 {
                    let rel = rel_from_abs(vault, abs)?;
                    // Same derivation `upsert_folder` uses, computed once here
                    // rather than once for `seen_folders` and again inside it.
                    let name = abs
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let parent = rel.rsplit_once('/').map(|(p, _)| p.to_string());
                    let fresh = indexed_folders
                        .get(&rel)
                        .is_some_and(|(p, n)| *p == parent && *n == name);
                    // Unconditional: this set drives the stale-folder delete
                    // below, so a skipped write must still count as seen.
                    seen_folders.insert(rel);
                    if !fresh {
                        self.upsert_folder(&tx, vault, abs)?;
                        folders_written += 1;
                    }
                }
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            // The whole CRDT note family, not just `.md` — a `.txt` that syncs
            // as a note but never reaches the index is a note you cannot search,
            // cannot reach by wikilink and whose title the sidebar has to guess.
            if !is_note_file(&name) {
                let rel = rel_from_abs(vault, abs)?;
                if is_indexable_file(&rel) {
                    let prior = indexed_files.get(&rel);
                    if self.upsert_file(&tx, &rel, abs, prior)? {
                        pending_files.push(abs.to_path_buf());
                    }
                    seen_files.insert(rel);
                }
                continue;
            }
            let rel = rel_from_abs(vault, abs)?;
            let disk_mtime = file_mtime(abs);
            seen_notes.insert(rel.clone());

            match indexed.get(&rel) {
                // Unchanged since the last index — skip the read + parse.
                Some((_, mtime, _)) if *mtime == disk_mtime => {}
                // Changed — re-index in place, preserving the doc_id. A file
                // whose mtime moved but whose bytes did not comes back
                // `Unchanged` from the hash gate, and then it has touched no
                // link answer either.
                Some((id, _, _)) => {
                    if let IndexedNote::Indexed(_) =
                        self.index_one(&tx, vault, abs, Some(id.clone()))?
                    {
                        touched += 1;
                        notes_changed = true;
                    }
                }
                // New file.
                None => {
                    self.index_one(&tx, vault, abs, None)?;
                    touched += 1;
                    notes_changed = true;
                }
            }
        }

        // Drop notes whose files are gone from disk.
        for (path, (id, _, rowid)) in &indexed {
            if !seen_notes.contains(path) {
                Self::delete_note_rows(&tx, id, *rowid)?;
                notes_changed = true;
                stale += 1;
            }
        }

        // Drop file rows whose files are gone. Their `file_text` stays for now:
        // a rename arrives here as "gone + new", and the new path is about to
        // claim that text back by sha. `prune_file_text` sweeps what is still
        // unreferenced once the extraction queue has drained.
        for (path, state) in &indexed_files {
            if !seen_files.contains(path) {
                Self::delete_file_rows(&tx, &state.id)?;
                stale += 1;
            }
        }

        // Drop folders that no longer exist.
        let stale_folders: Vec<String> = {
            let mut stmt = tx.prepare("SELECT path FROM folders")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok())
                .filter(|path| !seen_folders.contains(path))
                .collect()
        };
        for path in stale_folders {
            tx.execute("DELETE FROM folders WHERE path = ?1", params![path])?;
            folders_changed = true;
            stale += 1;
        }

        // Link targets only need re-resolving when the NOTE set changed. Full
        // scope: `rebuild` has just rewritten every note, so there is no smaller
        // set to narrow to. `folders_changed` deliberately does not qualify.
        if notes_changed {
            self.resolve_links(&tx, LinkScope::All)?;
        }
        tx.commit()?;
        // Unconditional, unlike `log_batch`, which stays silent below
        // `BATCH_LOG_MIN` — a clean reopen (0 touched notes) is exactly the case
        // worth seeing, because it is what every launch pays. One line per open.
        log::info!(
            "[index] rebuild: {touched} notes, {} files to extract, {folders_written} folder writes, {stale} stale{}, {} ms",
            pending_files.len(),
            if folders_changed { " (folders)" } else { "" },
            started.elapsed().as_millis()
        );
        Ok(pending_files)
    }

    /// (Re)index a BATCH of notes: ONE transaction, ONE link-resolution pass.
    ///
    /// Why this exists. `resolve_links` reads every row of `notes` and every
    /// row of `links` and then rewrites every link row. Running it once *per
    /// file* — which is what `index_note` did, and the watcher called it once per
    /// dirty path — makes indexing N files O(N × links_in_vault), each pass in
    /// its own transaction. Dropping 1000 notes into a vault meant 1000
    /// whole-vault link passes and 1000 commits. `rebuild` has always had the
    /// right shape (one tx, `index_one` per file, one link pass if anything
    /// changed); this is that shape for an incremental batch.
    ///
    /// Per-path failures are RETURNED, not propagated: one unreadable file in a
    /// 1000-file drop must not cost the other 999 their index rows. A file whose
    /// read fails has written nothing to the transaction yet (`index_one` reads
    /// and parses before it touches SQL), so skipping it leaves no partial row.
    ///
    /// Paths whose bytes are already indexed come back in
    /// [`IndexOutcome::unchanged`]: they wrote nothing and are excluded from the
    /// link pass (see `index_one`'s hash gate). The caller passes that on to the
    /// UI so it can skip its own work.
    pub fn index_notes(&self, vault: &Path, abs_paths: &[PathBuf]) -> AppResult<IndexOutcome> {
        if abs_paths.is_empty() {
            return Ok(IndexOutcome::default());
        }
        let started = Instant::now();
        let tx = self.conn.unchecked_transaction()?;
        let mut out = IndexOutcome::default();
        let mut touched: Vec<String> = Vec::with_capacity(abs_paths.len());
        for abs in abs_paths {
            let outcome = rel_from_abs(vault, abs)
                .and_then(|rel| self.id_for_path(&tx, &rel))
                .and_then(|reuse_id| self.index_one(&tx, vault, abs, reuse_id));
            match outcome {
                Ok(IndexedNote::Indexed(id)) => touched.push(id),
                // Nothing was rewritten, so no link answer can have changed:
                // keeping it out of `touched` is what makes a batch of untouched
                // files cost no link pass at all.
                Ok(IndexedNote::Unchanged) => out.unchanged.push(abs.clone()),
                Err(e) => out.failures.push((abs.clone(), e)),
            }
        }
        // The single pass the whole batch shares, narrowed to the notes it wrote.
        if !touched.is_empty() {
            self.resolve_links(&tx, LinkScope::Touched(&touched))?;
        }
        tx.commit()?;
        log_batch("index_notes", abs_paths.len(), out.unchanged.len(), started);
        Ok(out)
    }

    /// Incrementally (re)index a single note by absolute path — a one-element
    /// [`Index::index_notes`], so the two paths can never drift.
    pub fn index_note(&self, vault: &Path, abs: &Path) -> AppResult<()> {
        let mut out = self.index_notes(vault, &[abs.to_path_buf()])?;
        match out.failures.pop() {
            Some((_, e)) => Err(e),
            None => Ok(()),
        }
    }

    /// Remove a BATCH of notes/folders: ONE transaction, ONE link pass — the
    /// removal twin of [`Index::index_notes`] (same quadratic problem: a folder
    /// delete arrives as many watcher paths at once).
    pub fn remove_notes(
        &self,
        vault: &Path,
        abs_paths: &[PathBuf],
    ) -> AppResult<Vec<(PathBuf, AppError)>> {
        if abs_paths.is_empty() {
            return Ok(Vec::new());
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut failures: Vec<(PathBuf, AppError)> = Vec::new();
        let mut gone: Vec<String> = Vec::new();
        for abs in abs_paths {
            match self.remove_one(&tx, vault, abs) {
                Ok(mut ids) => gone.append(&mut ids),
                Err(e) => failures.push((abs.clone(), e)),
            }
        }
        if !gone.is_empty() {
            self.resolve_links(&tx, LinkScope::Touched(&gone))?;
        }
        tx.commit()?;
        Ok(failures)
    }

    /// Remove a note by absolute path, OR every note under a deleted folder
    /// (prefix match). Idempotent. One-element [`Index::remove_notes`].
    pub fn remove_note(&self, vault: &Path, abs: &Path) -> AppResult<()> {
        let mut failures = self.remove_notes(vault, &[abs.to_path_buf()])?;
        match failures.pop() {
            Some((_, e)) => Err(e),
            None => Ok(()),
        }
    }

    /// The row-level removal, inside a caller-owned transaction and WITHOUT a
    /// link pass (the batch does that once at the end).
    /// Returns the ids it deleted, so the batch can scope `resolve_links`: links
    /// that pointed AT a removed note must go back to dangling.
    fn remove_one(&self, tx: &Connection, vault: &Path, abs: &Path) -> AppResult<Vec<String>> {
        let rel = rel_from_abs(vault, abs)?;
        let mut gone: Vec<String> = Vec::new();

        // Exact-path note (a file delete).
        if let Some((id, rowid)) = self.row_for_path(tx, &rel)? {
            Self::delete_note_rows(tx, &id, rowid)?;
            gone.push(id);
        }

        // Any notes under a deleted folder (prefix delete).
        let prefix = format!("{rel}/");
        let victims: Vec<(String, i64)> = {
            let mut stmt = tx.prepare("SELECT id, rowid FROM notes WHERE path LIKE ?1 || '%'")?;
            let rows = stmt.query_map(params![prefix], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, rowid) in victims {
            Self::delete_note_rows(tx, &id, rowid)?;
            gone.push(id);
        }
        tx.execute(
            "DELETE FROM folders WHERE id = ?1 OR path LIKE ?2 || '%'",
            params![rel, prefix],
        )?;
        Ok(gone)
    }

    fn delete_note_rows(tx: &Connection, id: &str, rowid: i64) -> AppResult<()> {
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
        tx.execute("DELETE FROM links WHERE src_note_id = ?1", params![id])?;
        tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- Tier 2: files (binaries) ----------------------------------------
    //
    // Everything here is the CHEAP half — identity, size, mtime, the name FTS
    // row — and runs under the index mutex like the note path. The expensive
    // half (hashing and parsing a container) never does: it happens on the
    // extraction worker thread, which comes back through `store_file_text` for
    // one short write. See `watcher::ExtractQueue`.

    /// Write the cheap half of a `files` row and say whether its TEXT is stale.
    ///
    /// Returns `true` when the caller must queue an extraction: the file is new,
    /// its size/mtime moved, or a previous pass left it `pending`. A row whose
    /// bytes did not move is left alone even when its status is `error` or
    /// `unsupported` — retrying a file that has already refused to parse, on
    /// every watcher event, is exactly the storm the note-side hash gate exists
    /// to prevent.
    ///
    /// Marking a changed row `pending` also clears `text_sha` and the FTS body:
    /// the text we hold describes bytes that are gone, and leaving it referenced
    /// would both answer searches wrongly and pin a `file_text` row forever.
    fn upsert_file(
        &self,
        tx: &Connection,
        rel: &str,
        abs: &Path,
        prior: Option<&FileState>,
    ) -> AppResult<bool> {
        let size = std::fs::metadata(abs).map(|m| m.len() as i64).unwrap_or(-1);
        let mtime = file_mtime(abs);
        if let Some(p) = prior {
            if p.size == size && p.mtime == mtime && p.status != "pending" {
                return Ok(false);
            }
        }
        let name = abs
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let ext = ext_of(rel);
        let id = prior
            .map(|p| p.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute(
            "INSERT INTO files (id, path, ext, kind, size, mtime, sha256, text_sha, text_status, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'pending', NULL)
             ON CONFLICT(id) DO UPDATE SET
                path=excluded.path, ext=excluded.ext, kind=excluded.kind,
                size=excluded.size, mtime=excluded.mtime,
                sha256=NULL, text_sha=NULL, text_status='pending', indexed_at=NULL",
            params![id, rel, ext, kind_for(ext.as_deref().unwrap_or("")), size, mtime],
        )?;
        let rowid: i64 =
            tx.query_row("SELECT rowid FROM files WHERE id = ?1", params![id], |r| {
                r.get(0)
            })?;
        // The name goes in NOW, before any extraction: a 500 MB video dropped
        // into the vault is findable by what it is called the moment the
        // watcher sees it, and stays findable if its text never arrives.
        tx.execute("DELETE FROM files_fts WHERE rowid = ?1", params![rowid])?;
        tx.execute(
            "INSERT INTO files_fts (rowid, name, body) VALUES (?1, ?2, '')",
            params![rowid, name],
        )?;
        Ok(true)
    }

    fn delete_file_rows(tx: &Connection, id: &str) -> AppResult<()> {
        let rowid: Option<i64> = tx
            .query_row("SELECT rowid FROM files WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(rowid) = rowid {
            tx.execute("DELETE FROM files_fts WHERE rowid = ?1", params![rowid])?;
        }
        tx.execute("DELETE FROM files WHERE id = ?1", params![id])?;
        Ok(())
    }

    fn file_state(&self, tx: &Connection, rel: &str) -> AppResult<Option<FileState>> {
        Ok(tx
            .query_row(
                "SELECT id, size, mtime, text_status FROM files WHERE path = ?1",
                params![rel],
                |r| {
                    Ok(FileState {
                        id: r.get::<_, String>(0)?,
                        size: r.get::<_, Option<i64>>(1)?.unwrap_or(-1),
                        mtime: r.get::<_, Option<i64>>(2)?.unwrap_or(-1),
                        status: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    })
                },
            )
            .optional()?)
    }

    /// (Re)register a BATCH of tree binaries — the tier-2 twin of
    /// [`Index::index_notes`], and like it, ONE transaction for the batch.
    ///
    /// Returns the paths whose text must be extracted. Nothing is read or
    /// parsed here; see the section comment above.
    pub fn index_files(&self, vault: &Path, abs_paths: &[PathBuf]) -> AppResult<Vec<PathBuf>> {
        if abs_paths.is_empty() {
            return Ok(Vec::new());
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut pending: Vec<PathBuf> = Vec::new();
        for abs in abs_paths {
            let Ok(rel) = rel_from_abs(vault, abs) else {
                continue;
            };
            if !is_indexable_file(&rel) {
                continue;
            }
            let prior = self.file_state(&tx, &rel)?;
            // One bad file must not cost the rest of the batch its rows — same
            // rule as `index_notes`, and the only failure here is a stat.
            match self.upsert_file(&tx, &rel, abs, prior.as_ref()) {
                Ok(true) => pending.push(abs.clone()),
                Ok(false) => {}
                Err(e) => eprintln!("[index] file row failed for {rel}: {e}"),
            }
        }
        tx.commit()?;
        Ok(pending)
    }

    /// Drop file rows for a BATCH of paths — an exact path and, because a
    /// vanished path may have been a folder, everything beneath it.
    pub fn remove_files(&self, vault: &Path, abs_paths: &[PathBuf]) -> AppResult<()> {
        if abs_paths.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for abs in abs_paths {
            let Ok(rel) = rel_from_abs(vault, abs) else {
                continue;
            };
            let prefix = format!("{rel}/");
            let victims: Vec<String> = {
                let mut stmt =
                    tx.prepare("SELECT id FROM files WHERE path = ?1 OR path LIKE ?2 || '%'")?;
                let rows = stmt.query_map(params![rel, prefix], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for id in victims {
                Self::delete_file_rows(&tx, &id)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The cached text for a content hash, if we have already extracted these
    /// exact bytes — a rename, a copy, or the same attachment in two vault
    /// folders. This is what makes `renamed_file_reuses_cached_text` free.
    pub fn cached_file_text(&self, sha256: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT body FROM file_text WHERE sha256 = ?1",
                params![sha256],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Record one extraction: the FTS body, the row's status, and (when the text
    /// was derived from the file's CONTENT) the `file_text` cache entry.
    ///
    /// `cache` is false for the name-only kinds, whose "text" is a function of
    /// the file NAME: caching that by content hash would hand a copy saved under
    /// a different name the wrong answer.
    ///
    /// Returns false when the row is gone (the file was deleted, or the vault
    /// switched, while the worker was parsing) — the write is then dropped
    /// rather than resurrecting a row nothing points at.
    pub fn store_file_text(
        &self,
        rel: &str,
        sha256: &str,
        text: &str,
        status: &str,
        cache: bool,
    ) -> AppResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let row: Option<(String, i64, String)> = tx
            .query_row(
                "SELECT id, rowid, path FROM files WHERE path = ?1",
                params![rel],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((id, rowid, _)) = row else {
            return Ok(false);
        };
        let chars = text.chars().count() as i64;
        if cache {
            tx.execute(
                "INSERT INTO file_text (sha256, chars, body, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(sha256) DO UPDATE SET chars=excluded.chars, body=excluded.body",
                params![sha256, chars, text, now_ms()],
            )?;
        }
        tx.execute(
            "UPDATE files SET sha256 = ?1, text_sha = ?2, text_status = ?3, indexed_at = ?4
             WHERE id = ?5",
            params![
                sha256,
                if cache { Some(sha256) } else { None },
                status,
                now_ms(),
                id
            ],
        )?;
        let name: String = rel.rsplit('/').next().unwrap_or(rel).to_string();
        tx.execute("DELETE FROM files_fts WHERE rowid = ?1", params![rowid])?;
        tx.execute(
            "INSERT INTO files_fts (rowid, name, body) VALUES (?1, ?2, ?3)",
            params![rowid, name, text],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Drop cached text no `files` row claims any more. Called when the
    /// extraction queue drains, NOT from `rebuild`: a rename reaches rebuild as
    /// "old path gone, new path pending", and sweeping there would delete the
    /// text the new path is seconds away from claiming.
    pub fn prune_file_text(&self) -> AppResult<usize> {
        Ok(self.conn.execute(
            "DELETE FROM file_text
              WHERE sha256 NOT IN (SELECT text_sha FROM files WHERE text_sha IS NOT NULL)",
            [],
        )?)
    }

    /// The extracted text for one vault-relative path. The sync layer's hook:
    /// the server half of PR3 uploads this as `blob_text` rather than
    /// re-extracting in Node (see `get_file_text` in `commands.rs`).
    pub fn file_text(&self, rel: &str) -> AppResult<Option<FileText>> {
        Ok(self
            .conn
            .query_row(
                "SELECT f.sha256, f.text_status, COALESCE(t.chars, 0), COALESCE(t.body, '')
                   FROM files f
                   LEFT JOIN file_text t ON t.sha256 = f.text_sha
                  WHERE f.path = ?1",
                params![rel],
                |r| {
                    Ok(FileText {
                        path: rel.to_string(),
                        sha256: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        status: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        chars: r.get(2)?,
                        text: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Every `files` row, path order. Tests and the Health census.
    pub fn file_rows(&self) -> AppResult<Vec<FileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, ext, kind, COALESCE(size, 0), COALESCE(text_status, '')
               FROM files ORDER BY path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FileRow {
                id: r.get(0)?,
                path: r.get(1)?,
                ext: r.get(2)?,
                kind: r.get(3)?,
                size: r.get(4)?,
                text_status: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// What tier 2 costs inside `index.sqlite`: how many files carry a row, and
    /// the bytes of text behind them (the `file_text` bodies plus what
    /// `files_fts` stores verbatim). Feeds Vault Settings → Health, whose Index
    /// tile otherwise reports a number that grew for no visible reason.
    pub fn file_text_footprint(&self) -> AppResult<FileTextFootprint> {
        let files: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
        // `length(CAST(x AS BLOB))` is bytes, where bare `length()` would be
        // characters — a 500k-char body of CJK is 1.5 MB, not 500 KB.
        let cached: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM file_text",
            [],
            |r| r.get(0),
        )?;
        let fts: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(body AS BLOB))), 0)
               FROM files_fts",
            [],
            |r| r.get(0),
        )?;
        Ok(FileTextFootprint {
            files,
            bytes: cached + fts,
        })
    }

    /// Update paths by `doc_id` on a rename/move — for a single file OR a whole
    /// folder subtree (prefix rewrite). Inbound links, keyed by `dst_note_id`,
    /// are untouched, so a *move* never breaks a link.
    pub fn rename_note(&self, vault: &Path, old_abs: &Path, new_abs: &Path) -> AppResult<()> {
        let old_rel = rel_from_abs(vault, old_abs)?;
        let new_rel = rel_from_abs(vault, new_abs)?;
        let tx = self.conn.unchecked_transaction()?;

        // Exact file rename/move (preserves doc_id).
        if let Some(id) = self.id_for_path(&tx, &old_rel)? {
            tx.execute(
                "UPDATE notes SET path = ?1 WHERE id = ?2",
                params![new_rel, id],
            )?;
        }

        // Folder move: rewrite the path prefix of every descendant note, keeping
        // each note's doc_id stable.
        let old_prefix = format!("{old_rel}/");
        let children: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, path FROM notes WHERE path LIKE ?1 || '%'")?;
            let rows = stmt.query_map(params![old_prefix], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, path) in children {
            let suffix = &path[old_prefix.len()..];
            let new_path = format!("{new_rel}/{suffix}");
            tx.execute(
                "UPDATE notes SET path = ?1 WHERE id = ?2",
                params![new_path, id],
            )?;
        }

        // Re-resolve links (a file rename can change the basename used to
        // resolve). Full scope: a FOLDER move rewrites a whole subtree's paths,
        // and the ids are gathered above only for the descendants, so narrowing
        // here would be easy to get subtly wrong for a rename that changes a
        // basename other notes link to.
        self.resolve_links(&tx, LinkScope::All)?;
        tx.commit()?;
        Ok(())
    }

    /// Re-key the note row at `rel` to `doc_id`, keeping its content.
    ///
    /// The counterpart to [`Self::rename_note`] for a rename this app did NOT
    /// perform. When a file is renamed from outside (Finder, a script, an AI),
    /// the watcher sees an unrelated `removed` + `modified` pair: the old row is
    /// dropped and the new file is indexed under a FRESH `Uuid::new_v4()`
    /// (`index_notes` reuses an id only via `id_for_path`). The sync layer pairs
    /// the two halves by content hash and repairs the server mapping — this is
    /// the local half, without which the same file carries one doc_id in
    /// `.context/config.json` and another in the index, and the next thing to
    /// read the index re-registers it as a second note.
    ///
    /// Returns false when there is no row at `rel`, or when `doc_id` is already
    /// taken by a DIFFERENT path — never merging two rows, because that would
    /// silently drop one note's index entry.
    pub fn rebind_note_id(&self, rel: &str, doc_id: &str) -> AppResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let Some(current) = self.id_for_path(&tx, rel)? else {
            return Ok(false);
        };
        if current == doc_id {
            return Ok(true); // already correct (a re-run, or we indexed it ourselves)
        }
        let taken: Option<String> = tx
            .query_row(
                "SELECT path FROM notes WHERE id = ?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Ok(false);
        }
        tx.execute(
            "UPDATE notes SET id = ?1 WHERE id = ?2",
            params![doc_id, current],
        )?;
        tx.execute(
            "UPDATE note_tags SET note_id = ?1 WHERE note_id = ?2",
            params![doc_id, current],
        )?;
        tx.execute(
            "UPDATE links SET src_note_id = ?1 WHERE src_note_id = ?2",
            params![doc_id, current],
        )?;
        // Inbound links point at the OLD id in `dst_note_id`; the pass recomputes
        // every one of them from `dst_path_raw`, which is what keeps backlinks
        // pointing at this note across the rebind.
        self.resolve_links(&tx, LinkScope::All)?;
        tx.commit()?;
        Ok(true)
    }

    /// The note row for a file over [`MAX_INDEX_BYTES`]: identity, title and
    /// mtime, with an EMPTY FTS body and no links or tags. Any body/link/tag rows
    /// a smaller earlier version left behind are cleared, so a note growing past
    /// the cap cannot strand millions of link rows in the table.
    fn index_oversized(
        &self,
        tx: &Connection,
        rel: &str,
        stem: &str,
        mtime: i64,
        reuse_id: Option<String>,
    ) -> AppResult<IndexedNote> {
        let id = reuse_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute(
            "INSERT INTO notes (id, path, title, mtime, sha256, frontmatter)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
                path=excluded.path, title=excluded.title, mtime=excluded.mtime,
                sha256=excluded.sha256, frontmatter=excluded.frontmatter",
            params![id, rel, stem, mtime],
        )?;
        let rowid: i64 =
            tx.query_row("SELECT rowid FROM notes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })?;
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])?;
        tx.execute(
            "INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, '')",
            params![rowid, stem],
        )?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
        tx.execute("DELETE FROM links WHERE src_note_id = ?1", params![id])?;
        // Deliberately never `Unchanged`: the oversized path has no sha to gate
        // on (it stores NULL), so it keeps rewriting its cheap title-only rows.
        Ok(IndexedNote::Indexed(id))
    }

    /// Returns the note id it wrote and whether it wrote anything, so a batch can
    /// tell `resolve_links` exactly which notes it touched (see `LinkScope`) and
    /// the UI which paths it can ignore.
    ///
    /// ## The hash gate
    ///
    /// A path whose bytes already hash to the `sha256` stored for it is
    /// UNCHANGED: the parse, the `notes`/`notes_fts`/`note_tags`/`links` rewrite
    /// and the link pass are all skipped, and the file costs exactly one read and
    /// one sha256. `rebuild` has always had a cheaper version of this (it skips
    /// by mtime, without even reading); the incremental path was the odd one out,
    /// so any source of spurious watcher events wrote the whole index again per
    /// event — ~32 MB/s into `.context/index.sqlite` on an idle vault (#155,
    /// Linux inotify read events). That source is fixed at the watcher; this is
    /// the defence in depth, because a backup/git/cloud-sync tool rewriting
    /// identical bytes, or a platform that reports an attribute change as a
    /// modification, produces the same storm.
    ///
    /// Three things deliberately do NOT qualify as unchanged:
    /// - a row whose `path` differs from this file's (`reuse_id` comes from
    ///   `id_for_path`, so this only bites if a row moved mid-transaction);
    /// - a row with `sha256 IS NULL` (an oversized note, or a pre-hash row) —
    ///   there is nothing to compare, so re-index;
    /// - a new file with no row at all (`reuse_id` is `None`), even when some
    ///   OTHER note has the same bytes: identity is per path here, and a copy
    ///   needs its own row.
    ///
    /// Only `mtime` is refreshed when it drifted, as a single-column UPDATE, so
    /// the next `rebuild`'s mtime skip still fires instead of re-reading the file.
    fn index_one(
        &self,
        tx: &Connection,
        vault: &Path,
        abs: &Path,
        reuse_id: Option<String>,
    ) -> AppResult<IndexedNote> {
        let rel = rel_from_abs(vault, abs)?;
        let stem = abs
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled");
        let mtime = file_mtime(abs);

        // Oversized notes are LISTED but not parsed. A note has no business being
        // this big, and when one gets there anyway (the 2026-09-04 doubling bug
        // took a daily note to 68 MB) parsing it is what turns one bad file into a
        // vault-wide outage: `parse_note` found ~86,370 wikilinks in it, `links`
        // reached 2,025,307 rows for 37,138 distinct targets, the FTS content
        // table took 503 MB, and index.sqlite hit 1.27 GB. Every index pass then
        // ran for tens of seconds holding the index mutex, which is the lock the
        // UI waits on.
        //
        // Skipping the parse (not the note row) keeps the file visible in the
        // sidebar and searchable by title, so the user can find and fix it, while
        // costing the index nothing. Matches the sync layer's `MAX_NOTE_BYTES`, so
        // a note too big to upload is also a note too big to fully index.
        let size = std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        if size > MAX_INDEX_BYTES {
            log::info!(
                "[index] {} is {:.1} MB (> {} MB cap): indexing title only, skipping body + links",
                rel,
                size as f64 / (1024.0 * 1024.0),
                MAX_INDEX_BYTES / (1024 * 1024)
            );
            return self.index_oversized(tx, &rel, stem, mtime, reuse_id);
        }

        let content = std::fs::read_to_string(abs)?;
        let sha = sha256_hex(&content);

        // The hash gate (see the doc comment). Before the parse, so an unchanged
        // file costs the read and the hash and nothing more.
        if let Some(id) = reuse_id.as_deref() {
            if let Some((row_path, row_sha, row_mtime)) = self.row_state(tx, id)? {
                if row_path == rel && row_sha.as_deref() == Some(sha.as_str()) {
                    if row_mtime != mtime {
                        tx.execute(
                            "UPDATE notes SET mtime = ?1 WHERE id = ?2",
                            params![mtime, id],
                        )?;
                    }
                    return Ok(IndexedNote::Unchanged);
                }
            }
        }

        let parsed = parse_for(abs, &content, stem);

        let id = reuse_id.unwrap_or_else(|| Uuid::new_v4().to_string());

        // Upsert the note row (by id — path is UNIQUE and may already differ).
        tx.execute(
            "INSERT INTO notes (id, path, title, mtime, sha256, frontmatter)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                path=excluded.path, title=excluded.title, mtime=excluded.mtime,
                sha256=excluded.sha256, frontmatter=excluded.frontmatter",
            params![id, rel, parsed.title, mtime, sha, parsed.frontmatter_json],
        )?;

        let rowid: i64 =
            tx.query_row("SELECT rowid FROM notes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })?;

        // FTS: replace the row (contentless_delete lets us DELETE by rowid).
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])?;
        tx.execute(
            "INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
            params![rowid, parsed.title, parsed.body],
        )?;

        // Tags.
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
        for tag in &parsed.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
                params![tag],
            )?;
            let tag_id: i64 =
                tx.query_row("SELECT id FROM tags WHERE name = ?1", params![tag], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
                params![id, tag_id],
            )?;
        }

        // Links (dst resolved later in resolve_links).
        tx.execute("DELETE FROM links WHERE src_note_id = ?1", params![id])?;
        for link in &parsed.links {
            tx.execute(
                "INSERT INTO links (src_note_id, dst_note_id, dst_path_raw, link_text, position)
                 VALUES (?1, NULL, ?2, ?3, ?4)",
                params![id, link.target, link.raw, link.position],
            )?;
        }

        Ok(IndexedNote::Indexed(id))
    }

    /// The `(path, sha256, mtime)` the index currently holds for a doc_id — the
    /// three columns the hash gate compares against the file on disk.
    fn row_state(
        &self,
        tx: &Connection,
        id: &str,
    ) -> AppResult<Option<(String, Option<String>, i64)>> {
        Ok(tx
            .query_row(
                "SELECT path, sha256, mtime FROM notes WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?)
    }

    fn upsert_folder(&self, tx: &Connection, vault: &Path, abs: &Path) -> AppResult<()> {
        let rel = rel_from_abs(vault, abs)?;
        if rel.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        self.folder_writes.set(self.folder_writes.get() + 1);
        let name = abs
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let parent = rel.rsplit_once('/').map(|(p, _)| p.to_string());
        tx.execute(
            "INSERT INTO folders (id, parent_id, name, path) VALUES (?1, ?2, ?3, ?1)
             ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name",
            params![rel, parent, name],
        )?;
        Ok(())
    }

    /// Recompute `dst_note_id` for links by matching the raw target against note
    /// basenames (case-insensitive), then titles.
    ///
    /// ## Why this is scoped
    ///
    /// This used to be `resolve_all_links`: one pass over EVERY row of `links`,
    /// per batch. That is O(all links in the vault) work for a change to a
    /// handful of notes, and it is charged while the watcher's drain thread holds
    /// the index mutex — the lock every UI command waits on. Measured on a vault
    /// with a forked note that had ballooned to 68 MB (2,025,307 link rows for
    /// 37,138 distinct targets): `index_notes: 176 files in 27128 ms`. Opening a
    /// note, the sidebar's titles and its backlinks all queue behind that, which
    /// is what "the sidebar blinks and clicks are slow while it syncs" was.
    ///
    /// ## Why `Touched` is sufficient
    ///
    /// A link's answer is a pure function of (its raw target, the set of note
    /// basenames/titles). So it can only change when:
    ///  - its OWN row was just rewritten — `src_note_id` is in the batch
    ///    (`index_one` deletes and re-inserts a note's links); or
    ///  - the note it points AT changed path or title, or is gone —
    ///    `dst_note_id` is in the batch; or
    ///  - it was dangling and a matching note has now appeared —
    ///    `dst_note_id IS NULL`.
    ///
    /// The one case deliberately NOT re-examined: a new note whose basename
    /// duplicates an existing note's does not steal links already resolved to
    /// the older one. That matches the old behaviour, which broke such ties by
    /// `HashMap::or_insert` over an unordered `SELECT` — i.e. arbitrarily. Making
    /// it "first writer keeps it" is no less correct and is stable.
    fn resolve_links(&self, tx: &Connection, scope: LinkScope<'_>) -> AppResult<()> {
        #[cfg(test)]
        self.resolve_calls.set(self.resolve_calls.get() + 1);
        // Build lookup maps from all notes.
        let mut by_basename: HashMap<String, String> = HashMap::new();
        let mut by_title: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = tx.prepare("SELECT id, path, title FROM notes")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            for row in rows {
                let (id, path, title) = row?;
                let base = path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .trim_end_matches(".md")
                    .to_lowercase();
                by_basename.entry(base).or_insert_with(|| id.clone());
                if let Some(t) = title {
                    by_title.entry(t.to_lowercase()).or_insert(id);
                }
            }
        }

        // The candidate links. `All` reads the table; `Touched` narrows it to the
        // three cases that can have changed (see the doc comment) via a temp
        // table, so the id list is not spliced into SQL and is not capped by
        // SQLITE_MAX_VARIABLE_NUMBER.
        let links: Vec<(i64, String)> = match scope {
            LinkScope::All => {
                let mut stmt = tx.prepare("SELECT id, dst_path_raw FROM links")?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
            LinkScope::Touched(ids) => {
                tx.execute_batch(
                    "CREATE TEMP TABLE IF NOT EXISTS touched_notes (id TEXT PRIMARY KEY);
                     DELETE FROM touched_notes;",
                )?;
                {
                    let mut ins =
                        tx.prepare("INSERT OR IGNORE INTO touched_notes (id) VALUES (?1)")?;
                    for id in ids {
                        ins.execute(params![id])?;
                    }
                }
                // Both `idx_links_src` and `idx_links_dst` serve these, and the
                // NULL arm is an index range scan rather than a table scan.
                let mut stmt = tx.prepare(
                    "SELECT id, dst_path_raw FROM links
                      WHERE dst_note_id IS NULL
                         OR src_note_id IN (SELECT id FROM touched_notes)
                         OR dst_note_id IN (SELECT id FROM touched_notes)",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
        };

        // Hoisted out of the loop: `Connection::execute` re-prepares (and
        // re-parses) the statement on every call, which on a link-dense vault is
        // tens of thousands of needless prepares per pass.
        //
        // `IS NOT ?1` makes the write conditional, and that is the expensive half.
        // A link's resolution almost never changes — re-indexing a note re-derives
        // the same target — but this rewrote EVERY row of `links` on EVERY pass,
        // dirtying a WAL page each time. That fixed cost is what a batch actually
        // pays for: a 357-file watcher batch on a ~5k-note vault took 10.6s, and
        // it is paid while `process_batch` holds the index mutex, which is the
        // lock every UI command queues behind — the "clicks are slow during sync"
        // report. `IS NOT` (not `<>`) because `dst_note_id` is nullable and an
        // unresolved link must compare equal to an unresolved link.
        let mut update =
            tx.prepare("UPDATE links SET dst_note_id = ?1 WHERE id = ?2 AND dst_note_id IS NOT ?1")?;
        for (link_id, raw) in links {
            // raw may contain alias/heading — strip for matching.
            let target = raw
                .split('|')
                .next()
                .unwrap_or("")
                .split('#')
                .next()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let base = target
                .rsplit('/')
                .next()
                .unwrap_or(&target)
                .trim_end_matches(".md")
                .to_string();
            let dst = by_basename.get(&base).or_else(|| by_title.get(&target));
            update.execute(params![dst, link_id])?;
        }
        Ok(())
    }

    fn id_for_path(&self, tx: &Connection, rel: &str) -> AppResult<Option<String>> {
        Ok(tx
            .query_row("SELECT id FROM notes WHERE path = ?1", params![rel], |r| {
                r.get::<_, String>(0)
            })
            .optional()?)
    }

    fn row_for_path(&self, tx: &Connection, rel: &str) -> AppResult<Option<(String, i64)>> {
        Ok(tx
            .query_row(
                "SELECT id, rowid FROM notes WHERE path = ?1",
                params![rel],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?)
    }

    // ---- Read path (query commands) --------------------------------------

    /// Search BOTH tiers — notes and the tree binaries — as one ranked list.
    ///
    /// This is what the `search_notes` command calls. The two tables are queried
    /// separately (they are different FTS5 tables with different columns) and
    /// merged by score, which is the only way to rank a `.docx` paragraph
    /// against a note body at all.
    pub fn search_all(&self, query: &str) -> AppResult<Vec<SearchResult>> {
        let match_query = build_fts_query(query);
        if match_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = self.search_notes_ranked(&match_query)?;
        hits.extend(self.search_files_ranked(&match_query)?);
        Ok(merge_ranked(hits, SEARCH_LIMIT))
    }

    /// FTS5 MATCH search over NOTES only, with a highlighted snippet of the
    /// body. Kept as its own entry point because most callers (and every test
    /// that predates tier 2) mean exactly this.
    pub fn search_notes(&self, query: &str) -> AppResult<Vec<SearchResult>> {
        let match_query = build_fts_query(query);
        if match_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = self.search_notes_ranked(&match_query)?;
        hits.sort_by(rank_order);
        hits.truncate(SEARCH_LIMIT);
        Ok(hits.into_iter().map(|h| h.result).collect())
    }

    /// The notes half, scored. `match_query` is already built and escaped.
    ///
    /// Delimit the highlight with control-char sentinels (U+0001/U+0002) that
    /// can't occur in note text, so we can HTML-escape the whole snippet and
    /// then swap the sentinels for real <mark> tags — see html_escape. This
    /// makes the snippet safe to render as HTML (only <mark> survives) even
    /// though the body is raw markdown. Tier 2 goes through the SAME path, and
    /// `extract.rs` strips those two characters out of every extracted body so
    /// text pulled from a binary cannot forge a `<mark>`.
    fn search_notes_ranked(&self, match_query: &str) -> AppResult<Vec<RankedHit>> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.path, n.title,
                    snippet(notes_fts, 1, char(1), char(2), '…', 12) AS snip,
                    bm25(notes_fts) AS score
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
             WHERE notes_fts MATCH ?1
             ORDER BY bm25(notes_fts)
             LIMIT 100",
        )?;
        let rows = stmt.query_map(params![match_query], |r| {
            let path: String = r.get(1)?;
            Ok(RankedHit {
                score: r.get::<_, f64>(4)?,
                result: SearchResult {
                    id: r.get(0)?,
                    ext: ext_of(&path),
                    path,
                    title: r.get(2)?,
                    snippet: mark_snippet(r.get::<_, String>(3)?),
                    kind: "note".to_string(),
                },
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The files half, scored and penalised. The snippet comes from column 1
    /// (`body`), so a hit that matched only the file NAME has an empty one —
    /// which is right: there is nothing to quote but the name the row already
    /// carries.
    fn search_files_ranked(&self, match_query: &str) -> AppResult<Vec<RankedHit>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.path, f.ext,
                    snippet(files_fts, 1, char(1), char(2), '…', 12) AS snip,
                    bm25(files_fts) AS score
             FROM files_fts
             JOIN files f ON f.rowid = files_fts.rowid
             WHERE files_fts MATCH ?1
             ORDER BY bm25(files_fts)
             LIMIT 100",
        )?;
        let rows = stmt.query_map(params![match_query], |r| {
            let path: String = r.get(1)?;
            let title = path
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .rsplit_once('.')
                .map(|(stem, _)| stem.to_string())
                .unwrap_or_else(|| path.clone());
            Ok(RankedHit {
                score: r.get::<_, f64>(4)? + FILE_RANK_PENALTY,
                result: SearchResult {
                    id: r.get(0)?,
                    ext: r.get::<_, Option<String>>(2)?,
                    path,
                    title,
                    snippet: mark_snippet(r.get::<_, String>(3)?),
                    kind: "file".to_string(),
                },
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Notes that link *to* the given note id.
    pub fn get_backlinks(&self, note_id: &str) -> AppResult<Vec<Backlink>> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.path, n.title, l.link_text
             FROM links l
             JOIN notes n ON n.id = l.src_note_id
             WHERE l.dst_note_id = ?1
             ORDER BY n.title",
        )?;
        let rows = stmt.query_map(params![note_id], |r| {
            Ok(Backlink {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                link_text: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every resolved edge of the note graph in one query — the whole-graph
    /// counterpart to `get_backlinks`. Backs the Graph view so it no longer
    /// fans out one IPC call per note (which didn't scale past a few hundred).
    /// `DISTINCT` collapses repeated `[[wikilinks]]` between the same pair.
    pub fn graph_edges(&self) -> AppResult<Vec<GraphEdge>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT src_note_id, dst_note_id
             FROM links
             WHERE dst_note_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphEdge {
                source: r.get(0)?,
                target: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The edges touching any of `note_ids` (as source OR target) — the delta the
    /// Graph view applies when a few notes change, instead of re-reading every
    /// edge in the vault on every `files-changed` (#83). Deduplicated across the
    /// ids so an edge between two changed notes is reported once.
    pub fn graph_edges_for(&self, note_ids: &[String]) -> AppResult<Vec<GraphEdge>> {
        let mut out: Vec<GraphEdge> = Vec::new();
        if note_ids.is_empty() {
            return Ok(out);
        }
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT src_note_id, dst_note_id
             FROM links
             WHERE dst_note_id IS NOT NULL AND (src_note_id = ?1 OR dst_note_id = ?1)",
        )?;
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for id in note_ids {
            let rows = stmt.query_map(params![id], |r| {
                Ok(GraphEdge {
                    source: r.get(0)?,
                    target: r.get(1)?,
                })
            })?;
            for edge in rows {
                let edge = edge?;
                if seen.insert((edge.source.clone(), edge.target.clone())) {
                    out.push(edge);
                }
            }
        }
        Ok(out)
    }

    pub fn get_note_meta(&self, rel: &str) -> AppResult<Option<NoteMeta>> {
        let base = self
            .conn
            .query_row(
                "SELECT id, path, title, mtime, sha256, frontmatter FROM notes WHERE path = ?1",
                params![rel],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;

        let Some((id, path, title, mtime, sha256, frontmatter)) = base else {
            return Ok(None);
        };

        let mut stmt = self.conn.prepare(
            "SELECT t.name FROM tags t
             JOIN note_tags nt ON nt.tag_id = t.id
             WHERE nt.note_id = ?1 ORDER BY t.name",
        )?;
        let tags = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Some(NoteMeta {
            id,
            path,
            title: title.unwrap_or_default(),
            mtime,
            sha256: sha256.unwrap_or_default(),
            frontmatter,
            tags,
        }))
    }

    /// Resolve a wiki-link target to a note: by full relative path, then by
    /// basename (case-insensitive), then by title. Mirrors `resolve_links`.
    pub fn resolve_wikilink(&self, name: &str) -> AppResult<Option<ResolvedLink>> {
        let target = name
            .split('|')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(".md")
            .to_string();
        if target.is_empty() {
            return Ok(None);
        }
        let base = target.rsplit('/').next().unwrap_or(&target).to_string();

        let map = |r: &rusqlite::Row| {
            Ok(ResolvedLink {
                id: r.get(0)?,
                path: r.get(1)?,
            })
        };

        // 1. Full relative path (e.g. "Projects/Baalda").
        let full_md = format!("{target}.md");
        if let Some(hit) = self
            .conn
            .query_row(
                "SELECT id, path FROM notes WHERE lower(path) = lower(?1) LIMIT 1",
                params![full_md],
                map,
            )
            .optional()?
        {
            return Ok(Some(hit));
        }

        // 2. Basename anywhere in the tree.
        let base_md = format!("{base}.md");
        let base_like = format!("%/{base}.md");
        if let Some(hit) = self
            .conn
            .query_row(
                "SELECT id, path FROM notes
                 WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)
                 LIMIT 1",
                params![base_md, base_like],
                map,
            )
            .optional()?
        {
            return Ok(Some(hit));
        }

        // 3. Title.
        if let Some(hit) = self
            .conn
            .query_row(
                "SELECT id, path FROM notes WHERE lower(title) = lower(?1) LIMIT 1",
                params![target],
                map,
            )
            .optional()?
        {
            return Ok(Some(hit));
        }

        // 4. A tree binary, by full path or basename — `[[Q3 report.xlsx]]`
        // should open the spreadsheet rather than dangle. The target keeps its
        // extension here (only a trailing `.md` was trimmed above), because a
        // file's extension is part of what names it.
        //
        // NOTE the `id` this returns is a `files.id`, NOT a note doc_id: the
        // caller opens by PATH (`store.openNoteByPath`, which routes through the
        // format registry to the right viewer) and never treats it as a note.
        // `links`/the graph are untouched — a link to a binary is not an edge in
        // the note graph.
        let base = target.rsplit('/').next().unwrap_or(&target).to_string();
        let base_like = format!("%/{base}");
        Ok(self
            .conn
            .query_row(
                "SELECT id, path FROM files
                  WHERE lower(path) = lower(?1) OR lower(path) = lower(?2)
                     OR lower(path) LIKE lower(?3)
                  ORDER BY length(path) LIMIT 1",
                params![target, base, base_like],
                map,
            )
            .optional()?)
    }

    /// All note titles (for the `[[` autocomplete list).
    pub fn list_note_titles(&self) -> AppResult<Vec<NoteTitle>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, path, title FROM notes ORDER BY title")?;
        let rows = stmt.query_map([], |r| {
            Ok(NoteTitle {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every `#tag` in the vault with the number of notes using it, most-used
    /// first (ties broken by name so the list is stable between calls).
    ///
    /// A LEFT JOIN, not an inner one: `tags` rows outlive the last note that
    /// used them (nothing garbage-collects the name), and a tag at count 0 is
    /// still a tag you typed once and may well mean to type again — it just
    /// sorts last.
    pub fn list_tags(&self, limit: usize) -> AppResult<Vec<TagCount>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.name, COUNT(nt.note_id) AS n
               FROM tags t
               LEFT JOIN note_tags nt ON nt.tag_id = t.id
              GROUP BY t.id, t.name
              ORDER BY n DESC, t.name ASC
              LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(TagCount {
                name: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // ---- Frontmatter property autocomplete --------------------------------
    //
    // Both readers parse `notes.frontmatter` in Rust with serde_json rather than
    // with SQLite's JSON1. `json_each` over a row whose blob is not an object
    // raises, and SQLite gives no ordering guarantee that a `json_type(…) =
    // 'object'` filter runs before it — so the safe SQL is uglier than the
    // parse, and a few thousand short blobs is microseconds either way.

    /// Every frontmatter key in the vault with the number of notes using it,
    /// most-used first (ties broken by name so the list is stable).
    pub fn list_property_keys(&self) -> AppResult<Vec<PropertyKeyCount>> {
        let mut counts: HashMap<String, i64> = HashMap::new();
        for value in self.frontmatter_objects()? {
            if let serde_json::Value::Object(map) = value {
                for key in map.keys() {
                    *counts.entry(key.clone()).or_insert(0) += 1;
                }
            }
        }
        let mut out: Vec<PropertyKeyCount> = counts
            .into_iter()
            .map(|(key, count)| PropertyKeyCount { key, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
        Ok(out)
    }

    /// Distinct scalar values seen for one key, array members flattened. Capped
    /// so a key like `updated` (one value per note) can't return the vault.
    pub fn list_property_values(&self, key: &str, limit: usize) -> AppResult<Vec<String>> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<String> = Vec::new();
        for value in self.frontmatter_objects()? {
            let serde_json::Value::Object(map) = value else {
                continue;
            };
            let Some(found) = map.get(key) else { continue };
            let members: Vec<&serde_json::Value> = match found {
                serde_json::Value::Array(items) => items.iter().collect(),
                other => vec![other],
            };
            for member in members {
                let Some(text) = scalar_to_string(member) else {
                    continue;
                };
                if text.is_empty() || !seen.insert(text.clone()) {
                    continue;
                }
                out.push(text);
                if out.len() >= limit {
                    out.sort();
                    return Ok(out);
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Every note's parsed `frontmatter` blob. Invalid JSON is skipped, not
    /// raised: one note with a broken blob must not empty the whole list.
    fn frontmatter_objects(&self) -> AppResult<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT frontmatter FROM notes WHERE frontmatter IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&row?) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    // ---- Local CRDT persistence (spec 02 §4) ------------------------------
    //
    // The append-only `yjs_updates` log + periodic `yjs_snapshot` per doc,
    // mirroring y-leveldb's "updates + separate state-vector" model. The
    // TS bridge owns the Yjs semantics; Rust is a dumb, durable byte store.

    /// Append one binary Yjs update to a doc's log. Returns the row's `id` —
    /// the COMPACTION WATERMARK the caller hands back to
    /// [`Index::save_yjs_snapshot`].
    ///
    /// `yjs_updates.id` is an `INTEGER PRIMARY KEY`, i.e. the rowid, so
    /// `last_insert_rowid` is exactly the id just written and ids are
    /// monotonic per connection. Returning it is what lets a snapshot delete
    /// only the rows it actually folded in (see `save_yjs_snapshot`).
    pub fn append_yjs_update(&self, doc_id: &str, update: &[u8]) -> AppResult<i64> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO yjs_updates (doc_id, \"update\", created_at) VALUES (?1, ?2, ?3)",
            params![doc_id, update, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Load a doc's persisted CRDT state: the latest snapshot (if any) plus every
    /// update logged since that snapshot, in insertion order.
    pub fn load_yjs_state(&self, doc_id: &str) -> AppResult<YjsState> {
        // Read the column as an Option, then flatten: `.optional()` only covers
        // "no row". A row CAN exist with a NULL snapshot — `save_yjs_state_vectors`
        // creates exactly that shape when it records a state vector for a doc that
        // has never been snapshotted — and a bare `get::<Vec<u8>>` would fail the
        // whole load with "Invalid column type Null", losing the doc's update log.
        let snapshot: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT snapshot FROM yjs_snapshot WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()?
            .flatten();

        // Id AND bytes in ONE statement, so `last_update_id` can only ever name
        // a row that is in `updates`. A separate `SELECT MAX(id)` would be a
        // second read with its own moment in time, and a row appended between
        // the two would be named by a watermark whose snapshot does not contain
        // it — the exact bug the watermark exists to prevent.
        let rows: Vec<(i64, Vec<u8>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, \"update\" FROM yjs_updates WHERE doc_id = ?1 ORDER BY id ASC",
            )?;
            let rows = stmt.query_map(params![doc_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let last_update_id = rows.last().map(|(id, _)| *id);
        let updates: Vec<Vec<u8>> = rows.into_iter().map(|(_, u)| u).collect();

        let update_count = updates.len() as i64;
        Ok(YjsState {
            snapshot,
            updates,
            update_count,
            last_update_id,
        })
    }

    /// Write a doc's merged snapshot + state vector and truncate its update log
    /// **up to a watermark**, atomically in one transaction.
    ///
    /// `up_to` is the last `yjs_updates.id` the snapshot covers — the highest id
    /// [`Index::append_yjs_update`] returned before the caller encoded it.
    /// `None` deletes NOTHING and writes the snapshot only.
    ///
    /// The watermark is the whole point (desktop-audit #4). This used to be a
    /// bare `DELETE FROM yjs_updates WHERE doc_id = ?`, and the bridge's
    /// `compact()` encodes the snapshot synchronously and then *awaits* the IPC
    /// while `onDocUpdate` keeps appending a row per keystroke. Any append that
    /// committed inside that window was deleted by a snapshot that does not
    /// contain it, so on the next load the surviving later updates referenced a
    /// missing item, Yjs parked them as pending forever, and the doc loaded
    /// short. Deleting only `id <= up_to` cannot touch a row the caller never
    /// saw.
    pub fn save_yjs_snapshot(
        &self,
        doc_id: &str,
        snapshot: &[u8],
        state_vector: &[u8],
        up_to: Option<i64>,
    ) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let prior_seq: i64 = tx
            .query_row(
                "SELECT seq FROM yjs_snapshot WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        let seq = prior_seq + 1;
        tx.execute(
            "INSERT INTO yjs_snapshot (doc_id, snapshot, state_vector, seq)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(doc_id) DO UPDATE SET
                snapshot=excluded.snapshot,
                state_vector=excluded.state_vector,
                seq=excluded.seq",
            params![doc_id, snapshot, state_vector, seq],
        )?;
        if let Some(up_to) = up_to {
            tx.execute(
                "DELETE FROM yjs_updates WHERE doc_id = ?1 AND id <= ?2",
                params![doc_id, up_to],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Record just a doc's Yjs **state vector**, without writing a snapshot and
    /// without truncating its update log.
    ///
    /// This is the durable form of the sync engine's `hello` manifest. That
    /// manifest used to be built from an in-memory cache, so it was EMPTY on
    /// every launch and the server re-sent the full state of every readable doc
    /// forever. A state vector is tiny (a clock per contributing client), so
    /// persisting it per doc costs almost nothing next to the snapshot it rides
    /// alongside.
    ///
    /// Upserted into `yjs_snapshot` on purpose: it is the per-doc row that
    /// already owns `state_vector`, and a row created here (snapshot NULL,
    /// seq 0) is exactly what `load_yjs_state` already handles — it reads
    /// `snapshot` as an Option and falls back to the update log.
    ///
    /// Written in ONE transaction: a 500-doc backfill would otherwise be 500
    /// implicit transactions (500 fsyncs) against a WAL database.
    pub fn save_yjs_state_vectors(&self, entries: &[(String, Vec<u8>)]) -> AppResult<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO yjs_snapshot (doc_id, snapshot, state_vector, seq)
                 VALUES (?1, NULL, ?2, 0)
                 ON CONFLICT(doc_id) DO UPDATE SET state_vector=excluded.state_vector",
            )?;
            for (doc_id, sv) in entries {
                stmt.execute(params![doc_id, sv])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Every doc we hold a state vector for, for the sync manifest. Cheap: one
    /// scan of a table with one small row per doc, and no Y.Doc is rebuilt.
    pub fn list_yjs_state_vectors(&self) -> AppResult<Vec<YjsStateVector>> {
        let mut stmt = self.conn.prepare(
            "SELECT doc_id, state_vector FROM yjs_snapshot WHERE state_vector IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(YjsStateVector {
                doc_id: r.get(0)?,
                state_vector: r.get::<_, Vec<u8>>(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // ---- Bulk sync batches (the bootstrap + materialize commands) --------
    //
    // Both of these exist for ONE reason: a cold join used 2-3 IPC round trips
    // and 2-3 SQLite transactions PER NOTE, each carrying its own whole-vault
    // link pass (`rebind_note_id` is `LinkScope::All`). On a 600-note vault that
    // is the join, all of it. These are the batch shape — one transaction, one
    // link pass, N docs — and they are the only place `rebind`'s row work runs
    // without its own pass.

    /// Does this doc already have LOCAL CRDT state?
    ///
    /// The bootstrap's eligibility gate: any `yjs_updates` row or any
    /// `yjs_snapshot` row (even the snapshot-NULL, state-vector-only shape
    /// `save_yjs_state_vectors` writes) means this device holds ops the incoming
    /// page did not produce, so the fast path must refuse it and let the TS side
    /// cold-apply the update through `VaultDocStore`, which MERGES. Writing a
    /// server snapshot over local CRDT would drop whatever this device knew.
    pub fn has_local_crdt(&self, doc_id: &str) -> AppResult<bool> {
        let updates: i64 = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM yjs_updates WHERE doc_id = ?1)",
            params![doc_id],
            |r| r.get(0),
        )?;
        if updates != 0 {
            return Ok(true);
        }
        let snapshot: i64 = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM yjs_snapshot WHERE doc_id = ?1)",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(snapshot != 0)
    }

    /// One doc's row work for a bootstrap page: its file is already on disk
    /// (the caller wrote it), this is the index + CRDT half.
    pub fn commit_bootstrap_rows(
        &self,
        vault: &Path,
        rows: &[BootstrapRow],
    ) -> AppResult<Vec<(String, AppError)>> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let tx = self.conn.unchecked_transaction()?;
        let mut failures: Vec<(String, AppError)> = Vec::new();
        let mut touched: Vec<String> = Vec::with_capacity(rows.len() * 2);
        let mut committed: Vec<&BootstrapRow> = Vec::with_capacity(rows.len());

        for row in rows {
            // Index the file we just wrote, INSIDE this transaction. That is
            // what makes the watcher's echo free rather than needing a
            // suppression set: by the time the 150 ms-debounced drain looks at
            // these paths, `notes.sha256` already equals the bytes on disk, so
            // `index_one`'s hash gate returns `IndexedNote::Unchanged`,
            // `index_notes` reports them in `IndexOutcome::unchanged` and
            // `watcher.rs mark_unchanged` flags each `files-changed` entry
            // `unchanged: true` — which the TS side already drops.
            let indexed = crate::vault::resolve_in_vault(vault, &row.rel_path).and_then(|abs| {
                let reuse = self.id_for_path(&tx, &row.rel_path)?;
                let outcome = self.index_one(&tx, vault, &abs, reuse.clone())?;
                Ok(match outcome {
                    IndexedNote::Indexed(id) => id,
                    // `Unchanged` only happens when `reuse` was Some (the gate
                    // needs a row to compare against), so the id is known.
                    IndexedNote::Unchanged => reuse.unwrap_or_default(),
                })
            });
            let local_id = match indexed {
                Ok(id) if !id.is_empty() => id,
                Ok(_) => {
                    failures.push((
                        row.doc_id.clone(),
                        AppError::new("could not index the note that was written"),
                    ));
                    continue;
                }
                Err(e) => {
                    failures.push((row.doc_id.clone(), e));
                    continue;
                }
            };
            touched.push(local_id.clone());

            // Re-key the row to the SERVER's doc_id. Identity is the doc_id
            // everywhere (`.context/config.json`, the CRDT tables, the server),
            // so a note indexed under a fresh local uuid would register as a
            // second note on the next pull.
            match self.rebind_in_tx(&tx, &local_id, &row.doc_id, &mut touched) {
                Ok(true) => committed.push(row),
                Ok(false) => failures.push((
                    row.doc_id.clone(),
                    AppError::new("that doc id is already indexed at another path"),
                )),
                Err(e) => failures.push((row.doc_id.clone(), e)),
            }
        }

        // The one pass the whole batch shares.
        if !touched.is_empty() {
            self.resolve_links(&tx, LinkScope::Touched(&touched))?;
        }

        {
            // `seq` starts at 1 here: an eligible doc has NO prior row by
            // definition (`has_local_crdt`), and the conflict arm exists only so
            // a re-run cannot fail the batch.
            let mut stmt = tx.prepare(
                "INSERT INTO yjs_snapshot (doc_id, snapshot, state_vector, seq)
                 VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT(doc_id) DO UPDATE SET
                    snapshot=excluded.snapshot,
                    state_vector=excluded.state_vector,
                    seq=yjs_snapshot.seq + 1",
            )?;
            for row in &committed {
                stmt.execute(params![row.doc_id, row.snapshot, row.state_vector])?;
            }
        }
        for row in &committed {
            set_disk_base_on(&tx, &row.doc_id, &row.content_sha)?;
        }
        tx.commit()?;
        log::info!(
            "[index] bootstrap batch: {} docs, {} failed, {} ms",
            rows.len(),
            failures.len(),
            started.elapsed().as_millis()
        );
        Ok(failures)
    }

    /// Index + rebind a batch of just-materialized placeholder notes: ONE
    /// transaction, ONE link pass. Returns `(rel_path, rebound)` per row, in
    /// input order; a path with no row on disk is reported `false` rather than
    /// failing the batch.
    pub fn commit_materialized(
        &self,
        vault: &Path,
        rows: &[(String, Option<String>)],
    ) -> AppResult<Vec<bool>> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let tx = self.conn.unchecked_transaction()?;
        let mut touched: Vec<String> = Vec::with_capacity(rows.len() * 2);
        let mut out = Vec::with_capacity(rows.len());

        for (rel, doc_id) in rows {
            let indexed = crate::vault::resolve_in_vault(vault, rel).and_then(|abs| {
                let reuse = self.id_for_path(&tx, rel)?;
                let outcome = self.index_one(&tx, vault, &abs, reuse.clone())?;
                Ok(match outcome {
                    IndexedNote::Indexed(id) => Some(id),
                    IndexedNote::Unchanged => reuse,
                })
            });
            let local_id = match indexed {
                Ok(Some(id)) => id,
                Ok(None) => {
                    out.push(false);
                    continue;
                }
                Err(e) => {
                    // Per-path and non-fatal, like `index_notes`: one unreadable
                    // placeholder must not cost the other 599 their rows.
                    log::warn!("[index] materialize: could not index {rel}: {}", e.0);
                    out.push(false);
                    continue;
                }
            };
            touched.push(local_id.clone());
            match doc_id {
                Some(doc_id) => {
                    out.push(self.rebind_in_tx(&tx, &local_id, doc_id, &mut touched)?)
                }
                None => out.push(false),
            }
        }

        if !touched.is_empty() {
            self.resolve_links(&tx, LinkScope::Touched(&touched))?;
        }
        tx.commit()?;
        log::info!(
            "[index] materialize batch: {} notes, {} ms",
            rows.len(),
            started.elapsed().as_millis()
        );
        Ok(out)
    }

    /// [`Index::rebind_note_id`]'s row work, inside a caller-owned transaction
    /// and WITHOUT the link pass — the batch does one at the end.
    ///
    /// The standalone command runs `resolve_links(LinkScope::All)`, a full
    /// `links` scan, once per call; N of those is the single largest cost in a
    /// cold join. Both ids go into `touched` on purpose: the note's OUTBOUND
    /// links move with the new id, and its INBOUND ones still carry the OLD id
    /// in `dst_note_id`, so the pass has to be asked about both or backlinks
    /// break across the rebind.
    ///
    /// Returns whether the row at this path now carries `doc_id` — true when it
    /// already did (a re-run), false when the id belongs to a DIFFERENT path,
    /// which is never merged: that would silently drop one note's index entry.
    fn rebind_in_tx(
        &self,
        tx: &Connection,
        current: &str,
        doc_id: &str,
        touched: &mut Vec<String>,
    ) -> AppResult<bool> {
        if current == doc_id {
            return Ok(true);
        }
        let taken: Option<String> = tx
            .query_row(
                "SELECT path FROM notes WHERE id = ?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Ok(false);
        }
        tx.execute(
            "UPDATE notes SET id = ?1 WHERE id = ?2",
            params![doc_id, current],
        )?;
        tx.execute(
            "UPDATE note_tags SET note_id = ?1 WHERE note_id = ?2",
            params![doc_id, current],
        )?;
        tx.execute(
            "UPDATE links SET src_note_id = ?1 WHERE src_note_id = ?2",
            params![doc_id, current],
        )?;
        touched.push(doc_id.to_string());
        Ok(true)
    }

    /// Drop every CRDT row whose `doc_id` is not in `live`, then report what went.
    ///
    /// The CRDT tables are the one part of the index that `rebuild` deliberately
    /// never touches — that is what lets a rebuild preserve unsynced edits. The
    /// cost of that safety is that nothing ever removed a doc's rows either, so
    /// a vault accumulated the CRDT of every note it had ever held: notes
    /// deleted, renamed into a new id, or forked by a past path collision. One
    /// production vault carried 953 such docs inside a 900 MB `index.sqlite`.
    ///
    /// SAFETY: `live` is the caller's complete set of doc ids that still matter
    /// (the registry map ∪ the local index ∪ anything open). An EMPTY set is
    /// refused rather than obeyed — "I know of no live docs" is what a caller
    /// looks like when it failed to load its map, and honouring it would erase
    /// every unsynced edit in the vault. A caller that genuinely wants that
    /// deletes the file.
    pub fn prune_yjs_docs(&self, live: &[String]) -> AppResult<YjsPruneReport> {
        if live.is_empty() {
            return Err(AppError(
                "refusing to prune CRDT rows against an empty live set".into(),
            ));
        }
        let tx = self.conn.unchecked_transaction()?;
        // A temp table + anti-join keeps this one pass regardless of vault size;
        // an `NOT IN (?,?,…)` with 6 000 binds would exceed SQLite's parameter
        // limit long before it got slow.
        tx.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS _live_docs (doc_id TEXT PRIMARY KEY);
             DELETE FROM _live_docs;",
        )?;
        {
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO _live_docs (doc_id) VALUES (?1)")?;
            for id in live {
                stmt.execute(params![id])?;
            }
        }
        let snapshot_bytes: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) FROM yjs_snapshot
                 WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let update_bytes: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(\"update\")), 0) FROM yjs_updates
                 WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let docs_removed = tx.execute(
            "DELETE FROM yjs_snapshot WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
            [],
        )? as i64;
        let updates_removed = tx.execute(
            "DELETE FROM yjs_updates WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
            [],
        )? as i64;
        // Fold state for a note nobody can reach any more. Judged against the
        // same live set as the CRDT rows rather than against `notes.id`: the
        // live set is a superset of it (registry map ∪ local index ∪ open docs),
        // so this can never throw away the folds of a note the index is merely
        // between writes on.
        tx.execute(
            "DELETE FROM note_ui_state WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
            [],
        )?;
        tx.execute(
            "DELETE FROM yjs_disk_base WHERE doc_id NOT IN (SELECT doc_id FROM _live_docs)",
            [],
        )?;
        tx.execute_batch("DROP TABLE IF EXISTS _live_docs;")?;
        tx.commit()?;
        Ok(YjsPruneReport {
            docs_removed,
            updates_removed,
            bytes_reclaimed: snapshot_bytes + update_bytes,
        })
    }

    // ---- Per-note editor UI state (fold state) ----------------------------

    /// One note's stored editor UI state, or `None` if it has never been saved.
    /// Absent is an ordinary answer (a note you have never folded), never an
    /// error.
    pub fn get_note_ui_state(&self, doc_id: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT state FROM note_ui_state WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// The disk base recorded for a doc (see the `yjs_disk_base` table), or
    /// `None` when this device has never recorded one — an ordinary answer for
    /// a vault that predates the table.
    pub fn get_disk_base(&self, doc_id: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT sha256 FROM yjs_disk_base WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Record a doc's disk base: the sha256 of the bytes that are now both on
    /// disk and in the doc.
    pub fn set_disk_base(&self, doc_id: &str, sha256: &str) -> AppResult<()> {
        set_disk_base_on(&self.conn, doc_id, sha256)
    }

    /// Replace one note's editor UI state.
    pub fn set_note_ui_state(&self, doc_id: &str, state: &str) -> AppResult<()> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO note_ui_state (doc_id, state, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(doc_id) DO UPDATE SET state = excluded.state,
                                               updated_at = excluded.updated_at",
            params![doc_id, state, now_ms],
        )?;
        Ok(())
    }

    /// Drop ONE doc's CRDT rows: its snapshot, state vector and update log.
    ///
    /// The local half of the oversized-note repair. Unlike `prune_yjs_docs` this
    /// targets a doc that is still very much live — the caller is deliberately
    /// discarding its history because the server has discarded the same history,
    /// and leaving the local copy would merge the old state straight back in on
    /// the next connect.
    pub fn clear_yjs_doc(&self, doc_id: &str) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM yjs_updates WHERE doc_id = ?1", params![doc_id])?;
        tx.execute("DELETE FROM yjs_snapshot WHERE doc_id = ?1", params![doc_id])?;
        tx.execute("DELETE FROM yjs_disk_base WHERE doc_id = ?1", params![doc_id])?;
        tx.commit()?;
        Ok(())
    }

    // ---- Vault census (Vault Settings → Health) ---------------------------
    //
    // Four aggregate reads behind `stats::collect`. Deliberately queries, not
    // row dumps: the Health page wants totals, and a vault with 90 000 link
    // rows must not ship them through the IPC boundary to be counted in TS.

    /// Every `notes` row the census and its integrity checks need: the file
    /// classifier (a file on disk is a *note* exactly when its vault-relative
    /// path is a row here), the `duplicate-titles` check, and the `stale-index`
    /// check's stored mtime. Unordered and un-joined — cheap enough to call on a
    /// several-thousand-note vault, unlike `list_note_titles`' ORDER BY.
    ///
    /// `mtime` is in SECONDS (what `file_mtime` writes), not the milliseconds
    /// every disk-side number in `stats.rs` carries.
    pub fn note_rows(&self) -> AppResult<Vec<NoteRow>> {
        let mut stmt = self.conn.prepare("SELECT id, path, title, mtime FROM notes")?;
        let rows = stmt.query_map([], |r| {
            Ok(NoteRow {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                mtime: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every wikilink that resolved to nothing, as `(src_note_id, raw target)`,
    /// grouped by source and in document order within it. The `broken-links`
    /// check reports these per SOURCE note, so the caller folds the rows; the
    /// vault-wide total is `link_counts().broken`.
    pub fn unresolved_links(&self) -> AppResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT src_note_id, COALESCE(dst_path_raw, '') FROM links
              WHERE dst_note_id IS NULL
              ORDER BY src_note_id, position",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// How many distinct `#tag` names the index holds.
    ///
    /// `tags` rows outlive the last note that used them (see `list_tags`), so
    /// this is "tags this vault knows about", which is exactly what the tag
    /// completion list shows — the two numbers agree by construction.
    pub fn tag_count(&self) -> AppResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))?)
    }

    /// Wikilinks split by whether they found a note. `dst_note_id IS NULL` is
    /// how `resolve_links` records a link it could not resolve, so the broken
    /// half is the vault's dangling `[[…]]` references.
    pub fn link_counts(&self) -> AppResult<LinkCounts> {
        let (resolved, broken) = self.conn.query_row(
            "SELECT COUNT(dst_note_id), COUNT(*) - COUNT(dst_note_id) FROM links",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )?;
        Ok(LinkCounts { resolved, broken })
    }

    /// Per-doc CRDT footprint: update-log rows and the bytes of the log plus the
    /// snapshot. Unsorted — the caller ranks and joins against `notes`.
    ///
    /// A doc that has only a *state vector* (the NULL-snapshot row
    /// `save_yjs_state_vectors` writes for the sync manifest) is deliberately
    /// absent: it carries neither an update nor a snapshot, so counting it would
    /// report history the vault does not actually store.
    pub fn history_footprints(&self) -> AppResult<Vec<DocHistory>> {
        let mut stmt = self.conn.prepare(
            "SELECT doc_id, SUM(updates) AS updates, SUM(bytes) AS bytes FROM (
                 SELECT doc_id,
                        COUNT(*) AS updates,
                        COALESCE(SUM(LENGTH(\"update\")), 0) AS bytes
                   FROM yjs_updates
                  WHERE doc_id IS NOT NULL
                  GROUP BY doc_id
                 UNION ALL
                 SELECT doc_id, 0 AS updates, LENGTH(snapshot) AS bytes
                   FROM yjs_snapshot
                  WHERE doc_id IS NOT NULL AND snapshot IS NOT NULL
             )
             GROUP BY doc_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DocHistory {
                doc_id: r.get(0)?,
                updates: r.get(1)?,
                bytes: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// `VACUUM` the index, returning the bytes the file gave back.
    ///
    /// Deleting rows only frees SQLite *pages*, which the file keeps. After a
    /// prune that dropped hundreds of megabytes of blobs the file on disk is
    /// unchanged until this runs, so the user sees no space back — which is the
    /// entire point of the exercise.
    ///
    /// Cannot run inside a transaction, and rewrites the whole file, so it is a
    /// maintenance operation and never part of a hot path.
    pub fn vacuum(&self) -> AppResult<i64> {
        let before = self.db_size_bytes();
        self.conn.execute_batch("VACUUM;")?;
        let after = self.db_size_bytes();
        Ok((before - after).max(0))
    }

    /// Size of the SQLite file itself (page_count × page_size), so callers can
    /// report reclaimed space without knowing where the file lives.
    pub fn db_size_bytes(&self) -> i64 {
        let page_count: i64 = self
            .conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let page_size: i64 = self
            .conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(0);
        page_count * page_size
    }
}

/// The three columns `upsert_file` compares a file on disk against, plus its id.
/// Private: nothing outside the write path has a use for it.
struct FileState {
    id: String,
    size: i64,
    mtime: i64,
    status: String,
}

/// One tier-2 row, as the Health census and the tests read it.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub id: String,
    pub path: String,
    pub ext: Option<String>,
    pub kind: Option<String>,
    pub size: i64,
    pub text_status: String,
}

/// The extracted text of one file, for whoever needs the words rather than the
/// bytes — the search panel has its snippet, the sync layer wants this.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    /// sha256 of the FILE (empty until the worker has hashed it).
    pub sha256: String,
    /// `extract.rs TextStatus`.
    pub status: String,
    pub chars: i64,
    pub text: String,
}

/// What tier 2 costs inside the index file. See [`Index::file_text_footprint`].
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTextFootprint {
    pub files: i64,
    pub bytes: i64,
}

/// One `notes` row as the Health census reads it — see [`Index::note_rows`].
#[derive(Debug, Clone)]
pub struct NoteRow {
    pub id: String,
    pub path: String,
    /// The derived index title (frontmatter `title:` → first H1 → stem), which
    /// is NOT what the sidebar displays. Empty when the column is NULL.
    pub title: String,
    /// The mtime recorded at index time, in SECONDS.
    pub mtime: i64,
}

/// Resolved vs dangling wikilinks — see [`Index::link_counts`].
#[derive(Debug, Clone, Copy, Default)]
pub struct LinkCounts {
    pub resolved: i64,
    pub broken: i64,
}

/// One doc's raw CRDT footprint in the local store — see
/// [`Index::history_footprints`]. Not serialized: `stats.rs` joins it against
/// `notes` and turns it into the `HistoryFootprint` the UI sees.
#[derive(Debug, Clone)]
pub struct DocHistory {
    pub doc_id: String,
    pub updates: i64,
    pub bytes: i64,
}

/// What one {@link Index::prune_yjs_docs} pass removed.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct YjsPruneReport {
    /// Docs whose snapshot row was dropped.
    pub docs_removed: i64,
    /// Rows dropped from the update log.
    pub updates_removed: i64,
    /// Blob bytes freed inside the database (see `vacuum` for file bytes).
    pub bytes_reclaimed: i64,
}

/// A doc's persisted CRDT state, as loaded from SQLite (spec 02 §4).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YjsState {
    /// The latest merged snapshot as raw Yjs update bytes, if one exists.
    pub snapshot: Option<Vec<u8>>,
    /// Every update logged since that snapshot, oldest first.
    pub updates: Vec<Vec<u8>>,
    /// `updates.len()` — the TS side compacts when this exceeds 64.
    pub update_count: i64,
    /// The `yjs_updates.id` of the LAST row in `updates`, or `None` when the
    /// log was empty — the compaction watermark for a log this process did not
    /// append itself.
    ///
    /// A bridge that hydrates and immediately compacts (a big log survives a
    /// relaunch, and `shouldCompact` fires right after `hydrate`) has appended
    /// nothing, so it knows no watermark of its own and would have to pass
    /// `None` — which, by design, truncates nothing, and the log would never
    /// shrink again. This is that watermark, and it is taken from the last row
    /// actually returned rather than from a separate `MAX(id)`: a second query
    /// could name a row that landed after the read and is therefore NOT in the
    /// snapshot the caller is about to write.
    pub last_update_id: Option<i64>,
}

/// One doc's persisted Yjs state vector — the durable sync manifest entry.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YjsStateVector {
    pub doc_id: String,
    pub state_vector: Vec<u8>,
}

/// A file's modification time as whole seconds since the Unix epoch (0 if
/// unavailable). This is the cache key `rebuild` compares to skip unchanged
/// notes, so `index_one` stamps `notes.mtime` with the identical value — hence
/// the shared helper, so the two can never drift apart.
/// The lowercase extension of a vault-relative path, without the dot. `None`
/// for a file with no extension (which tier 2 never surfaces anyway).
fn ext_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            Some(ext.to_ascii_lowercase())
        }
        _ => None,
    }
}

fn file_mtime(abs: &Path) -> i64 {
    std::fs::metadata(abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Terse timing for the batch index paths. Silent for small batches so a normal
/// single-note save logs nothing; a cold `rebuild` or a bulk file drop — the two
/// places where the old one-link-pass-per-file behaviour showed up as seconds of
/// stall — reports how long it took.
fn log_batch(label: &str, files: usize, unchanged: usize, started: Instant) {
    if files < BATCH_LOG_MIN {
        return;
    }
    let ms = started.elapsed().as_millis();
    // `unchanged` is the number that makes a suspicious line readable: this is
    // the log the #155 reporter counted, and "128 files (128 unchanged)" says
    // "something is generating events" rather than "the index is thrashing".
    log::info!(
        "[index] {label}: {files} files ({unchanged} unchanged) in {ms} ms ({:.2} ms/file)",
        ms as f64 / files as f64
    );
}

/// Turn free-form user input into a safe FTS5 MATCH query: each term becomes a
/// prefix match, joined by AND. Quotes special chars to avoid syntax errors.
fn build_fts_query(input: &str) -> String {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            let cleaned: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            cleaned
        })
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    terms.join(" AND ")
}

/// Escape an FTS snippet and turn the sentinels back into `<mark>` tags. The
/// ONE place `<mark>` is emitted in the whole app — both tiers come through it.
fn mark_snippet(raw: String) -> String {
    html_escape(&raw)
        .replace('\u{1}', "<mark>")
        .replace('\u{2}', "</mark>")
}

/// Merge the two tiers into one ranked list.
///
/// Pure, so the rule is testable without a database: sort ascending by score
/// (SQLite's bm25 is negative — more negative is a better match), break ties by
/// path so two identical queries answer identically, and cap. The file penalty
/// is already baked into the scores by `search_files_ranked`.
fn merge_ranked(mut hits: Vec<RankedHit>, limit: usize) -> Vec<SearchResult> {
    hits.sort_by(rank_order);
    hits.truncate(limit);
    hits.into_iter().map(|h| h.result).collect()
}

fn rank_order(a: &RankedHit, b: &RankedHit) -> std::cmp::Ordering {
    a.score
        .partial_cmp(&b.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a.result.path.cmp(&b.result.path))
}

/// HTML-escape text so a note body can never inject markup when a snippet is
/// rendered. The FTS `body` column stores raw markdown (which may contain
/// literal `<`, `>`, `&`, quotes, or even `<script>`/`<img onerror=…>`), so the
/// snippet is escaped before the `<mark>` highlight markers are put back — the
/// only tags that survive into the rendered snippet are our own `<mark>`s.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notefile::write_note;

    /// Every `folders` row's path. There is no production listing command to
    /// reuse — the sidebar walks disk — so the tests read the table directly.
    fn folder_paths(idx: &Index) -> Vec<String> {
        let mut stmt = idx.conn.prepare("SELECT path FROM folders").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn seed_vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(
            &v,
            "Alpha.md",
            "---\ntags: [project]\n---\n# Alpha\n\nLinks to [[Beta]] and #inline tag.",
        )
        .unwrap();
        write_note(
            &v,
            "sub/Beta.md",
            "# Beta\n\nThe quick brown fox. Back to [[Alpha]].",
        )
        .unwrap();
        write_note(&v, "Gamma.md", "# Gamma\n\nDangling [[Nonexistent]] link.").unwrap();
        (tmp, v)
    }

    /// The CRDT note family is md/markdown/mdx + txt/html/htm/canvas, and all of
    /// it indexes. Before this, `.txt` synced as a note yet had no `notes` row —
    /// unsearchable, unreachable by wikilink, and with no doc_id for the sidebar
    /// to key on.
    #[test]
    fn indexes_the_whole_note_family_with_ids_stable_across_rebuild() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Note.md", "# Note\n\nmarkdown body").unwrap();
        write_note(&v, "Plain.txt", "a plain text jellyfish note").unwrap();
        write_note(&v, "Page.html", "<p class=\"zzmarkup\">an html <b>jellyfish</b> page</p>").unwrap();
        write_note(&v, "Board.canvas", "{\"nodes\":[]}").unwrap();
        // Not a note: surfaced in the tree, but it rides the blob store.
        std::fs::write(v.join("Sheet.csv"), b"a,b\n1,2\n").unwrap();

        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let mut paths: Vec<String> = idx
            .list_note_titles()
            .unwrap()
            .into_iter()
            .map(|t| t.path)
            .collect();
        paths.sort();
        assert_eq!(paths, ["Board.canvas", "Note.md", "Page.html", "Plain.txt"]);

        // Non-markdown members take their filename stem as the title.
        let txt = idx.get_note_meta("Plain.txt").unwrap().unwrap();
        assert_eq!(txt.title, "Plain");
        let html = idx.get_note_meta("Page.html").unwrap().unwrap();
        assert_eq!(html.title, "Page");

        // FTS reaches both — and the html row holds its TEXT, not its markup.
        let hits = idx.search_notes("jellyfish").unwrap();
        let mut hit_paths: Vec<String> = hits.into_iter().map(|h| h.path).collect();
        hit_paths.sort();
        assert_eq!(hit_paths, ["Page.html", "Plain.txt"]);
        assert!(
            idx.search_notes("zzmarkup").unwrap().is_empty(),
            "markup is stripped before it reaches FTS"
        );

        // Identity survives a rebuild, exactly like `.md` (renames/backlinks).
        let ids_before: Vec<(String, String)> = ["Plain.txt", "Page.html", "Board.canvas"]
            .iter()
            .map(|p| (p.to_string(), idx.get_note_meta(p).unwrap().unwrap().id))
            .collect();
        idx.rebuild(&v).unwrap();
        for (path, id) in ids_before {
            assert_eq!(idx.get_note_meta(&path).unwrap().unwrap().id, id, "{path}");
        }
    }

    /// `#tag` and `[[wikilink]]` are MARKDOWN rules (see `parse.rs`). A `.txt`
    /// shopping list full of `#` bullets must not stuff the tag cloud with words
    /// the editor never draws as pills.
    #[test]
    fn a_txt_notes_hashes_and_brackets_are_not_tags_or_links() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "List.txt", "#groceries\nmilk\n[[Alpha]]\n").unwrap();
        write_note(&v, "Alpha.md", "# Alpha\n\n#real").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let names: Vec<String> = idx.list_tags(50).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, ["real"], "only the markdown note contributed a tag");

        // …and no backlink either: the `.txt`'s `[[Alpha]]` is just text.
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        assert!(idx.get_backlinks(&alpha.id).unwrap().is_empty());
    }

    /// The editor's `#` completion: every tag, most-used first. Ties break by
    /// name so the list is stable between calls, which is what keeps the picker
    /// from reshuffling under the user's finger.
    #[test]
    fn list_tags_counts_and_orders_by_use() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "A.md", "---\ntags: [common, zeta]\n---\nA #common").unwrap();
        write_note(&v, "B.md", "B has #common and #alpha").unwrap();
        write_note(&v, "C.md", "C has #common").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let tags = idx.list_tags(50).unwrap();
        let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names.first(), Some(&"common"), "most-used tag leads");
        assert_eq!(tags[0].count, 3);
        // Three notes, one each: alphabetical among the equals.
        assert_eq!(&names[1..], &["alpha", "zeta"]);
    }

    #[test]
    fn list_tags_honours_its_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "A.md", "#a #b #c #d").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        assert_eq!(idx.list_tags(2).unwrap().len(), 2);
    }

    /// Fold state describes how you were READING a note; a re-index of the
    /// files has no business forgetting it. Same contract as the `yjs_*`
    /// tables: keyed by doc_id, never touched by `rebuild()`.
    #[test]
    fn note_ui_state_survives_a_rebuild() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();

        assert_eq!(idx.get_note_ui_state(&alpha.id).unwrap(), None);
        idx.set_note_ui_state(&alpha.id, r##"{"v":1,"folds":[{"line":4,"text":"# Alpha"}]}"##)
            .unwrap();
        idx.rebuild(&v).unwrap();
        assert_eq!(
            idx.get_note_ui_state(&alpha.id).unwrap().as_deref(),
            Some(r##"{"v":1,"folds":[{"line":4,"text":"# Alpha"}]}"##),
        );

        // And a second save replaces rather than duplicating (doc_id is the PK).
        idx.set_note_ui_state(&alpha.id, r#"{"v":1,"folds":[]}"#).unwrap();
        assert_eq!(
            idx.get_note_ui_state(&alpha.id).unwrap().as_deref(),
            Some(r#"{"v":1,"folds":[]}"#),
        );
    }

    #[test]
    fn disk_base_round_trips_and_is_cleared_with_the_doc() {
        let idx = Index::open_in_memory().unwrap();
        assert_eq!(idx.get_disk_base("d").unwrap(), None);
        idx.set_disk_base("d", "aaa").unwrap();
        assert_eq!(idx.get_disk_base("d").unwrap().as_deref(), Some("aaa"));
        idx.set_disk_base("d", "bbb").unwrap();
        assert_eq!(idx.get_disk_base("d").unwrap().as_deref(), Some("bbb"));
        idx.clear_yjs_doc("d").unwrap();
        assert_eq!(idx.get_disk_base("d").unwrap(), None);
    }

    #[test]
    fn prune_yjs_docs_sweeps_orphan_disk_bases() {
        let idx = Index::open_in_memory().unwrap();
        idx.set_disk_base("live", "l").unwrap();
        idx.set_disk_base("dead", "x").unwrap();
        idx.prune_yjs_docs(&["live".to_string()]).unwrap();
        assert_eq!(idx.get_disk_base("live").unwrap().as_deref(), Some("l"));
        assert_eq!(idx.get_disk_base("dead").unwrap(), None);
    }

    #[test]
    fn prune_yjs_docs_sweeps_orphan_ui_state() {
        let idx = Index::open_in_memory().unwrap();
        idx.set_note_ui_state("live", r#"{"v":1,"folds":[]}"#).unwrap();
        idx.set_note_ui_state("dead", r#"{"v":1,"folds":[]}"#).unwrap();
        idx.append_yjs_update("live", &[1]).unwrap();

        idx.prune_yjs_docs(&["live".to_string()]).unwrap();

        assert!(idx.get_note_ui_state("live").unwrap().is_some());
        assert_eq!(idx.get_note_ui_state("dead").unwrap(), None);
    }

    /// The Properties panel's name suggestions: every key in the vault, ordered
    /// by how many notes use it. A note whose `frontmatter` blob is not an
    /// object (a bare string is legal YAML) or is unreadable must be skipped,
    /// not raised — one odd note cannot empty the whole list.
    #[test]
    fn list_property_keys_counts_across_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "A.md", "---\nstatus: draft\ntags: [x]\n---\nA").unwrap();
        write_note(&v, "B.md", "---\nstatus: final\n---\nB").unwrap();
        write_note(&v, "C.md", "---\njust a string\n---\nC").unwrap();
        write_note(&v, "D.md", "No frontmatter at all.").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let keys = idx.list_property_keys().unwrap();
        let pairs: Vec<(String, i64)> = keys.into_iter().map(|k| (k.key, k.count)).collect();
        assert_eq!(
            pairs,
            vec![("status".to_string(), 2), ("tags".to_string(), 1)]
        );
    }

    /// Value suggestions flatten arrays, drop duplicates and sort, so the same
    /// tag typed in two notes offers itself once.
    #[test]
    fn list_property_values_flattens_and_dedups() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "A.md", "---\ntags: [youtube, ai]\nn: 3\n---\nA").unwrap();
        write_note(&v, "B.md", "---\ntags: [ai, rust]\n---\nB").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        assert_eq!(
            idx.list_property_values("tags", 200).unwrap(),
            vec!["ai", "rust", "youtube"]
        );
        // Non-string scalars still suggest; an unknown key is empty, not an error.
        assert_eq!(idx.list_property_values("n", 200).unwrap(), vec!["3"]);
        assert!(idx.list_property_values("nope", 200).unwrap().is_empty());
        // The cap is a cap, not a suggestion.
        assert_eq!(idx.list_property_values("tags", 2).unwrap().len(), 2);
    }

    #[test]
    fn rebuild_populates_notes_tags_links() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let titles = idx.list_note_titles().unwrap();
        assert_eq!(titles.len(), 3);

        // Alpha has a project tag.
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        assert!(alpha.tags.contains(&"project".to_string()));
        assert!(alpha.tags.contains(&"inline".to_string()));

        // Beta backlinks include Alpha (Alpha -> [[Beta]]).
        let beta = idx.get_note_meta("sub/Beta.md").unwrap().unwrap();
        let backlinks = idx.get_backlinks(&beta.id).unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].title, "Alpha");
    }

    /// A clean reopen must not rewrite a single `folders` row. Those writes
    /// happen inside the transaction that holds the index mutex, so paying them
    /// for an unchanged vault delays every reader at launch for nothing.
    #[test]
    fn rebuild_skips_unchanged_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Projects/a/One.md", "# One").unwrap();
        write_note(&v, "Projects/b/Two.md", "# Two").unwrap();
        let idx = Index::open(&v).unwrap();

        idx.rebuild(&v).unwrap();
        // Projects, Projects/a, Projects/b.
        assert_eq!(idx.folder_write_count(), 3);

        idx.rebuild(&v).unwrap();
        assert_eq!(
            idx.folder_write_count(),
            3,
            "an unchanged vault must write no folder rows on reopen"
        );
        // The rows are still all there — skipping the write is not dropping it.
        assert_eq!(folder_paths(&idx).len(), 3);
    }

    /// The case that actually happens: a macOS case-only rename. The skip keys
    /// on (parent_id, name), so the new casing must be written and the old row
    /// must go — otherwise the sidebar and the sync registry disagree on a path.
    #[test]
    fn rebuild_upserts_a_case_renamed_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Projects/One.md", "# One").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        assert!(folder_paths(&idx).iter().any(|f| f == "Projects"));

        // Rename via a temp name so the test works on a case-insensitive volume.
        std::fs::rename(v.join("Projects"), v.join("tmp-rename")).unwrap();
        std::fs::rename(v.join("tmp-rename"), v.join("projects")).unwrap();
        let before = idx.folder_write_count();
        idx.rebuild(&v).unwrap();

        let folders = folder_paths(&idx);
        assert!(folders.iter().any(|f| f == "projects"), "{folders:?}");
        assert!(!folders.iter().any(|f| f == "Projects"), "{folders:?}");
        assert!(
            idx.folder_write_count() > before,
            "a renamed folder must be re-upserted, not skipped"
        );
    }

    /// Folder churn alone must not charge a whole-vault link pass: a link's
    /// answer is a function of note basenames and titles, and no note changed.
    #[test]
    fn rebuild_does_not_resolve_links_for_folder_churn_alone() {
        let (_tmp, v) = seed_vault();
        std::fs::create_dir_all(v.join("Empty")).unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let after_first = idx.resolve_call_count();

        // Remove the empty folder; every note is untouched.
        std::fs::remove_dir(v.join("Empty")).unwrap();
        idx.rebuild(&v).unwrap();
        assert_eq!(
            idx.resolve_call_count(),
            after_first,
            "a removed folder must not re-resolve every link in the vault"
        );
        // The folder row is gone all the same.
        assert!(!folder_paths(&idx).iter().any(|f| f == "Empty"));
    }

    #[test]
    fn rebuild_is_incremental_and_reconciles_changes() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let alpha_id = idx.get_note_meta("Alpha.md").unwrap().unwrap().id;

        // Reopening an unchanged vault preserves every note and its id.
        idx.rebuild(&v).unwrap();
        assert_eq!(idx.list_note_titles().unwrap().len(), 3);
        assert_eq!(idx.get_note_meta("Alpha.md").unwrap().unwrap().id, alpha_id);

        // Mutate the vault as if edited while the app was closed: add a note,
        // delete one, and change one.
        write_note(&v, "Delta.md", "# Delta\n\nOnly here for a moment.").unwrap();
        std::fs::remove_file(v.join("Gamma.md")).unwrap();
        write_note(&v, "Alpha.md", "# Alpha\n\nNow links to [[Delta]].").unwrap();
        // Force Alpha's stored mtime stale so the change is detected regardless
        // of the filesystem's one-second mtime granularity in a fast test.
        idx.conn
            .execute("UPDATE notes SET mtime = 0 WHERE path = 'Alpha.md'", [])
            .unwrap();

        idx.rebuild(&v).unwrap();

        let paths: std::collections::HashSet<String> = idx
            .list_note_titles()
            .unwrap()
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert!(paths.contains("Delta.md"), "new file should be indexed");
        assert!(
            !paths.contains("Gamma.md"),
            "deleted file should be dropped"
        );
        assert_eq!(paths.len(), 3); // Alpha, sub/Beta, Delta

        // Alpha kept its identity through the edit, and its new link resolved
        // (a re-index of a changed note must re-resolve links too).
        assert_eq!(idx.get_note_meta("Alpha.md").unwrap().unwrap().id, alpha_id);
        let delta = idx.get_note_meta("Delta.md").unwrap().unwrap();
        let backlinks = idx.get_backlinks(&delta.id).unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].title, "Alpha");
    }

    // ---- batch indexing (the quadratic-link-pass fix) ---------------------

    /// Every file-derived row a batch produces, in a form that is comparable
    /// across two independently-built vaults (doc_ids are fresh UUIDs, and the
    /// two vaults' mtimes can differ by a second, so neither is included).
    #[allow(clippy::type_complexity)]
    fn file_derived_snapshot(
        idx: &Index,
    ) -> (
        Vec<(String, String, String)>,
        Vec<(String, String)>,
        Vec<(String, String, String)>,
        Vec<(String, String)>,
    ) {
        let notes: Vec<(String, String, String)> = {
            let mut stmt = idx
                .conn
                .prepare("SELECT path, title, sha256 FROM notes ORDER BY path")
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let fts: Vec<(String, String)> = {
            let mut stmt = idx
                .conn
                .prepare(
                    "SELECT n.path, f.body FROM notes_fts f
                     JOIN notes n ON n.rowid = f.rowid ORDER BY n.path",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        // Links joined back to PATHS on both ends: `dst_note_id` proves the link
        // pass ran, and a path is stable across vaults where an id is not.
        let links: Vec<(String, String, String)> = {
            let mut stmt = idx
                .conn
                .prepare(
                    "SELECT src.path, COALESCE(dst.path, '-'), l.dst_path_raw
                     FROM links l
                     JOIN notes src ON src.id = l.src_note_id
                     LEFT JOIN notes dst ON dst.id = l.dst_note_id
                     ORDER BY src.path, l.dst_path_raw",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let tags: Vec<(String, String)> = {
            let mut stmt = idx
                .conn
                .prepare(
                    "SELECT n.path, t.name FROM note_tags nt
                     JOIN notes n ON n.id = nt.note_id
                     JOIN tags t ON t.id = nt.tag_id
                     ORDER BY n.path, t.name",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        (notes, fts, links, tags)
    }

    fn seed_batch_vault() -> (tempfile::TempDir, std::path::PathBuf, Vec<PathBuf>) {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        let files = [
            (
                "Alpha.md",
                "---\ntags: [project]\n---\n# Alpha\n\nTo [[Beta]] and [[Gamma]]. #inline",
            ),
            (
                "sub/Beta.md",
                "# Beta\n\nBack to [[Alpha]] and out to [[Nowhere]].",
            ),
            (
                "Gamma.md",
                "# Gamma\n\nquick brown fox linking [[sub/Beta]].",
            ),
            (
                "sub/deep/Delta.md",
                "---\ntags: [a, b]\n---\n# Delta\n\n[[Alpha]] [[Gamma]]",
            ),
            ("Epsilon.md", "# Epsilon\n\nNo links here at all."),
        ];
        let mut abs = Vec::new();
        for (rel, body) in files {
            write_note(&v, rel, body).unwrap();
            abs.push(v.join(rel));
        }
        (tmp, v, abs)
    }

    /// The batch entry point must be observationally identical to calling
    /// `index_note` once per file — same notes, FTS rows, tags, and RESOLVED
    /// links. Only the number of whole-vault link passes differs.
    #[test]
    fn index_notes_matches_one_index_note_per_file() {
        let (_tmp_a, va, abs_a) = seed_batch_vault();
        let idx_a = Index::open(&va).unwrap();
        for abs in &abs_a {
            idx_a.index_note(&va, abs).unwrap();
        }

        let (_tmp_b, vb, abs_b) = seed_batch_vault();
        let idx_b = Index::open(&vb).unwrap();
        assert!(idx_b.index_notes(&vb, &abs_b).unwrap().failures.is_empty());

        assert_eq!(file_derived_snapshot(&idx_a), file_derived_snapshot(&idx_b));

        // And the snapshot is not trivially empty / unresolved.
        let (notes, _, links, _) = file_derived_snapshot(&idx_b);
        assert_eq!(notes.len(), 5);
        assert!(
            links.iter().any(|(_, dst, _)| dst != "-"),
            "links should be resolved: {links:?}"
        );
        assert!(
            links
                .iter()
                .any(|(_, dst, raw)| dst == "-" && raw == "Nowhere"),
            "a dangling link stays dangling: {links:?}"
        );
    }

    /// A note past `MAX_INDEX_BYTES` must stay LISTED but contribute no links —
    /// the guard that stops one runaway file (68 MB, ~86k wikilinks) from putting
    /// 2M rows in `links` and making every later index pass take tens of seconds.
    #[test]
    fn an_oversized_note_is_listed_but_not_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        // One link per copy; well past the cap.
        let huge = "see [[Target]]\n".repeat(800_000);
        assert!(huge.len() as u64 > MAX_INDEX_BYTES);
        std::fs::write(v.join("Huge.md"), &huge).unwrap();
        std::fs::write(v.join("Target.md"), "# Target").unwrap();
        std::fs::write(v.join("Small.md"), "# Small\n\nsee [[Target]]").unwrap();

        let idx = Index::open(&v).unwrap();
        idx.index_notes(
            &v,
            &[v.join("Huge.md"), v.join("Target.md"), v.join("Small.md")],
        )
        .unwrap();

        // Listed, so the user can still find the offender.
        let listed: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE path = 'Huge.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(listed, 1, "an oversized note must still be indexed by title");

        // …but it contributes NO links, while the small note's link still works.
        let from_huge: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links l JOIN notes n ON n.id = l.src_note_id
                  WHERE n.path = 'Huge.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(from_huge, 0, "oversized note must not be parsed for links");

        let from_small: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links l JOIN notes n ON n.id = l.src_note_id
                  WHERE n.path = 'Small.md' AND l.dst_note_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(from_small, 1, "normal notes are unaffected");
    }

    /// Scoping the link pass (`LinkScope::Touched`) must not cost correctness.
    /// The risky case: a link that was DANGLING when written has to resolve once
    /// its target is indexed by a later, scoped batch — the target's id is in
    /// that batch, and the dangling row is picked up by the `dst_note_id IS NULL`
    /// arm.
    #[test]
    fn a_dangling_link_still_resolves_when_its_target_arrives_in_a_later_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        std::fs::write(v.join("Alpha.md"), "# Alpha\n\nsee [[Beta]]").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();

        // Beta doesn't exist yet, so the link is dangling.
        let dst: Option<String> = idx
            .conn
            .query_row("SELECT dst_note_id FROM links", [], |r| r.get(0))
            .unwrap();
        assert!(dst.is_none(), "link to a missing note must be unresolved");

        // Beta arrives in its own batch; Alpha is NOT re-indexed.
        std::fs::write(v.join("Beta.md"), "# Beta").unwrap();
        idx.index_notes(&v, &[v.join("Beta.md")]).unwrap();

        let (dst, beta): (Option<String>, String) = (
            idx.conn
                .query_row("SELECT dst_note_id FROM links", [], |r| r.get(0))
                .unwrap(),
            idx.conn
                .query_row("SELECT id FROM notes WHERE path = 'Beta.md'", [], |r| {
                    r.get(0)
                })
                .unwrap(),
        );
        assert_eq!(dst.as_deref(), Some(beta.as_str()), "must resolve to Beta");
    }

    /// The other half: removing a note sends links that pointed AT it back to
    /// dangling. `remove_notes` scopes on the removed ids, so those rows are in
    /// the `dst_note_id IN (…)` arm.
    #[test]
    fn removing_a_note_redangles_links_that_pointed_at_it() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        std::fs::write(v.join("Alpha.md"), "# Alpha\n\nsee [[Beta]]").unwrap();
        std::fs::write(v.join("Beta.md"), "# Beta").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md"), v.join("Beta.md")])
            .unwrap();
        let dst: Option<String> = idx
            .conn
            .query_row("SELECT dst_note_id FROM links", [], |r| r.get(0))
            .unwrap();
        assert!(dst.is_some(), "precondition: resolved");

        std::fs::remove_file(v.join("Beta.md")).unwrap();
        idx.remove_notes(&v, &[v.join("Beta.md")]).unwrap();

        let dst: Option<String> = idx
            .conn
            .query_row("SELECT dst_note_id FROM links", [], |r| r.get(0))
            .unwrap();
        assert!(dst.is_none(), "target gone → link must dangle again");
    }

    /// The whole point: ONE link pass for the batch, versus one per file.
    #[test]
    fn index_notes_runs_exactly_one_link_pass_per_batch() {
        let (_tmp, v, abs) = seed_batch_vault();
        let idx = Index::open(&v).unwrap();
        assert_eq!(idx.resolve_call_count(), 0);

        idx.index_notes(&v, &abs).unwrap();
        assert_eq!(
            idx.resolve_call_count(),
            1,
            "5 files must cost ONE whole-vault link pass"
        );

        // Re-offering the identical files costs NOTHING: the hash gate takes all
        // five, so the batch has nothing to resolve.
        idx.index_notes(&v, &abs).unwrap();
        assert_eq!(
            idx.resolve_call_count(),
            1,
            "a batch of unchanged files must not run a link pass"
        );

        // The old shape, for contrast: one pass per file — with real edits, so
        // the gate lets each one through.
        for one in &abs {
            let edited = format!("{}\n\nedited", std::fs::read_to_string(one).unwrap());
            std::fs::write(one, edited).unwrap();
            idx.index_note(&v, one).unwrap();
        }
        assert_eq!(idx.resolve_call_count(), 1 + abs.len());

        // Removals batch the same way.
        idx.remove_notes(&v, &abs).unwrap();
        assert_eq!(idx.resolve_call_count(), 2 + abs.len());

        // An empty batch does no work at all (no transaction, no pass).
        let before = idx.resolve_call_count();
        assert!(idx.index_notes(&v, &[]).unwrap().failures.is_empty());
        assert!(idx.remove_notes(&v, &[]).unwrap().is_empty());
        assert_eq!(idx.resolve_call_count(), before);
    }

    /// One bad file in a big drop must not cost the rest their index rows — it
    /// comes back as a reported failure instead.
    #[test]
    fn index_notes_reports_a_bad_file_without_aborting_the_batch() {
        let (_tmp, v, mut abs) = seed_batch_vault();
        let idx = Index::open(&v).unwrap();

        // Two failures of different shapes: a path that doesn't exist (read
        // error) and one outside the vault (rel_from_abs error).
        let missing = v.join("sub/Ghost.md");
        let outside = std::path::PathBuf::from("/definitely/not/in/the/vault.md");
        abs.insert(2, missing.clone());
        abs.push(outside.clone());

        let failures = idx.index_notes(&v, &abs).unwrap().failures;
        let failed: Vec<&PathBuf> = failures.iter().map(|(p, _)| p).collect();
        assert_eq!(failures.len(), 2, "reported: {failed:?}");
        assert!(failed.contains(&&missing));
        assert!(failed.contains(&&outside));

        // Every good file still landed, links and all.
        assert_eq!(idx.list_note_titles().unwrap().len(), 5);
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        assert!(!idx.get_backlinks(&alpha.id).unwrap().is_empty());
        // Still exactly one link pass despite the failures.
        assert_eq!(idx.resolve_call_count(), 1);
    }

    // ---- the hash gate (#155) --------------------------------------------
    //
    // An event for a file whose bytes did not change must cost one read and one
    // sha256 and nothing else. These pin that by asserting on the rows directly:
    // a rewrite is invisible to any public getter (same values go back in), so
    // only the tables can tell "skipped" from "rewritten identically".

    /// Row counts + the columns `index_one` would rewrite, for one path.
    fn row_fingerprint(idx: &Index, rel: &str) -> (String, Option<String>, i64, i64, i64, i64) {
        let (id, rowid, title, sha, mtime): (String, i64, String, Option<String>, i64) = idx
            .conn
            .query_row(
                "SELECT id, rowid, title, sha256, mtime FROM notes WHERE path = ?1",
                params![rel],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get(4)?,
                    ))
                },
            )
            .unwrap();
        let count = |sql: &str, p: &dyn rusqlite::ToSql| -> i64 {
            idx.conn.query_row(sql, params![p], |r| r.get(0)).unwrap()
        };
        (
            title,
            sha,
            mtime,
            count("SELECT COUNT(*) FROM notes_fts WHERE rowid = ?1", &rowid),
            count("SELECT COUNT(*) FROM note_tags WHERE note_id = ?1", &id),
            count("SELECT COUNT(*) FROM links WHERE src_note_id = ?1", &id),
        )
    }

    #[test]
    fn reindexing_identical_bytes_changes_nothing_and_runs_no_link_pass() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\n#tag see [[Beta]]").unwrap();
        write_note(&v, "Beta.md", "# Beta").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md"), v.join("Beta.md")])
            .unwrap();
        let before = row_fingerprint(&idx, "Alpha.md");
        assert_eq!((before.3, before.4, before.5), (1, 1, 1), "precondition");
        let passes = idx.resolve_call_count();

        // The whole batch is byte-identical to what is indexed.
        let out = idx
            .index_notes(&v, &[v.join("Alpha.md"), v.join("Beta.md")])
            .unwrap();

        assert!(out.failures.is_empty());
        assert_eq!(
            out.unchanged,
            vec![v.join("Alpha.md"), v.join("Beta.md")],
            "both paths must come back as unchanged"
        );
        assert_eq!(row_fingerprint(&idx, "Alpha.md"), before);
        assert_eq!(
            idx.resolve_call_count(),
            passes,
            "nothing was touched, so the batch must run NO link pass"
        );
    }

    #[test]
    fn identical_bytes_with_a_moved_mtime_refresh_only_the_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\n#tag see [[Beta]]").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();
        // Pretend the row's mtime drifted from the file's (a touch, a restore).
        idx.conn
            .execute("UPDATE notes SET mtime = 0 WHERE path = 'Alpha.md'", [])
            .unwrap();
        let before = row_fingerprint(&idx, "Alpha.md");
        assert_eq!(before.2, 0);

        let out = idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();

        assert_eq!(out.unchanged, vec![v.join("Alpha.md")]);
        let after = row_fingerprint(&idx, "Alpha.md");
        assert_eq!(
            after.2,
            file_mtime(&v.join("Alpha.md")),
            "mtime must be refreshed, or `rebuild`'s mtime skip re-reads this file forever"
        );
        assert_ne!(after.2, before.2);
        // Everything else is untouched.
        assert_eq!(
            (after.0, after.1, after.3, after.4, after.5),
            (before.0, before.1, before.3, before.4, before.5)
        );
    }

    #[test]
    fn changed_bytes_are_reindexed() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\nold body").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();
        let before = row_fingerprint(&idx, "Alpha.md");

        write_note(&v, "Alpha.md", "# Renamed\n\n#fresh new body [[Beta]]").unwrap();
        let out = idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();

        assert!(out.unchanged.is_empty(), "the bytes changed");
        let after = row_fingerprint(&idx, "Alpha.md");
        assert_eq!(after.0, "Renamed", "title re-derived");
        assert_ne!(after.1, before.1, "sha256 rewritten");
        assert_eq!((after.4, after.5), (1, 1), "the new tag and link landed");
        let body: String = idx
            .conn
            .query_row(
                "SELECT body FROM notes_fts WHERE rowid =
                   (SELECT rowid FROM notes WHERE path = 'Alpha.md')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(body.contains("new body"), "FTS rewritten: {body:?}");
    }

    /// A NULL sha is "we don't know what is in this file" — an oversized note, or
    /// a row written before hashing existed. It must never gate anything out.
    #[test]
    fn a_row_with_a_null_sha_is_treated_as_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        write_note(&v, "Alpha.md", "# Alpha\n\nbody").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();
        idx.conn
            .execute("UPDATE notes SET sha256 = NULL WHERE path = 'Alpha.md'", [])
            .unwrap();

        let out = idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();

        assert!(out.unchanged.is_empty(), "a NULL sha counts as changed");
        assert!(
            row_fingerprint(&idx, "Alpha.md").1.is_some(),
            "and the re-index restores it"
        );
    }

    /// The gate is per PATH, not per content: a copy (or an external rename into
    /// a new name) has no row of its own, so it is indexed even though some other
    /// note holds exactly the same bytes.
    #[test]
    fn identical_bytes_at_a_new_path_are_indexed_not_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        let body = "# Alpha\n\nidentical bytes";
        write_note(&v, "Alpha.md", body).unwrap();
        let idx = Index::open(&v).unwrap();
        idx.index_notes(&v, &[v.join("Alpha.md")]).unwrap();

        write_note(&v, "Copy.md", body).unwrap();
        let out = idx.index_notes(&v, &[v.join("Copy.md")]).unwrap();

        assert!(
            out.unchanged.is_empty(),
            "a path with no row is never gated"
        );
        let ids: Vec<String> = idx
            .conn
            .prepare("SELECT id FROM notes ORDER BY path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "the copy gets its own doc_id");
    }

    #[test]
    fn a_mixed_batch_reports_exactly_the_unchanged_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        for rel in ["Same.md", "Edited.md", "Touched.md"] {
            write_note(&v, rel, &format!("# {rel}\n\nbody")).unwrap();
        }
        let idx = Index::open(&v).unwrap();
        let known: Vec<PathBuf> = ["Same.md", "Edited.md", "Touched.md"]
            .iter()
            .map(|r| v.join(r))
            .collect();
        idx.index_notes(&v, &known).unwrap();

        // Same: nothing. Edited: new bytes. Touched: same bytes, stale mtime.
        // New: never seen before.
        write_note(&v, "Edited.md", "# Edited.md\n\ndifferent body").unwrap();
        idx.conn
            .execute("UPDATE notes SET mtime = 0 WHERE path = 'Touched.md'", [])
            .unwrap();
        write_note(&v, "New.md", "# New\n\nbody").unwrap();

        let batch: Vec<PathBuf> = ["Same.md", "Edited.md", "Touched.md", "New.md"]
            .iter()
            .map(|r| v.join(r))
            .collect();
        let out = idx.index_notes(&v, &batch).unwrap();

        assert!(out.failures.is_empty());
        assert_eq!(out.unchanged, vec![v.join("Same.md"), v.join("Touched.md")]);
    }

    /// A folder delete arrives as several watcher paths; batching removals must
    /// prune the subtree exactly as the per-path loop did.
    #[test]
    fn remove_notes_prunes_files_and_folder_subtrees() {
        let (_tmp, v, _abs) = seed_batch_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        assert_eq!(idx.list_note_titles().unwrap().len(), 5);

        // One file plus a whole folder (which owns sub/Beta.md and sub/deep/Delta.md).
        let victims = vec![v.join("Epsilon.md"), v.join("sub")];
        assert!(idx.remove_notes(&v, &victims).unwrap().is_empty());

        let left: Vec<String> = idx
            .list_note_titles()
            .unwrap()
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert_eq!(left, vec!["Alpha.md".to_string(), "Gamma.md".to_string()]);
        // Alpha's [[Beta]] is dangling again — the link pass ran after the batch.
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        let dangling: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE src_note_id = ?1 AND dst_note_id IS NULL",
                params![alpha.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dangling, 1);
        // A path with nothing indexed under it is a no-op, not an error.
        assert!(idx
            .remove_notes(&v, &[v.join("never-existed")])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn fts_search_returns_expected_note() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let results = idx.search_notes("quick brown").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Beta");
        assert!(results[0].snippet.contains("<mark>"));
    }

    #[test]
    fn fts_snippet_html_escapes_body_to_prevent_xss() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        // A note body carrying an HTML/JS payload adjacent to the search terms.
        write_note(
            &v,
            "Evil.md",
            "# Evil\n\nThe quick <img src=x onerror=\"alert(document.domain)\"> brown fox & <b>bold</b>.",
        )
        .unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let results = idx.search_notes("quick brown").unwrap();
        assert_eq!(results.len(), 1);
        let snip = &results[0].snippet;
        // The dangerous markup is escaped — no live tags survive.
        assert!(snip.contains("&lt;img"), "raw < must be escaped: {snip}");
        assert!(
            !snip.contains("<img"),
            "no live <img> tag may survive: {snip}"
        );
        assert!(
            !snip.contains("onerror=\"alert"),
            "no live handler may survive: {snip}"
        );
        // The `"` around the handler is entity-escaped (proves the &-based
        // escaping path runs over the snippet).
        assert!(snip.contains("&quot;"), "raw \" must be escaped: {snip}");
        // The highlight markers are still present and are the only surviving tags.
        assert!(
            snip.contains("<mark>") && snip.contains("</mark>"),
            "highlight preserved: {snip}"
        );
    }

    #[test]
    fn dangling_link_has_null_dst() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let gamma = idx.get_note_meta("Gamma.md").unwrap().unwrap();
        // No backlinks for a nonexistent target; the link row exists but dst is NULL.
        let dangling: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE src_note_id = ?1 AND dst_note_id IS NULL",
                params![gamma.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dangling, 1);
    }

    /// An out-of-app rename: the watcher drops the old row and indexes the new
    /// file under a fresh uuid, so the sync layer has to put the registry's
    /// doc_id back onto the row. Backlinks must survive the re-key.
    #[test]
    fn rebind_note_id_rekeys_a_row_and_keeps_backlinks() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let beta_id = idx.get_note_meta("sub/Beta.md").unwrap().unwrap().id;

        // Finder renames the file: the watcher removes the old row and indexes
        // the new path as a brand-new note.
        std::fs::rename(v.join("sub/Beta.md"), v.join("sub/Renamed.md")).unwrap();
        idx.remove_note(&v, &v.join("sub/Beta.md")).unwrap();
        idx.index_note(&v, &v.join("sub/Renamed.md")).unwrap();
        let fresh_id = idx.get_note_meta("sub/Renamed.md").unwrap().unwrap().id;
        assert_ne!(fresh_id, beta_id, "the watcher minted a new id");

        assert!(idx.rebind_note_id("sub/Renamed.md", &beta_id).unwrap());
        assert_eq!(
            idx.get_note_meta("sub/Renamed.md").unwrap().unwrap().id,
            beta_id
        );
        // Alpha's [[Beta]] resolves by title, so it points at the note's ORIGINAL
        // doc_id again — which is the whole reason identity has to survive.
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        let dst: Option<String> = idx
            .conn
            .query_row(
                "SELECT dst_note_id FROM links WHERE src_note_id = ?1",
                params![alpha.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dst.as_deref(), Some(beta_id.as_str()));

        // Idempotent, and it refuses to merge two rows.
        assert!(idx.rebind_note_id("sub/Renamed.md", &beta_id).unwrap());
        let gamma_id = idx.get_note_meta("Gamma.md").unwrap().unwrap().id;
        assert!(!idx.rebind_note_id("sub/Renamed.md", &gamma_id).unwrap());
        assert!(!idx.rebind_note_id("sub/Nothing.md", &beta_id).unwrap());
    }

    #[test]
    fn rename_keeps_inbound_links() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        let beta = idx.get_note_meta("sub/Beta.md").unwrap().unwrap();
        let beta_id = beta.id.clone();

        // Move Beta on disk + update the index by id.
        write_note(
            &v,
            "moved/BetaRenamedFile.md",
            "# Beta\n\nMoved body [[Alpha]].",
        )
        .unwrap();
        std::fs::remove_file(v.join("sub/Beta.md")).unwrap();
        idx.rename_note(
            &v,
            &v.join("sub/Beta.md"),
            &v.join("moved/BetaRenamedFile.md"),
        )
        .unwrap();

        // The rule: rename preserves doc_id (identity never forks).
        let moved = idx
            .get_note_meta("moved/BetaRenamedFile.md")
            .unwrap()
            .unwrap();
        assert_eq!(moved.id, beta_id);

        // Inbound links keyed by dst_note_id are never touched by a move — so
        // Alpha's [[Beta]] still points at the same doc_id (it resolves via the
        // unchanged "Beta" title even though the filename changed).
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        let dst: Option<String> = idx
            .conn
            .query_row(
                "SELECT dst_note_id FROM links WHERE src_note_id=?1",
                params![alpha.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dst, Some(beta_id));
    }

    #[test]
    fn move_same_basename_keeps_links_resolved() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        // Move Beta.md to a different folder, same basename.
        std::fs::create_dir_all(v.join("other")).unwrap();
        std::fs::rename(v.join("sub/Beta.md"), v.join("other/Beta.md")).unwrap();
        idx.rename_note(&v, &v.join("sub/Beta.md"), &v.join("other/Beta.md"))
            .unwrap();

        // Alpha -> [[Beta]] still resolves.
        let alpha = idx.get_note_meta("Alpha.md").unwrap().unwrap();
        let resolved: i64 = idx
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE src_note_id=?1 AND dst_note_id IS NOT NULL",
                params![alpha.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(resolved, 1);
    }

    #[test]
    fn ids_survive_rebuild() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let id1 = idx.get_note_meta("Alpha.md").unwrap().unwrap().id;
        idx.rebuild(&v).unwrap();
        let id2 = idx.get_note_meta("Alpha.md").unwrap().unwrap().id;
        assert_eq!(id1, id2);
    }

    #[test]
    fn resolve_wikilink_finds_note() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let r = idx.resolve_wikilink("Beta").unwrap().unwrap();
        assert_eq!(r.path, "sub/Beta.md");
        assert!(idx.resolve_wikilink("Nonexistent").unwrap().is_none());
    }

    // ---- CRDT persistence (spec 02 §4) -----------------------------------

    #[test]
    fn yjs_append_then_load_preserves_order() {
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1, 2, 3]).unwrap();
        idx.append_yjs_update("doc-a", &[4, 5]).unwrap();
        idx.append_yjs_update("doc-b", &[9]).unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert!(a.snapshot.is_none());
        assert_eq!(a.update_count, 2);
        assert_eq!(a.updates, vec![vec![1, 2, 3], vec![4, 5]]);

        // Docs are isolated from one another.
        let b = idx.load_yjs_state("doc-b").unwrap();
        assert_eq!(b.updates, vec![vec![9]]);

        // Unknown doc → empty state.
        let empty = idx.load_yjs_state("nope").unwrap();
        assert!(empty.snapshot.is_none());
        assert_eq!(empty.update_count, 0);
        assert!(empty.updates.is_empty());
    }

    #[test]
    fn load_yjs_state_names_the_last_row_it_returned() {
        // The load-time compaction watermark. A bridge that hydrates and
        // immediately compacts has appended nothing of its own, so without this
        // it passes no watermark, truncates nothing, and a log that survived a
        // relaunch never shrinks again.
        let idx = Index::open_in_memory().unwrap();
        // Empty log ⇒ no watermark. NOT 0: 0 would be a legal rowid, and
        // "delete up to 0" must not be confused with "nothing to delete".
        assert_eq!(idx.load_yjs_state("doc-a").unwrap().last_update_id, None);

        let first = idx.append_yjs_update("doc-a", &[1]).unwrap();
        let last = idx.append_yjs_update("doc-a", &[2]).unwrap();
        // Another doc's rows are interleaved in the same table and must not be
        // named by this doc's watermark.
        let other = idx.append_yjs_update("doc-b", &[3]).unwrap();
        assert!(other > last, "ids are monotonic across docs");

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.updates, vec![vec![1], vec![2]]);
        assert_eq!(
            a.last_update_id,
            Some(last),
            "the id is the LAST row returned, never another doc's"
        );
        assert_ne!(a.last_update_id, Some(first));

        // And it is exactly the watermark that empties what was read: feeding
        // it straight back leaves nothing behind.
        idx.save_yjs_snapshot("doc-a", &[9], &[1], a.last_update_id)
            .unwrap();
        let after = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(after.update_count, 0);
        assert_eq!(after.last_update_id, None);
        // ...and it never reached doc-b.
        assert_eq!(
            idx.load_yjs_state("doc-b").unwrap().last_update_id,
            Some(other)
        );
    }

    #[test]
    fn yjs_snapshot_truncates_only_its_own_log() {
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1]).unwrap();
        let watermark = idx.append_yjs_update("doc-a", &[2]).unwrap();
        idx.append_yjs_update("doc-b", &[7]).unwrap();

        idx.save_yjs_snapshot("doc-a", &[10, 20, 30], &[40], Some(watermark))
            .unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.snapshot, Some(vec![10, 20, 30]));
        assert_eq!(a.update_count, 0, "log truncated for the snapshotted doc");
        assert!(a.updates.is_empty());

        // Other docs' logs are untouched.
        let b = idx.load_yjs_state("doc-b").unwrap();
        assert_eq!(b.update_count, 1);
        assert_eq!(b.updates, vec![vec![7]]);
    }

    #[test]
    fn yjs_snapshot_leaves_rows_appended_after_its_watermark() {
        // desktop-audit #4. The bridge encodes a snapshot, then awaits this call
        // while typing keeps appending. A row that commits inside that window is
        // NOT in the snapshot, so deleting it strands every later update behind a
        // missing item and the doc loads short.
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1]).unwrap();
        let watermark = idx.append_yjs_update("doc-a", &[2]).unwrap();
        // ...the caller encodes its snapshot here, and these land while it awaits.
        idx.append_yjs_update("doc-a", &[3]).unwrap();
        idx.append_yjs_update("doc-a", &[4]).unwrap();

        idx.save_yjs_snapshot("doc-a", &[99], &[1], Some(watermark))
            .unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.snapshot, Some(vec![99]));
        assert_eq!(
            a.updates,
            vec![vec![3], vec![4]],
            "rows appended after the watermark survive, in order"
        );
    }

    #[test]
    fn yjs_snapshot_without_a_watermark_deletes_nothing() {
        // `None` is the "snapshot only" call: it must never be read as "delete
        // everything", which is what the unwatermarked version did.
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1]).unwrap();
        idx.append_yjs_update("doc-a", &[2]).unwrap();

        idx.save_yjs_snapshot("doc-a", &[9], &[1], None).unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.snapshot, Some(vec![9]));
        assert_eq!(a.update_count, 2, "the log is untouched");
    }

    #[test]
    fn yjs_snapshot_overwrites_and_bumps_seq() {
        let idx = Index::open_in_memory().unwrap();
        idx.save_yjs_snapshot("doc-a", &[1], &[1], None).unwrap();
        // Updates after the first snapshot, then re-snapshot.
        let watermark = idx.append_yjs_update("doc-a", &[99]).unwrap();
        idx.save_yjs_snapshot("doc-a", &[2, 2], &[2], Some(watermark))
            .unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.snapshot, Some(vec![2, 2]));
        assert_eq!(a.update_count, 0);

        let seq: i64 = idx
            .conn
            .query_row(
                "SELECT seq FROM yjs_snapshot WHERE doc_id = ?1",
                params!["doc-a"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seq, 2, "seq increments across snapshots");
    }

    #[test]
    fn state_vectors_persist_without_touching_the_update_log() {
        // The durable sync manifest: a state-vector-only write must NOT behave like
        // a snapshot. Truncating the log here would silently discard local CRDT
        // history that no snapshot covers.
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1, 2]).unwrap();
        idx.append_yjs_update("doc-a", &[3]).unwrap();

        idx.save_yjs_state_vectors(&[("doc-a".to_string(), vec![7, 7])])
            .unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.update_count, 2, "log survives a state-vector write");
        assert!(a.snapshot.is_none(), "no snapshot was invented");

        let manifest = idx.list_yjs_state_vectors().unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].doc_id, "doc-a");
        assert_eq!(manifest[0].state_vector, vec![7, 7]);
    }

    #[test]
    fn state_vector_write_preserves_an_existing_snapshot() {
        let idx = Index::open_in_memory().unwrap();
        idx.save_yjs_snapshot("doc-a", &[10, 20], &[1], None).unwrap();
        idx.save_yjs_state_vectors(&[("doc-a".to_string(), vec![2, 2])])
            .unwrap();

        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.snapshot, Some(vec![10, 20]), "snapshot untouched");
        let manifest = idx.list_yjs_state_vectors().unwrap();
        assert_eq!(manifest[0].state_vector, vec![2, 2], "vector advanced");
    }

    #[test]
    fn state_vector_manifest_is_batched_and_survives_rebuild() {
        let idx = Index::open_in_memory().unwrap();
        idx.save_yjs_state_vectors(&[
            ("a".to_string(), vec![1]),
            ("b".to_string(), vec![2]),
            ("c".to_string(), vec![3]),
        ])
        .unwrap();
        // `rebuild` only wipes the file-derived tables; CRDT state (and therefore
        // the manifest that makes a relaunch incremental) must survive it.
        let dir = tempfile::tempdir().unwrap();
        idx.rebuild(dir.path()).unwrap();

        let mut ids: Vec<String> = idx
            .list_yjs_state_vectors()
            .unwrap()
            .into_iter()
            .map(|r| r.doc_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // An empty batch is a no-op rather than an error.
        idx.save_yjs_state_vectors(&[]).unwrap();
        assert_eq!(idx.list_yjs_state_vectors().unwrap().len(), 3);
    }

    #[test]
    fn prune_yjs_docs_removes_only_unreachable_docs() {
        let idx = Index::open_in_memory().unwrap();
        let live_a_mark = idx.append_yjs_update("live-a", &[1, 2, 3]).unwrap();
        idx.append_yjs_update("live-b", &[4]).unwrap();
        let dead_mark = idx.append_yjs_update("dead", &[5, 6, 7, 8]).unwrap();
        idx.save_yjs_snapshot("dead", &[9; 64], &[1], Some(dead_mark))
            .unwrap();
        idx.append_yjs_update("dead", &[11]).unwrap();
        // Snapshotting truncates the doc's update log up to its watermark, so
        // append AFTER it to give live-a both halves — the state a doc edited
        // since its last compaction is really in.
        idx.save_yjs_snapshot("live-a", &[7; 32], &[1], Some(live_a_mark))
            .unwrap();
        idx.append_yjs_update("live-a", &[10]).unwrap();

        let report = idx
            .prune_yjs_docs(&["live-a".to_string(), "live-b".to_string()])
            .unwrap();

        assert_eq!(report.docs_removed, 1, "only the unreachable snapshot goes");
        assert_eq!(report.updates_removed, 1, "only the unreachable update log goes");
        assert!(report.bytes_reclaimed >= 64);
        // The live docs keep BOTH halves of their state. A doc that lost its
        // update log but kept its snapshot would silently lose recent edits.
        assert_eq!(idx.load_yjs_state("live-a").unwrap().update_count, 1);
        assert!(idx.load_yjs_state("live-a").unwrap().snapshot.is_some());
        assert_eq!(idx.load_yjs_state("live-b").unwrap().update_count, 1);
        let gone = idx.load_yjs_state("dead").unwrap();
        assert!(gone.snapshot.is_none() && gone.updates.is_empty());
    }

    #[test]
    fn prune_yjs_docs_refuses_an_empty_live_set() {
        // "I know of no live docs" is what a caller looks like when its registry
        // map failed to load. Obeying it would erase every unsynced edit in the
        // vault, so this must be an error and not a very efficient wipe.
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1, 2]).unwrap();
        assert!(idx.prune_yjs_docs(&[]).is_err());
        assert_eq!(idx.load_yjs_state("doc-a").unwrap().update_count, 1);
    }

    #[test]
    fn clear_yjs_doc_drops_both_halves_of_one_doc() {
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("target", &[1, 2]).unwrap();
        idx.save_yjs_snapshot("target", &[3; 16], &[1], None).unwrap();
        idx.append_yjs_update("target", &[4]).unwrap();
        idx.append_yjs_update("bystander", &[5]).unwrap();

        idx.clear_yjs_doc("target").unwrap();

        let cleared = idx.load_yjs_state("target").unwrap();
        assert!(cleared.snapshot.is_none() && cleared.updates.is_empty());
        assert_eq!(idx.load_yjs_state("bystander").unwrap().update_count, 1);
    }

    #[test]
    fn yjs_state_survives_rebuild() {
        let (_tmp, v) = seed_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        idx.append_yjs_update("doc-a", &[5, 6, 7]).unwrap();
        // A full re-index wipes the file-derived tables but must not drop CRDT state.
        idx.rebuild(&v).unwrap();
        let a = idx.load_yjs_state("doc-a").unwrap();
        assert_eq!(a.updates, vec![vec![5, 6, 7]]);
    }

    // ---- Tier 2: files ----------------------------------------------------

    /// Seed a vault with one of each: a note, two tree binaries, and an
    /// attachment (which must NEVER be indexed — see `vault::INDEX_ATTACHMENTS`).
    fn seed_files_vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().to_path_buf();
        crate::notefile::write_note(&v, "Note.md", "# Note\n\nplain prose").unwrap();
        std::fs::write(v.join("data.csv"), "region,total\nnorth,42\n").unwrap();
        std::fs::write(v.join("clip.mp4"), b"\x00\x00\x00 ftypmp42").unwrap();
        std::fs::create_dir_all(v.join("attachments")).unwrap();
        std::fs::write(v.join("attachments/a1b2c3.png"), b"\x89PNG").unwrap();
        (tmp, v)
    }

    fn file_paths(idx: &Index) -> Vec<String> {
        idx.file_rows()
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect()
    }

    #[test]
    fn rebuild_indexes_notes_and_files_and_prunes_both() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        let pending = idx.rebuild(&v).unwrap();

        assert_eq!(
            idx.list_note_titles()
                .unwrap()
                .into_iter()
                .map(|n| n.path)
                .collect::<Vec<_>>(),
            vec!["Note.md".to_string()],
            "only the note family gets `notes` rows — a binary in there would be \
             registered as a CRDT note"
        );
        assert_eq!(
            file_paths(&idx),
            vec!["clip.mp4".to_string(), "data.csv".to_string()],
            "the attachments store is deliberately absent"
        );
        // Both are handed to the worker; nothing was parsed here.
        assert_eq!(pending.len(), 2);
        assert!(idx
            .file_rows()
            .unwrap()
            .iter()
            .all(|f| f.text_status == "pending"));

        // Both tiers prune on the next pass.
        std::fs::remove_file(v.join("data.csv")).unwrap();
        std::fs::remove_file(v.join("Note.md")).unwrap();
        idx.rebuild(&v).unwrap();
        assert!(idx.list_note_titles().unwrap().is_empty());
        assert_eq!(file_paths(&idx), vec!["clip.mp4".to_string()]);
    }

    /// `files.id` is identity, exactly like `notes.id`: the server half of PR3
    /// registers these ids, so a reopen that re-minted them would fork every
    /// binary in the vault.
    #[test]
    fn file_ids_survive_rebuild() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let before: Vec<(String, String)> = idx
            .file_rows()
            .unwrap()
            .into_iter()
            .map(|f| (f.path, f.id))
            .collect();

        // A content change must not re-mint the id either.
        std::fs::write(v.join("data.csv"), "region,total\nsouth,7\n").unwrap();
        idx.rebuild(&v).unwrap();
        let after: Vec<(String, String)> = idx
            .file_rows()
            .unwrap()
            .into_iter()
            .map(|f| (f.path, f.id))
            .collect();
        assert_eq!(before, after);
    }

    /// A rebuild that changes nothing must not re-queue every binary — that is
    /// the `pending` gate, and without it every launch would re-hash the vault.
    #[test]
    fn an_unchanged_file_is_not_requeued() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        // Pretend the worker finished with both.
        for path in file_paths(&idx) {
            idx.store_file_text(&path, "sha-for-tests", "body", "ok", false)
                .unwrap();
        }
        assert!(
            idx.rebuild(&v).unwrap().is_empty(),
            "nothing moved on disk, so nothing needs extracting"
        );

        std::fs::write(v.join("data.csv"), "region,total\nwest,9\n").unwrap();
        assert_eq!(
            idx.rebuild(&v).unwrap(),
            vec![v.join("data.csv")],
            "changed bytes DO re-queue"
        );
    }

    #[test]
    fn search_merges_both_tables_and_tags_kind() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        idx.store_file_text("data.csv", "sha-csv", "sardonic marmalade totals", "ok", true)
            .unwrap();
        crate::notefile::write_note(&v, "Note.md", "# Note\n\nsardonic marmalade").unwrap();
        idx.index_note(&v, &v.join("Note.md")).unwrap();

        let hits = idx.search_all("marmalade").unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(
            (hits[0].kind.as_str(), hits[0].path.as_str()),
            ("note", "Note.md"),
            "a note outranks a file on an equally good match"
        );
        assert_eq!(hits[1].kind, "file");
        assert_eq!(hits[1].path, "data.csv");
        assert_eq!(hits[1].ext.as_deref(), Some("csv"));
        assert!(hits[1].snippet.contains("<mark>marmalade</mark>"));

        // A file with no body at all is still findable by its name.
        let by_name = idx.search_all("clip").unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].kind, "file");
        assert_eq!(by_name[0].ext.as_deref(), Some("mp4"));

        // `search_notes` stays the notes-only entry point.
        let notes_only = idx.search_notes("marmalade").unwrap();
        assert_eq!(notes_only.len(), 1);
        assert_eq!(notes_only[0].kind, "note");
    }

    /// The companion to `fts_snippet_html_escapes_body_to_prevent_xss`, for
    /// bodies that did not come from a text file. `index.rs` marks its snippets
    /// with U+0001/U+0002 sentinels; a binary-derived body can contain those
    /// bytes literally, and one of them would open a `<mark>` nothing closes in
    /// the panel's `dangerouslySetInnerHTML`. `extract.rs` strips them, and this
    /// pins the whole path end to end.
    #[test]
    fn files_fts_snippet_has_no_stray_mark_from_control_chars() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        // The sentinels sit BETWEEN words, as a real one would: stripping them
        // must not glue two tokens into one that no search would match.
        let hostile = "totals \u{1}marmalade\u{2} <script>alert(1)</script>\u{7}";
        let extracted = crate::extract::extract_text(
            &v.join("data.csv"),
            "csv",
            hostile.as_bytes(),
        );
        idx.store_file_text("data.csv", "sha-csv", &extracted.text, "ok", true)
            .unwrap();

        let hits = idx.search_all("marmalade").unwrap();
        assert_eq!(hits.len(), 1);
        let snippet = &hits[0].snippet;
        assert_eq!(
            snippet.matches("<mark>").count(),
            snippet.matches("</mark>").count(),
            "every highlight is balanced: {snippet}"
        );
        assert!(!snippet.contains("<script"), "the body is escaped: {snippet}");
        assert!(!snippet.contains('\u{1}') && !snippet.contains('\u{2}'));
    }

    /// The merge rule on its own: scores order the list, the file penalty breaks
    /// a tie, and the cap is honoured.
    #[test]
    fn merge_ranked_orders_by_score_and_prefers_notes_on_a_tie() {
        let hit = |kind: &str, path: &str, score: f64| RankedHit {
            score,
            result: SearchResult {
                id: path.to_string(),
                path: path.to_string(),
                title: path.to_string(),
                snippet: String::new(),
                kind: kind.to_string(),
                ext: None,
            },
        };
        // The file's raw score is identical; `search_files_ranked` adds the
        // penalty, which is what the caller here models.
        let merged = merge_ranked(
            vec![
                hit("file", "b.csv", -2.0 + FILE_RANK_PENALTY),
                hit("note", "a.md", -2.0),
                hit("file", "c.csv", -9.0 + FILE_RANK_PENALTY),
            ],
            10,
        );
        assert_eq!(
            merged.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
            vec!["c.csv", "a.md", "b.csv"],
            "a much better file hit still wins; an equal one does not"
        );
        assert_eq!(merge_ranked(vec![hit("note", "a.md", -1.0)], 0).len(), 0);
    }

    /// Cached text is keyed by content, so a copy costs nothing — and the sweep
    /// only takes what no row claims.
    #[test]
    fn file_text_is_shared_by_content_and_pruned_when_unclaimed() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        idx.store_file_text("data.csv", "sha-shared", "same bytes", "ok", true)
            .unwrap();
        assert_eq!(
            idx.cached_file_text("sha-shared").unwrap().as_deref(),
            Some("same bytes")
        );
        assert_eq!(idx.prune_file_text().unwrap(), 0, "still claimed");

        // The row moves to different bytes: its old text is now unreferenced.
        idx.store_file_text("data.csv", "sha-new", "new bytes", "ok", true)
            .unwrap();
        assert_eq!(idx.prune_file_text().unwrap(), 1);
        assert!(idx.cached_file_text("sha-shared").unwrap().is_none());
        assert!(idx.cached_file_text("sha-new").unwrap().is_some());
    }

    /// A write for a path with no row (deleted while the worker was parsing) is
    /// dropped rather than resurrecting it.
    #[test]
    fn store_file_text_refuses_a_path_with_no_row() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        assert!(!idx
            .store_file_text("gone.csv", "sha", "text", "ok", true)
            .unwrap());
    }

    /// `[[data.csv]]` should open the file, not dangle. The id it answers with
    /// is a `files.id` — the caller opens by PATH.
    #[test]
    fn resolve_wikilink_falls_back_to_a_file() {
        let (_tmp, v) = seed_files_vault();
        std::fs::create_dir_all(v.join("Reports")).unwrap();
        std::fs::write(v.join("Reports/q3.xlsx"), b"PK").unwrap();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();

        assert_eq!(
            idx.resolve_wikilink("q3.xlsx").unwrap().unwrap().path,
            "Reports/q3.xlsx"
        );
        assert_eq!(
            idx.resolve_wikilink("Reports/q3.xlsx").unwrap().unwrap().path,
            "Reports/q3.xlsx"
        );
        // A note still wins: the fallback is the LAST rule.
        assert_eq!(
            idx.resolve_wikilink("Note").unwrap().unwrap().path,
            "Note.md"
        );
        assert!(idx.resolve_wikilink("nothing.zip").unwrap().is_none());
    }

    /// The Health page's Index tile: the numbers exist and move with the text.
    #[test]
    fn file_text_footprint_counts_rows_and_bytes() {
        let (_tmp, v) = seed_files_vault();
        let idx = Index::open(&v).unwrap();
        idx.rebuild(&v).unwrap();
        let before = idx.file_text_footprint().unwrap();
        assert_eq!(before.files, 2);

        idx.store_file_text("data.csv", "sha-csv", &"x".repeat(1000), "ok", true)
            .unwrap();
        let after = idx.file_text_footprint().unwrap();
        assert!(
            after.bytes >= before.bytes + 2000,
            "the body is stored twice — the cache and the FTS table: {} → {}",
            before.bytes,
            after.bytes
        );
    }
}
