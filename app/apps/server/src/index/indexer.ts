import * as Y from "yjs";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { loadDocState } from "../yjs/persistence.js";
import { purgeBlobRefs, replaceBlobRefs } from "../blobs/refs.js";
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

  // Which attachments this note points at (migration 027). Derived from the
  // SAME text `note_index.content` was just written from, so the two can never
  // disagree about what the note says, and written here because this is the one
  // place that sees a note's markdown after every edit.
  await replaceBlobRefs(docId, note.vault_id, content, db);

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
 * Run every pending debounced index NOW, and wait for it.
 *
 * A test hook, and the reason the bulk `docs/batch` path may hand its docs to
 * {@link scheduleIndex} instead of awaiting {@link indexDoc} per item: search is
 * eventually consistent on that path, so a test that wants to observe
 * `note_index` after a batch push asks for the queue to be flushed rather than
 * forcing the request path to pay for a second CRDT load per doc.
 *
 * Sequential on purpose — the same shape the timers would have had, and it must
 * not open 100 pool connections at once. New work scheduled WHILE this runs is
 * not awaited (its own timer still fires), so callers that need a quiet point
 * flush after the writes have settled.
 */
export async function flushIndexQueue(): Promise<void> {
  const ids = [...pending.keys()];
  for (const id of ids) {
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
  }
  for (const id of ids) {
    try {
      await indexDoc(id);
    } catch (err) {
      console.error(`[indexer] failed to index ${id}:`, err);
    }
  }
}

/**
 * Backfill: index any live note whose derived row is MISSING or STALE, using its
 * already-stored Yjs state. Runs once on boot so existing docs become
 * searchable/graphable without waiting for a fresh edit. Best-effort — a
 * failure on one doc is logged and skipped. Returns the count indexed.
 *
 * "Stale" (`note_index.updated_at < notes.updated_at`) is the other half, and it
 * is what makes {@link scheduleIndex}'s debounce safe to lean on: the bulk
 * `docs/batch` path defers its re-index by {@link DEBOUNCE_MS}, so a deploy or a
 * crash inside that window would otherwise leave a doc that ALREADY had a row
 * describing its previous body — forever, since a missing-row backfill cannot
 * see it and nothing re-indexes it until the next edit. Both timestamps are
 * written by the same edit (the stamp in `versions/capture.ts`, then this
 * module), so an up-to-date row is strictly the newer of the two and is left
 * alone.
 */
