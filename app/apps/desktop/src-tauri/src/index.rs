//! The local SQLite index (spec 02 §3). A derived, rebuildable layer over the
//! `.md` files: FTS5 search, backlinks, tags, and the stable `doc_id` ↔ path map.
//!
//! Identity rule: notes are keyed by `doc_id` (a UUID), never by path. A full
//! rebuild preserves existing ids by matching on path, so reopening a vault
//! never forks a note's identity. On rename we update the path column by id, so
//! inbound links (which store `dst_note_id`) never break.

use crate::error::AppResult;
use crate::notefile::sha256_hex;
use crate::parse::parse_note;
use crate::vault::{is_ignored_name, rel_from_abs};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use uuid::Uuid;
use walkdir::WalkDir;

pub struct Index {
    conn: Connection,
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
        let idx = Index { conn };
        idx.migrate()?;
        Ok(idx)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        let idx = Index { conn };
        idx.migrate()?;
        Ok(idx)
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

    /// Full rebuild: index every `.md` under the vault, preserving existing ids
    /// by path, and drop rows for notes/folders that no longer exist.
    pub fn rebuild(&self, vault: &Path) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;

        // Existing path → id map (so identity survives a rebuild).
        let mut existing: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = tx.prepare("SELECT path, id FROM notes")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (p, i) = row?;
                existing.insert(p, i);
            }
        }

        // Wipe derived tables; we re-populate from disk.
        tx.execute_batch(
            "DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM note_tags;
             DELETE FROM links; DELETE FROM tags; DELETE FROM folders;",
        )?;

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
            let reuse_id = existing.get(&rel).cloned();
            self.index_one(&tx, vault, abs, reuse_id)?;
        }

        self.resolve_all_links(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Incrementally (re)index a single note by absolute path.
    pub fn index_note(&self, vault: &Path, abs: &Path) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let rel = rel_from_abs(vault, abs)?;
        let reuse_id = self.id_for_path(&tx, &rel)?;
        self.index_one(&tx, vault, abs, reuse_id)?;
        self.resolve_all_links(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Remove a note by absolute path, OR every note under a deleted folder
    /// (prefix match). Idempotent.
    pub fn remove_note(&self, vault: &Path, abs: &Path) -> AppResult<()> {
        let rel = rel_from_abs(vault, abs)?;
        let tx = self.conn.unchecked_transaction()?;

        // Exact-path note (a file delete).
        if let Some((id, rowid)) = self.row_for_path(&tx, &rel)? {
            Self::delete_note_rows(&tx, &id, rowid)?;
        }

        // Any notes under a deleted folder (prefix delete).
        let prefix = format!("{rel}/");
        let victims: Vec<(String, i64)> = {
            let mut stmt =
                tx.prepare("SELECT id, rowid FROM notes WHERE path LIKE ?1 || '%'")?;
            let rows = stmt.query_map(params![prefix], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, rowid) in victims {
            Self::delete_note_rows(&tx, &id, rowid)?;
        }
        tx.execute("DELETE FROM folders WHERE id = ?1 OR path LIKE ?2 || '%'", params![rel, prefix])?;

        self.resolve_all_links(&tx)?;
        tx.commit()?;
        Ok(())
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
            let mut stmt =
                tx.prepare("SELECT id, path FROM notes WHERE path LIKE ?1 || '%'")?;
            let rows = stmt.query_map(params![old_prefix], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, path) in children {
            let suffix = &path[old_prefix.len()..];
            let new_path = format!("{new_rel}/{suffix}");
            tx.execute("UPDATE notes SET path = ?1 WHERE id = ?2", params![new_path, id])?;
        }

        // Re-resolve links (a file rename can change the basename used to resolve).
        self.resolve_all_links(&tx)?;
        tx.commit()?;
        Ok(())
    }

    fn index_one(
        &self,
        tx: &Connection,
        vault: &Path,
        abs: &Path,
        reuse_id: Option<String>,
    ) -> AppResult<()> {
        let rel = rel_from_abs(vault, abs)?;
        let content = std::fs::read_to_string(abs)?;
        let stem = abs
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled");
        let parsed = parse_note(&content, stem);
        let sha = sha256_hex(&content);
        let mtime = std::fs::metadata(abs)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

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

        let rowid: i64 = tx.query_row("SELECT rowid FROM notes WHERE id = ?1", params![id], |r| {
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
            tx.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![tag])?;
            let tag_id: i64 =
                tx.query_row("SELECT id FROM tags WHERE name = ?1", params![tag], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
                params![id, tag_id],
            )?;
        }

        // Links (dst resolved later in resolve_all_links).
        tx.execute("DELETE FROM links WHERE src_note_id = ?1", params![id])?;
        for link in &parsed.links {
            tx.execute(
                "INSERT INTO links (src_note_id, dst_note_id, dst_path_raw, link_text, position)
                 VALUES (?1, NULL, ?2, ?3, ?4)",
                params![id, link.target, link.raw, link.position],
            )?;
        }

        Ok(())
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

    /// Recompute `dst_note_id` for every link by matching the raw target against
    /// note basenames (case-insensitive), then titles. Cheap enough for Phase 0
    /// and guarantees previously-dangling links resolve once a target appears.
    fn resolve_all_links(&self, tx: &Connection) -> AppResult<()> {
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

        // Resolve each link.
        let links: Vec<(i64, String)> = {
            let mut stmt = tx.prepare("SELECT id, dst_path_raw FROM links")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

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
            tx.execute(
                "UPDATE links SET dst_note_id = ?1 WHERE id = ?2",
                params![dst, link_id],
            )?;
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
    /// basename (case-insensitive), then by title. Mirrors `resolve_all_links`.
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

        let map = |r: &rusqlite::Row| Ok(ResolvedLink { id: r.get(0)?, path: r.get(1)? });

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
        let snapshot: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT snapshot FROM yjs_snapshot WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .optional()?;

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
        write_note(&v, "Alpha.md", "---\ntags: [project]\n---\n# Alpha\n\nLinks to [[Beta]] and #inline tag.").unwrap();
        write_note(&v, "sub/Beta.md", "# Beta\n\nThe quick brown fox. Back to [[Alpha]].").unwrap();
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
        assert!(!snip.contains("<img"), "no live <img> tag may survive: {snip}");
        assert!(!snip.contains("onerror=\"alert"), "no live handler may survive: {snip}");
        // The `"` around the handler is entity-escaped (proves the &-based
        // escaping path runs over the snippet).
        assert!(snip.contains("&quot;"), "raw \" must be escaped: {snip}");
        // The highlight markers are still present and are the only surviving tags.
        assert!(snip.contains("<mark>") && snip.contains("</mark>"), "highlight preserved: {snip}");
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
        write_note(&v, "moved/BetaRenamedFile.md", "# Beta\n\nMoved body [[Alpha]].").unwrap();
        std::fs::remove_file(v.join("sub/Beta.md")).unwrap();
        idx.rename_note(
            &v,
            &v.join("sub/Beta.md"),
            &v.join("moved/BetaRenamedFile.md"),
        )
        .unwrap();

        // The rule: rename preserves doc_id (identity never forks).
        let moved = idx.get_note_meta("moved/BetaRenamedFile.md").unwrap().unwrap();
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

        idx.save_yjs_snapshot("doc-a", &[10, 20, 30], &[40]).unwrap();

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
