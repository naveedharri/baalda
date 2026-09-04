import * as Y from "yjs";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { loadDocState } from "../yjs/persistence.js";
import { cosineSimilarity, embed, tokenize } from "./embedder.js";

/**
 * Note indexing engine (spec: links + vectors).
 *
 * Whenever a note's Yjs doc is stored we (re)derive search + graph data:
 *   - extract the note's plain text from the shared Y.Text `content`,
 *   - parse `[[wikilink]]` references into note_links edges,
 *   - compute an embedding vector and upsert note_index.
 *
 * Indexing is debounced per doc so a burst of keystroke-sized updates collapses
 * into one DB write. note_index / note_links are a rebuildable cache derived
 * from the canonical Yjs state — see migration 005.
 */

type Queryable = Pick<pg.Pool, "query">;

/** The shared Y.Text that holds a note body (matches the desktop bridge). */
const CONTENT_FIELD = "content";

/** Default debounce window: collapse bursts of updates into one index write. */
const DEBOUNCE_MS = 2000;

// Per-doc pending timers (debounce). Keyed by docId.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Parse `[[wikilink]]` targets out of note text. Captures the title portion
 * only — the part before any `|` alias or `#` heading anchor — and trims it.
 * Duplicates within one doc are collapsed.
 */
export function parseWikilinks(text: string): string[] {
  const re = /\[\[([^\]|#]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

/** Decode a doc's stored Yjs state into its plain-text `content` body. */
export async function extractDocText(
  docId: string,
  db: Queryable = defaultPool,
): Promise<string> {
  const state = await loadDocState(docId, db);
  if (!state) return "";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText(CONTENT_FIELD).toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Index one note now (no debounce). Resolves the doc's vault + title from the
 * notes table, extracts its text, then upserts note_index and replaces the
 * doc's note_links rows. No-op for docs with no live note row (e.g. binary
 * files), so we never index things that aren't markdown notes.
 */
export async function indexDoc(
  docId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query<{
    vault_id: string;
    title: string | null;
    rel_path: string;
  }>(
    "SELECT vault_id, title, rel_path FROM notes WHERE id = $1 AND deleted_at IS NULL",
    [docId],
  );
  const note = rows[0];
  if (!note) {
    // No LIVE note row: the note was hard- or soft-deleted (or this doc is a
    // binary `files` row, which is never indexed). Either way any note_index /
    // note_links rows for it are stale, and this early return used to strand
    // them forever — the delete happens in the registry/MCP layer while a
    // debounced re-index can still fire afterwards. Purge here so the derived
    // tables self-heal no matter which path deleted the note.
    await purgeNoteIndex([docId], db);
    return false;
  }

  // Postgres rejects NUL in `text`; a single such byte in one note used to fail
  // that note's indexing forever (see `pgText`).
  const content = pgText(await extractDocText(docId, db));
  const title = pgText(note.title ?? relPathStem(note.rel_path));
  const links = parseWikilinks(content);
  // Embed title + body so a query matching the title still ranks the note.
  const vector = embed(`${title ?? ""}\n${content}`);

  await db.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content, vector, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (doc_id) DO UPDATE
       SET vault_id = EXCLUDED.vault_id,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           vector = EXCLUDED.vector,
           updated_at = now()`,
    [docId, note.vault_id, title, content, JSON.stringify(vector)],
  );

  // Replace this doc's link edges wholesale (cheap; a doc has few links).
  await db.query("DELETE FROM note_links WHERE from_doc = $1", [docId]);
  for (const toTitle of links) {
    await db.query(
      `INSERT INTO note_links (vault_id, from_doc, to_title)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_doc, to_title) DO NOTHING`,
      [note.vault_id, docId, toTitle],
    );
  }
  return true;
}

/**
 * Schedule a debounced (re)index for a doc. Called from the sync server's store
 * hook — repeated calls within the window reset the timer so only the last one
 * fires. Errors are logged, never thrown (indexing must not break sync).
 */
export function scheduleIndex(docId: string, delayMs: number = DEBOUNCE_MS): void {
  const existing = pending.get(docId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(docId);
    indexDoc(docId).catch((err) => {
      console.error(`[indexer] failed to index ${docId}:`, err);
    });
  }, delayMs);
  // Don't keep the event loop alive just for a pending index.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(docId, timer);
}

/**
 * Backfill: index any live note that has no note_index row yet, using its
 * already-stored Yjs state. Runs once on boot so existing docs become
 * searchable/graphable without waiting for a fresh edit. Best-effort — a
 * failure on one doc is logged and skipped. Returns the count indexed.
 */
export async function backfillIndex(db: Queryable = defaultPool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
       LEFT JOIN note_index ni ON ni.doc_id = n.id
      WHERE n.deleted_at IS NULL AND ni.doc_id IS NULL`,
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      if (await indexDoc(id, db)) count++;
    } catch (err) {
      console.error(`[indexer] backfill failed for ${id}:`, err);
    }
  }
  return count;
}

/**
 * Drop the derived index rows for a set of docs.
 *
 * note_index / note_links are a rebuildable cache derived from the canonical
 * Yjs state (migration 005), so deleting them loses nothing that a re-index
 * can't recompute. Doing so on delete matters twice over: note_index holds a
 * FULL PLAIN-TEXT COPY of the note body, so keeping it for a "deleted" note is
 * both unbounded table growth and a privacy problem.
 */
export async function purgeNoteIndex(
  docIds: string[],
  db: Queryable = defaultPool,
): Promise<void> {
  if (docIds.length === 0) return;
  await db.query("DELETE FROM note_index WHERE doc_id = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_links WHERE from_doc = ANY($1::text[])", [docIds]);
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * One ranked search hit. This shape is the API contract of BOTH
 * `GET /api/vaults/:vaultId/search` and the MCP `search_notes` tool — don't
 * change it without changing them together.
 */
export interface NoteSearchHit {
  docId: string;
  title: string;
  relPath: string;
  score: number;
}

/**
 * How many note_index rows to score per round trip. Only a doc id, a 256-float
 * vector and a small integer cross the wire per row (~2-3 KB), so a batch peaks
 * around 1 MB regardless of vault size. Note BODIES never leave Postgres.
 */
const SEARCH_BATCH = 500;

/**
 * Rank the notes of one vault against a query, keeping peak memory bounded.
 *
 * Ranking is unchanged from the original inline implementations in
 * http/routes/graph.ts and mcp/service.ts: `cosineSimilarity(embed(q), vector)`
 * plus a keyword boost of `0.1 * (matched distinct query tokens / total)`, then
 * sort by score descending and take the top `k`.
 *
 * What changed is HOW: those versions selected `ni.content` AND `ni.vector` for
 * every row in the vault with no LIMIT, so one search materialized every note
 * body and every embedding on the heap before slicing to k <= 100. Here:
 *
 *   1. the keyword-match count is computed in SQL (`position(token IN
 *      lower(title || ' ' || content))`), so bodies stay in the database;
 *   2. rows are walked in keyset-paginated batches ordered by doc_id, and only
 *      a `{docId, score}` pair is retained per note;
 *   3. titles and rel_paths are fetched afterwards for the <= k winners only.
 *
 * `readableDocIds` is pushed into the query rather than filtered afterwards, so
 * notes the caller may not read are never scored (they'd be a content oracle).
 *
 * Note on `lower()`: query tokens are ASCII by construction (`tokenize` yields
 * `[a-z0-9_]+`), and Postgres `lower()` matches JS `toLowerCase()` on ASCII, so
 * substring matching is equivalent for every realistic input. Exotic Unicode
 * that case-folds INTO ASCII (e.g. U+212A KELVIN SIGN) is the only place the two
 * could disagree, and only in the small keyword-boost term.
 */
export async function searchNoteIndex(opts: {
  vaultId: string;
  query: string;
  /** Max hits to return. Callers clamp this (search route <= 100, MCP <= 50). */
  k: number;
  /** Doc ids the caller may read — the candidate set. */
  readableDocIds: Iterable<string>;
  db?: Queryable;
}): Promise<NoteSearchHit[]> {
  const db = opts.db ?? defaultPool;
  if (opts.k <= 0) return [];
  const docIds = Array.from(opts.readableDocIds);
  if (docIds.length === 0) return [];

  const qVec = embed(opts.query);
  const qTokens = Array.from(new Set(tokenize(opts.query)));

  // Phase 1: score every candidate, retaining only id + score per note.
  const scored: Array<{ docId: string; score: number }> = [];
  let after = "";
  for (;;) {
    const { rows } = await db.query<{
      doc_id: string;
      vector: number[] | null;
      matched: number;
    }>(
      `SELECT ni.doc_id,
              ni.vector,
              (
                SELECT count(*) FROM unnest($4::text[]) AS t(tok)
                 WHERE position(t.tok IN lower(coalesce(ni.title, '') || ' ' || ni.content)) > 0
              )::int AS matched
         FROM note_index ni
         JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
        WHERE ni.vault_id = $1
          AND ni.doc_id = ANY($2::text[])
          AND ni.doc_id > $3
        ORDER BY ni.doc_id
        LIMIT $5`,
      [opts.vaultId, docIds, after, qTokens, SEARCH_BATCH],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const sim = r.vector ? cosineSimilarity(qVec, r.vector) : 0;
      const boost = qTokens.length > 0 ? 0.1 * (r.matched / qTokens.length) : 0;
      scored.push({ docId: r.doc_id, score: sim + boost });
    }
    after = rows[rows.length - 1].doc_id;
    if (rows.length < SEARCH_BATCH) break;
  }

  // Stable sort over doc_id-ordered input, so equal scores keep a deterministic
  // order (the previous version left ties at the database's arbitrary order).
  const top = scored.sort((a, b) => b.score - a.score).slice(0, opts.k);
  if (top.length === 0) return [];

  // Phase 2: fetch the display fields for the winners only.
  const { rows: metaRows } = await db.query<{
    doc_id: string;
    title: string | null;
    rel_path: string;
  }>(
    `SELECT ni.doc_id, ni.title, n.rel_path
       FROM note_index ni
       JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
      WHERE ni.doc_id = ANY($1::text[])`,
    [top.map((t) => t.docId)],
  );
  const meta = new Map(metaRows.map((r) => [r.doc_id, r]));

  const hits: NoteSearchHit[] = [];
  for (const t of top) {
    const m = meta.get(t.docId);
    if (!m) continue; // deleted between the two phases
    hits.push({
      docId: t.docId,
      title: m.title ?? relPathStem(m.rel_path),
      relPath: m.rel_path,
      score: t.score,
    });
  }
  return hits;
}

/** Filename stem of a rel_path, used as a fallback title. */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}
