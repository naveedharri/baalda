//! The local SQLite index (spec 02 §3). A derived, rebuildable layer over the
//! `.md` files: FTS5 search, backlinks, tags, and the stable `doc_id` ↔ path map.
//!
//! Identity rule: notes are keyed by `doc_id` (a UUID), never by path. The
//! open-time `rebuild` reconciles against the `.md` files incrementally,
//! preserving existing ids by matching on path, so reopening a vault never
//! forks a note's identity. On rename we update the path column by id, so
//! inbound links (which store `dst_note_id`) never break.

use crate::error::{AppError, AppResult};
use crate::notefile::sha256_hex;
use crate::parse::parse_note;
use crate::vault::{is_ignored_name, rel_from_abs};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;
use walkdir::WalkDir;

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

pub struct Index {
    conn: Connection,
    /// Test-only: how many times `resolve_links` has run. The entire point of
    /// the batch entry points is ONE link pass per batch instead of one per file,
    /// and that difference is only observable by counting.
    #[cfg(test)]
    resolve_calls: std::cell::Cell<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub path: String,
    pub title: String,
    pub snippet: String,
}

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
        std::fs::create_dir_all(&context_dir)?;
        let db_path = context_dir.join("index.sqlite");
        let conn = Connection::open(db_path)?;
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
        }
    }

    /// Test-only accessor for the link-pass counter (see `resolve_calls`).
    #[cfg(test)]
    fn resolve_call_count(&self) -> usize {
        self.resolve_calls.get()
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
            "#,
        )?;
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
    pub fn rebuild(&self, vault: &Path) -> AppResult<()> {
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

        let mut seen_notes: HashSet<String> = HashSet::new();
        let mut seen_folders: HashSet<String> = HashSet::new();
        let mut changed = false;

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
                    seen_folders.insert(rel_from_abs(vault, abs)?);
                    self.upsert_folder(&tx, vault, abs)?;
                }
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            if !name.to_lowercase().ends_with(".md") {
                continue;
            }
            let rel = rel_from_abs(vault, abs)?;
            let disk_mtime = file_mtime(abs);
            seen_notes.insert(rel.clone());

            match indexed.get(&rel) {
                // Unchanged since the last index — skip the read + parse.
                Some((_, mtime, _)) if *mtime == disk_mtime => {}
                // Changed — re-index in place, preserving the doc_id.
                Some((id, _, _)) => {
                    self.index_one(&tx, vault, abs, Some(id.clone()))?;
                    touched += 1;
                    changed = true;
                }
                // New file.
                None => {
                    self.index_one(&tx, vault, abs, None)?;
                    touched += 1;
                    changed = true;
                }
            }
        }

        // Drop notes whose files are gone from disk.
        for (path, (id, _, rowid)) in &indexed {
            if !seen_notes.contains(path) {
                Self::delete_note_rows(&tx, id, *rowid)?;
                changed = true;
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
            changed = true;
        }

        // Link targets only need re-resolving when the note set changed. Full
        // scope: `rebuild` has just rewritten every note, so there is no smaller
        // set to narrow to.
        if changed {
            self.resolve_links(&tx, LinkScope::All)?;
        }
        tx.commit()?;
        log_batch("rebuild", touched, started);
        Ok(())
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
    pub fn index_notes(
        &self,
        vault: &Path,
        abs_paths: &[PathBuf],
    ) -> AppResult<Vec<(PathBuf, AppError)>> {
        if abs_paths.is_empty() {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let tx = self.conn.unchecked_transaction()?;
        let mut failures: Vec<(PathBuf, AppError)> = Vec::new();
        let mut touched: Vec<String> = Vec::with_capacity(abs_paths.len());
        for abs in abs_paths {
            let outcome = rel_from_abs(vault, abs)
                .and_then(|rel| self.id_for_path(&tx, &rel))
                .and_then(|reuse_id| self.index_one(&tx, vault, abs, reuse_id));
            match outcome {
                Ok(id) => touched.push(id),
                Err(e) => failures.push((abs.clone(), e)),
            }
        }
        // The single pass the whole batch shares, narrowed to the notes it wrote.
        if !touched.is_empty() {
            self.resolve_links(&tx, LinkScope::Touched(&touched))?;
        }
        tx.commit()?;
        log_batch("index_notes", abs_paths.len(), started);
        Ok(failures)
    }

    /// Incrementally (re)index a single note by absolute path — a one-element
    /// [`Index::index_notes`], so the two paths can never drift.
    pub fn index_note(&self, vault: &Path, abs: &Path) -> AppResult<()> {
        let mut failures = self.index_notes(vault, &[abs.to_path_buf()])?;
        match failures.pop() {
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
    ) -> AppResult<String> {
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
        Ok(id)
    }

    /// Returns the note id it wrote, so a batch can tell `resolve_links` exactly
    /// which notes it touched (see `LinkScope`).
    fn index_one(
        &self,
        tx: &Connection,
        vault: &Path,
        abs: &Path,
        reuse_id: Option<String>,
    ) -> AppResult<String> {
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
            eprintln!(
                "[index] {} is {:.1} MB (> {} MB cap): indexing title only, skipping body + links",
                rel,
                size as f64 / (1024.0 * 1024.0),
                MAX_INDEX_BYTES / (1024 * 1024)
            );
            return self.index_oversized(tx, &rel, stem, mtime, reuse_id);
        }

        let content = std::fs::read_to_string(abs)?;
        let parsed = parse_note(&content, stem);
        let sha = sha256_hex(&content);

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

        Ok(id)
    }

    fn upsert_folder(&self, tx: &Connection, vault: &Path, abs: &Path) -> AppResult<()> {
        let rel = rel_from_abs(vault, abs)?;
        if rel.is_empty() {
            return Ok(());
        }
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

    /// FTS5 MATCH search with a highlighted snippet of the body.
    pub fn search_notes(&self, query: &str) -> AppResult<Vec<SearchResult>> {
        let match_query = build_fts_query(query);
        if match_query.is_empty() {
            return Ok(Vec::new());
        }
        // Delimit the highlight with control-char sentinels (U+0001/U+0002) that
        // can't occur in note text, so we can HTML-escape the whole snippet and
        // then swap the sentinels for real <mark> tags — see html_escape. This
        // makes the snippet safe to render as HTML (only <mark> survives) even
        // though the body is raw markdown.
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.path, n.title,
                    snippet(notes_fts, 1, char(1), char(2), '…', 12) AS snip
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
             WHERE notes_fts MATCH ?1
             ORDER BY bm25(notes_fts)
             LIMIT 100",
        )?;
        let rows = stmt.query_map(params![match_query], |r| {
            let raw: String = r.get(3)?;
            let snippet = html_escape(&raw)
                .replace('\u{1}', "<mark>")
                .replace('\u{2}', "</mark>");
            Ok(SearchResult {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                snippet,
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
        Ok(self
            .conn
            .query_row(
                "SELECT id, path FROM notes WHERE lower(title) = lower(?1) LIMIT 1",
                params![target],
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

    // ---- Local CRDT persistence (spec 02 §4) ------------------------------
    //
    // The append-only `yjs_updates` log + periodic `yjs_snapshot` per doc,
    // mirroring y-leveldb's "updates + separate state-vector" model. The
    // TS bridge owns the Yjs semantics; Rust is a dumb, durable byte store.

    /// Append one binary Yjs update to a doc's log.
    pub fn append_yjs_update(&self, doc_id: &str, update: &[u8]) -> AppResult<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO yjs_updates (doc_id, \"update\", created_at) VALUES (?1, ?2, ?3)",
            params![doc_id, update, now],
        )?;
        Ok(())
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

        let updates: Vec<Vec<u8>> = {
            let mut stmt = self
                .conn
                .prepare("SELECT \"update\" FROM yjs_updates WHERE doc_id = ?1 ORDER BY id ASC")?;
            let rows = stmt.query_map(params![doc_id], |r| r.get::<_, Vec<u8>>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let update_count = updates.len() as i64;
        Ok(YjsState {
            snapshot,
            updates,
            update_count,
        })
    }

    /// Write a doc's merged snapshot + state vector and truncate its update log,
    /// atomically in one transaction. The caller (TS bridge) encodes the snapshot
    /// from the fully-loaded doc, so the truncated updates are already folded in.
    pub fn save_yjs_snapshot(
        &self,
        doc_id: &str,
        snapshot: &[u8],
        state_vector: &[u8],
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
        tx.execute("DELETE FROM yjs_updates WHERE doc_id = ?1", params![doc_id])?;
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
        tx.execute_batch("DROP TABLE IF EXISTS _live_docs;")?;
        tx.commit()?;
        Ok(YjsPruneReport {
            docs_removed,
            updates_removed,
            bytes_reclaimed: snapshot_bytes + update_bytes,
        })
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
        tx.commit()?;
        Ok(())
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
fn log_batch(label: &str, files: usize, started: Instant) {
    if files < BATCH_LOG_MIN {
        return;
    }
    let ms = started.elapsed().as_millis();
    eprintln!(
        "[index] {label}: {files} files in {ms} ms ({:.2} ms/file)",
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
        assert!(idx_b.index_notes(&vb, &abs_b).unwrap().is_empty());

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

        // The old shape, for contrast: one pass per file.
        for one in &abs {
            idx.index_note(&v, one).unwrap();
        }
        assert_eq!(idx.resolve_call_count(), 1 + abs.len());

        // Removals batch the same way.
        idx.remove_notes(&v, &abs).unwrap();
        assert_eq!(idx.resolve_call_count(), 2 + abs.len());

        // An empty batch does no work at all (no transaction, no pass).
        let before = idx.resolve_call_count();
        assert!(idx.index_notes(&v, &[]).unwrap().is_empty());
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

        let failures = idx.index_notes(&v, &abs).unwrap();
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
    fn yjs_snapshot_truncates_only_its_own_log() {
        let idx = Index::open_in_memory().unwrap();
        idx.append_yjs_update("doc-a", &[1]).unwrap();
        idx.append_yjs_update("doc-a", &[2]).unwrap();
        idx.append_yjs_update("doc-b", &[7]).unwrap();

        idx.save_yjs_snapshot("doc-a", &[10, 20, 30], &[40])
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
    fn yjs_snapshot_overwrites_and_bumps_seq() {
        let idx = Index::open_in_memory().unwrap();
        idx.save_yjs_snapshot("doc-a", &[1], &[1]).unwrap();
        // Updates after the first snapshot, then re-snapshot.
        idx.append_yjs_update("doc-a", &[99]).unwrap();
        idx.save_yjs_snapshot("doc-a", &[2, 2], &[2]).unwrap();

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
        idx.save_yjs_snapshot("doc-a", &[10, 20], &[1]).unwrap();
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
        idx.append_yjs_update("live-a", &[1, 2, 3]).unwrap();
        idx.append_yjs_update("live-b", &[4]).unwrap();
        idx.append_yjs_update("dead", &[5, 6, 7, 8]).unwrap();
        idx.save_yjs_snapshot("dead", &[9; 64], &[1]).unwrap();
        idx.append_yjs_update("dead", &[11]).unwrap();
        // Snapshotting truncates the doc's update log, so append AFTER it to
        // give live-a both halves — the state a doc edited since its last
        // compaction is really in.
        idx.save_yjs_snapshot("live-a", &[7; 32], &[1]).unwrap();
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
        idx.save_yjs_snapshot("target", &[3; 16], &[1]).unwrap();
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
}