export async function backfillIndex(db: Queryable = defaultPool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
       LEFT JOIN note_index ni ON ni.doc_id = n.id
      WHERE n.deleted_at IS NULL
        AND (ni.doc_id IS NULL OR ni.updated_at < n.updated_at)`,
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
  // A deleted note references nothing. Leaving its rows would keep every
  // attachment it ever embedded permanently uncollectable — the exact shape of
  // leak `blob_refs` exists to close.
  await purgeBlobRefs(docIds, db);
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * One ranked search hit. This shape is the API contract of BOTH
 * `GET /api/vaults/:vaultId/search` and the MCP `search_notes` tool — don't
 * change it without changing them together.
 *
 * A hit is a NOTE (ranked from `note_index`, the Yjs body) or a FILE (ranked
 * from `blob_text`, the words a desktop extracted out of a docx/xlsx/pdf/…).
 * `kind` is how a caller tells them apart; `blobId` and `ext` are only on file
 * hits, and `docId` is null for the one kind of file that has no doc of its own
 * — a hash-named `attachments/` drop.
 */
export interface NoteSearchHit {
  docId: string | null;
  title: string;
  relPath: string;
  score: number;
  kind: "note" | "file";
  /** File hits only: the blob whose text matched (fetch it via /api/blobs/:id). */
  blobId?: string;
  /** File hits only: lowercase extension without the dot, e.g. `xlsx`. */
  ext?: string;
}

/**
 * How many note_index rows to score per round trip. Only a doc id, a 256-float
 * vector and a small integer cross the wire per row (~2-3 KB), so a batch peaks
 * around 1 MB regardless of vault size. Note BODIES never leave Postgres.
 */
const SEARCH_BATCH = 500;

/**
 * How many `blob_text` rows one query may score.
 *
 * Files are capped where notes are not, and the asymmetry is deliberate: a
 * note's body is a few KB and a `blob_text` row is up to a megabyte, so the
 * `position(token IN lower(content))` pass costs orders of magnitude more per
 * row. A vault with tens of thousands of indexed files would otherwise turn one
 * search into a full scan of all of them. Bodies still never leave Postgres.
 */
const FILE_SEARCH_CAP = 2000;

/** Lowercase extension of a path, without the dot (`""` when there is none). */
function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

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
 * The same rule governs the FILE pass — see `searchBlobText`.
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
  /**
   * Also rank the vault's FILES (`blob_text`). Default true. The one caller
   * that turns it off is MCP's `search_notes` with `includeFiles: false`.
   */
  includeFiles?: boolean;
  /**
   * Does the caller hold vault-wide read? It decides one thing and only one:
   * whether the hash-named `attachments/` blobs — which have no doc of their
   * own to resolve — are in the file candidate set. Mirrors
   * `permissions/http-gates.ts canReadAttachment`'s vault-wide branch, which is
   * the same answer the download route gives for those blobs. A scoped member
   * never scores them; running the LIKE-per-note reference test over a search's
   * whole candidate set is not something a request path can afford.
   */
  vaultWideReader?: boolean;
  db?: Queryable;
}): Promise<NoteSearchHit[]> {
  const db = opts.db ?? defaultPool;
  if (opts.k <= 0) return [];
  const docIds = Array.from(opts.readableDocIds);
  const includeFiles = opts.includeFiles !== false;
  // No readable docs AND no vault-wide reach: nothing to score at all. (A
  // vault-wide reader with an empty note set can still match an attachment.)
  if (docIds.length === 0 && !(includeFiles && opts.vaultWideReader)) return [];

  const qVec = embed(opts.query);
  const qTokens = Array.from(new Set(tokenize(opts.query)));

  // Phase 1: score every candidate, retaining only id + score per note.
  const scored: Array<{ docId: string; score: number }> = [];
  let after = "";
  for (; docIds.length > 0; ) {
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

  const fileHits = includeFiles
    ? await searchBlobText({
        db,
        vaultId: opts.vaultId,
        qVec,
        qTokens,
        k: opts.k,
        readableDocIds: docIds,
        vaultWideReader: opts.vaultWideReader === true,
      })
    : [];

  // Stable sort over doc_id-ordered input, so equal scores keep a deterministic
  // order (the previous version left ties at the database's arbitrary order).
  const top = scored.sort((a, b) => b.score - a.score).slice(0, opts.k);
  if (top.length === 0) return fileHits.slice(0, opts.k);

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
      kind: "note",
    });
  }
  if (fileHits.length === 0) return hits;

  // One ranking, two sources. Notes win a TIE rather than being nudged by a
  // magic penalty term: the scores are comparable (same embedder, same keyword
  // boost), so the only place the two kinds need separating is where they are
  // equal — and there the note, whose text a person actually wrote, is the
  // better answer.
  return [...hits, ...fileHits]
    .sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === "note" ? -1 : 1))
    .slice(0, opts.k);
}

/**
 * The FILE half of {@link searchNoteIndex}: rank `blob_text` the same way.
 *
 * Same embedder, same keyword boost, same "bodies stay in Postgres" shape as
 * the note pass — `position(token IN lower(content))` is computed in SQL and
 * only a blob id, a vector and a small integer come back.
 *
 * VISIBILITY IS THE POINT, so it is in the WHERE clause and not a filter after
 * the fact. Two kinds of file, matching the two branches of
 * `canReadAttachment`:
 *
 *   · a registered tree file — `blobs.doc_id` (the live column, not the
 *     denormalised copy, so a blob that adopted its doc after its text was
 *     stored is still found) must be in the caller's readable set;
 *   · an `attachments/` drop with no doc — only for a vault-wide reader.
 *
 * Everything else is never scored, which is what keeps an unreadable file's
 * contents from influencing the ranking of a readable one (a content oracle:
 * "your query scored higher when I added a word that only appears in a file you
 * cannot see" is a slow read of that file).
 */
async function searchBlobText(opts: {
  db: Queryable;
  vaultId: string;
  qVec: number[];
  qTokens: string[];
  k: number;
  readableDocIds: string[];
  vaultWideReader: boolean;
}): Promise<NoteSearchHit[]> {
  const { rows } = await opts.db.query<{
    blob_id: string;
    doc_id: string | null;
    rel_path: string | null;
    filename: string | null;
    vector: number[] | null;
    matched: number;
  }>(
    `SELECT bt.blob_id,
            b.doc_id,
            b.rel_path,
            b.filename,
            bt.vector,
            (
              SELECT count(*) FROM unnest($3::text[]) AS t(tok)
               WHERE position(t.tok IN lower(coalesce(b.rel_path, '') || ' ' || bt.content)) > 0
            )::int AS matched
       FROM blob_text bt
       JOIN blobs b ON b.id = bt.blob_id AND b.status = 'ready'
      WHERE bt.vault_id = $1
        AND (
          (b.doc_id IS NOT NULL AND b.doc_id = ANY($2::text[]))
          OR (b.doc_id IS NULL AND $4::boolean)
        )
      ORDER BY bt.blob_id
      LIMIT $5`,
    [opts.vaultId, opts.readableDocIds, opts.qTokens, opts.vaultWideReader, FILE_SEARCH_CAP],
  );

  const scored = rows.map((r) => {
    const sim = r.vector ? cosineSimilarity(opts.qVec, r.vector) : 0;
    const boost = opts.qTokens.length > 0 ? 0.1 * (r.matched / opts.qTokens.length) : 0;
    const relPath = r.rel_path ?? "";
    return {
      docId: r.doc_id,
      blobId: r.blob_id,
      relPath,
      title: r.filename ?? (relPath ? (relPath.split("/").pop() ?? relPath) : r.blob_id),
      ext: extOf(relPath),
      score: sim + boost,
      kind: "file" as const,
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, opts.k);
}

/** Filename stem of a rel_path, used as a fallback title. */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}
