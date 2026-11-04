import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { DocCrypto } from "../crypto/doc-crypto.js";
import {
  indexCryptoFor,
  openBlobScoreRow,
  openBlobTextRow,
  openScoreRow,
  openSearchRow,
  sealScoreRow,
  sealSearchRow,
  type SealedScoreRow,
} from "./sealed-index.js";
import { KeyRequiredError, loadVkCheck } from "../crypto/transport.js";
import { vaultKeyCache } from "../crypto/key-cache.js";
import * as Y from "yjs";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { loadDocState } from "../yjs/persistence.js";
import { purgeBlobRefs, replaceBlobRefs } from "../blobs/refs.js";
import { cachedRefHeads, refText } from "../blobs/ref-windows.js";
import { cosineSimilarity, EMBED_DIM, embed, tokenize } from "./embedder.js";
import { loadPages, pageMatchCount, pageMatchCountWithPath, vocabMasks } from "./search-pages.js";
import { keywordMatchCount, searchTokenSet, sealedTokenSet } from "./search-tokens.js";

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

// Per-doc pending timers (debounce). Keyed by docId. `crypto` is a COPY of a
// key the scheduling request presented and the server verified (W3), held only
// until the run fires and zeroed right after; absent = background path.
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; crypto?: DocCrypto }>();
// Index runs whose timer already fired, so {@link flushIndexQueue} can wait for
// them too (a 0 ms schedule is usually mid-flight by the caller's next await).
const inFlight = new Set<Promise<void>>();

/**
 * Parse `[[wikilink]]` targets out of note text. Captures the title portion
 * only — the part before any `|` alias or `#` heading anchor — and trims it.
 * Duplicates within one doc are collapsed.
 *
 * A link is one line and must be CLOSED (`]]`, or an alias `|` / anchor `#`).
 * An unclosed `[[` — a JS array in a code block, a stray paste — used to
 * capture everything up to the next `]` across lines: a 34 KB "title" that
 * overflows the `note_links` primary key and failed the note's indexing on
 * every edit. Titles past WIKILINK_TITLE_MAX can't be a real note name and are
 * skipped for the same reason.
 */
export const WIKILINK_TITLE_MAX = 255;

export function parseWikilinks(text: string): string[] {
  const re = /\[\[([^\]|#\r\n]+)(?=\]\]|\||#)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (title && title.length <= WIKILINK_TITLE_MAX && !seen.has(title)) {
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
  crypto?: DocCrypto,
): Promise<string> {
  const state = await loadDocState(docId, db, crypto);
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
 * Finds the doc the sync server currently holds in memory, if any. Registered
 * once at startup (`index.ts`) so this module never imports the sync server.
 */
export type LiveDocLookup = (vaultId: string, docId: string) => Y.Doc | undefined;

let liveDocLookup: LiveDocLookup | null = null;

/**
 * Let {@link indexDoc} read a loaded doc's text straight from memory instead of
 * rebuilding a throwaway Y.Doc from Postgres. The loaded doc already holds every
 * persisted op (it was hydrated from the store and every later update went
 * through it), so its text is the same — or newer — than a reload would give.
 * `null` unregisters (tests).
 */
export function setLiveDocLookup(fn: LiveDocLookup | null): void {
  liveDocLookup = fn;
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
  /**
   * W3: a key the CURRENT request presented and the server verified (e.g. an
   * MCP token's own wrap), so a keyed vault's write is searchable with no
   * member connected. Never zeroed here; the caller owns it.
   */
  given?: DocCrypto,
): Promise<boolean> {
  const { rows } = await db.query<{
    vault_id: string;
    title: string | null;
    rel_path: string;
    started: string;
  }>(
    // `started` (database clock, as TEXT to keep microseconds): a queued
    // deferral older than this run is satisfied by it (see `clearSatisfied`).
    "SELECT vault_id, title, rel_path, clock_timestamp()::text AS started FROM notes WHERE id = $1 AND deleted_at IS NULL",
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

  // W3: a keyed vault indexes only with a key a connected member supplied
  // (process cache COPY, zeroed below). No key held: defer, writing nothing —
  // the existing row stays as it was and the next edit or connect re-indexes.
  if (given && given.vaultId === note.vault_id) {
    // Re-check the generation at run time: a debounced run fires after the
    // request, and a rotation in between must not seal under a retired key.
    // Any miss or failure falls through to the background path below (cached
    // key, else the queue), so a note is never dropped unindexed.
    const state = await loadVkCheck(note.vault_id, db);
    if (state && state.generation === given.generation) {
      try {
        const ok = await indexNoteRow(docId, note, given, db);
        await clearSatisfied(docId, note.started, db);
        return ok;
      } catch (err) {
        console.warn(`[indexer] keyed index of ${docId} failed, falling back:`, (err as Error).message);
      }
    }
  }
  const crypto = await indexCryptoFor(note.vault_id, db);
  if (crypto === null) {
    // Queue the doc so the key-arrival catch-up indexes exactly it (no vault
    // scan). `clock_timestamp()` so a re-queue during a drain is never
    // mistaken for the row the drain read (it deletes by queued_at).
    await db.query(
      `INSERT INTO index_pending (doc_id, vault_id, queued_at) VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (doc_id) DO UPDATE SET vault_id = EXCLUDED.vault_id, queued_at = EXCLUDED.queued_at`,
      [docId, note.vault_id],
    );
    if (vaultKeyCache.has(note.vault_id)) {
      // A key arrived between the lookup above and the INSERT: the arrival's
      // drain may already have read the queue, so ask for another pass.
      try {
        indexDeferredHook?.(note.vault_id);
      } catch (err) {
        console.error("[indexer] deferral hook failed:", err);
      }
    }
    return false;
  }
  try {
    const ok = await indexNoteRow(docId, note, crypto, db);
    if (crypto) await clearSatisfied(docId, note.started, db);
    return ok;
  } finally {
    crypto?.key.fill(0);
  }
}

/**
 * A keyed index just ran: a deferral queued BEFORE it started is satisfied, so
 * drop it rather than have the catch-up index the note a second time. A row
 * re-queued after `started` (a newer edit deferred meanwhile) is kept.
 */
async function clearSatisfied(docId: string, started: string, db: Queryable): Promise<void> {
  await db.query("DELETE FROM index_pending WHERE doc_id = $1 AND queued_at < $2::timestamptz", [docId, started]);
}

/** Told (vault id only) when a note was queued while a key is cached; see `setIndexDeferredHook`. */
let indexDeferredHook: ((vaultId: string) => void) | null = null;

/**
 * Registered by the crypto backfill (which imports this module, so the hook
 * runs the other way): a deferral that raced a key arrival kicks a drain.
 */
export function setIndexDeferredHook(fn: ((vaultId: string) => void) | null): void {
  indexDeferredHook = fn;
}

async function indexNoteRow(
  docId: string,
  note: { vault_id: string; title: string | null; rel_path: string },
  crypto: DocCrypto | undefined,
  db: Queryable,
): Promise<boolean> {
  // Postgres rejects NUL in `text`; a single such byte in one note used to fail
  // that note's indexing forever (see `pgText`).
  const live = liveDocLookup?.(note.vault_id, docId);
  const content = pgText(
    live ? live.getText(CONTENT_FIELD).toString() : await extractDocText(docId, db, crypto),
  );
  const title = pgText(note.title ?? relPathStem(note.rel_path));
  const links = parseWikilinks(content);
  // Embed title + body so a query matching the title still ranks the note.
  const vector = embed(`${title ?? ""}\n${content}`);

  // The excerpts the scoped attachment list reads instead of `content` (#343).
  const heads = await cachedRefHeads(note.vault_id, db);

  if (crypto) {
    const tokens = sealedTokenSet(`${title ?? ""} ${content}`) ?? null;
    // Keyed: content, vector and tokens go ONLY into the sealed `search_enc`
    // (and vector + tokens again into `search_score_enc`, what ranking opens).
    // The plaintext columns are not written, and never nulled here: an old row
    // keeps its stale plaintext until the separate null-out step (W3 rule).
    // `ref_text` is not written either: the attachment rule decides a sealed
    // row from its decrypted body in memory (`permissions/sealed-refs.ts`),
    // which is the same answer the excerpt gives.
    await db.query(
      `INSERT INTO note_index (doc_id, vault_id, title, updated_at, ref_heads, search_enc, search_score_enc)
       VALUES ($1, $2, $3, now(), $4::text[], $5, $6)
       ON CONFLICT (doc_id) DO UPDATE
         SET vault_id = EXCLUDED.vault_id,
             title = EXCLUDED.title,
             updated_at = now(),
             ref_heads = EXCLUDED.ref_heads,
             search_enc = EXCLUDED.search_enc,
             search_score_enc = EXCLUDED.search_score_enc`,
      [
        docId,
        note.vault_id,
        title,
        heads,
        sealSearchRow(crypto, docId, { body: content, vector, tokens }),
        sealScoreRow(crypto, docId, { vector, tokens }),
      ],
    );
  } else await db.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content, vector, updated_at, ref_text, ref_heads, search_tokens)
     VALUES ($1, $2, $3, $4, $5::jsonb, now(), $6, $7::text[], $8)
     ON CONFLICT (doc_id) DO UPDATE
       SET vault_id = EXCLUDED.vault_id,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           vector = EXCLUDED.vector,
           updated_at = now(),
           ref_text = EXCLUDED.ref_text,
           ref_heads = EXCLUDED.ref_heads,
           search_tokens = EXCLUDED.search_tokens`,
    [
      docId,
      note.vault_id,
      title,
      content,
      JSON.stringify(vector),
      refText(content, heads),
      heads,
      // Same string the old SQL matched against: title, a space, the body.
      searchTokenSet(`${title ?? ""} ${content}`),
    ],
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
export function scheduleIndex(docId: string, delayMs: number = DEBOUNCE_MS, given?: DocCrypto): void {
  const existing = pending.get(docId);
  if (existing) clearTimeout(existing.timer);
  // Keep the newest key: a keyless reschedule (trash restore) must not drop a
  // key an earlier write in the same window supplied.
  let crypto = existing?.crypto;
  if (given) {
    crypto?.key.fill(0);
    crypto = { vaultId: given.vaultId, key: Buffer.from(given.key), generation: given.generation };
  }
  const timer = setTimeout(() => {
    pending.delete(docId);
    void runIndex(docId, crypto);
  }, delayMs);
  // Don't keep the event loop alive just for a pending index.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(docId, { timer, crypto });
}

function runIndex(docId: string, crypto: DocCrypto | undefined): Promise<void> {
  const run: Promise<void> = indexDoc(docId, defaultPool, crypto)
    .then(() => undefined)
    .catch((err) => {
      console.error(`[indexer] failed to index ${docId}:`, err);
    })
    .finally(() => {
      crypto?.key.fill(0);
      inFlight.delete(run);
    });
  inFlight.add(run);
  return run;
}

/**
 * Run every pending debounced index NOW, and wait for it — plus any run whose
 * timer already fired and is still in flight.
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
  const entries = [...pending.entries()];
  for (const [id, { timer }] of entries) {
    clearTimeout(timer);
    pending.delete(id);
  }
  for (const [id, { crypto }] of entries) await runIndex(id, crypto);
  await Promise.all([...inFlight]);
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
        AND (ni.doc_id IS NULL OR ni.updated_at < n.updated_at)
        -- Already queued for a keyed vault's catch-up: re-deferring it here
        -- only rewrote the same row, ~20k upserts on every boot of a 20k vault.
        AND NOT EXISTS (SELECT 1 FROM index_pending p WHERE p.doc_id = n.id)`,
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
 * How many note_index rows to score per round trip. A row sends its vector and
 * token set (plaintext columns, or a compressed sealed score blob of ~1.5 KB),
 * so a batch is a few MB regardless of vault size. Note BODIES never leave
 * Postgres. Every batch re-sends the whole readable id list, so fewer, larger
 * batches: at 500, a 14k-note vault re-sent it 28 times per search.
 */
const SEARCH_BATCH = 2000;

/**
 * Sealed rows scored between yields to the event loop. Opening a score blob is
 * synchronous work; a 14k-note vault searched 20 times a minute by one AI
 * client held the loop for seconds at a time and slowed every other request
 * on the server (2026-11-02). Same results, other requests answered between.
 */
const SEARCH_YIELD_EVERY = 250;

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
  /**
   * `"sql"` forces the pre-068 keyword count computed in Postgres from the
   * note text (parity tests and benchmarks only). Default: score in the app
   * from `search_tokens`, falling back to SQL only for rows not yet re-indexed.
   */
  keywordMode?: "app" | "sql";
  /**
   * W3: the REQUEST's verified vault key for a keyed vault. A sealed row is
   * scored from its decrypted text/vector/tokens with the same formula; a
   * sealed row without a key throws {@link KeyRequiredError} (fail closed).
   */
  crypto?: DocCrypto;
  db?: Queryable;
}): Promise<NoteSearchHit[]> {
  if (opts.k <= 0) return [];
  const docIds = Array.from(opts.readableDocIds);
  const includeFiles = opts.includeFiles !== false;
  // No readable docs AND no vault-wide reach: nothing to score at all. (A
  // vault-wide reader with an empty note set can still match an attachment.)
  if (docIds.length === 0 && !(includeFiles && opts.vaultWideReader)) return [];

  const query: PassQuery = {
    qVec: embed(opts.query),
    qTokens: Array.from(new Set(tokenize(opts.query))),
    k: opts.k,
  };
  const scope: PassScope = {
    db: opts.db ?? defaultPool,
    vaultId: opts.vaultId,
    docIds,
    includeFiles,
    vaultWideReader: opts.vaultWideReader === true,
    legacySql: opts.keywordMode === "sql",
    crypto: opts.crypto,
  };
  // A keyed vault's search decrypts every candidate row, so concurrent ones
  // share a pass (see `joinPass`). A plaintext vault scores in SQL and the
  // database, not this process, carries the load.
  if (!opts.crypto || opts.db) return (await searchPass(scope, [query]))[0];
  return joinPass(scope, query);
}

/** One query inside a search pass. */
interface PassQuery {
  qVec: number[];
  qTokens: string[];
  k: number;
}

/** What every query in one pass shares: the vault, the readable set, the
 *  flags, and a verified key that stays live until the pass settles. */
interface PassScope {
  db: Queryable;
  vaultId: string;
  docIds: string[];
  includeFiles: boolean;
  vaultWideReader: boolean;
  legacySql: boolean;
  crypto?: DocCrypto;
}

interface PassWaiter {
  scope: PassScope;
  query: PassQuery;
  resolve: (hits: NoteSearchHit[]) => void;
  reject: (err: unknown) => void;
}

/** Queries one shared pass scores at most. Each adds only its own scoring per
 *  row; reading and opening the rows is paid once. */
const SEARCH_PASS_MAX = 8;

/** Waiting searches per pass key, present while that key has a pass running. */
const passQueues = new Map<string, PassWaiter[]>();

/**
 * Same vault, same key generation, same readable set, same flags: searches with
 * an equal key would read exactly the same rows, so they may share a pass.
 */
function passKey(scope: PassScope): string {
  const h = createHash("sha256");
  h.update(`${scope.vaultId}\0${scope.crypto?.generation ?? ""}\0${scope.includeFiles}\0${scope.vaultWideReader}\0${scope.legacySql}\0`);
  for (const id of [...scope.docIds].sort()) h.update(`${id}\0`);
  return h.digest("base64");
}

/**
 * A keyed search joins whatever pass its key has queued. The first one starts
 * at once; searches arriving while a pass runs wait for the next, which scores
 * up to {@link SEARCH_PASS_MAX} of them over ONE read of the vault's rows. One
 * AI client sent 15 searches of a 14k-note vault at once and each took ~50 s,
 * every one fetching and opening every row (2026-11-02). Nothing outlives the
 * pass: no decrypted row is kept, and the readable set is still the caller's.
 */
function joinPass(scope: PassScope, query: PassQuery): Promise<NoteSearchHit[]> {
  const key = passKey(scope);
  return new Promise((resolve, reject) => {
    const waiter = { scope, query, resolve, reject };
    const queue = passQueues.get(key);
    if (queue) {
      queue.push(waiter);
      return;
    }
    const fresh = [waiter];
    passQueues.set(key, fresh);
    void drainPasses(key, fresh);
  });
}

async function drainPasses(key: string, queue: PassWaiter[]): Promise<void> {
  try {
    while (queue.length > 0) {
      // The batch is taken once a slot is free, so searches that arrived
      // during the wait ride along.
      await withPassSlot(async () => {
        const batch = queue.splice(0, SEARCH_PASS_MAX);
        try {
          // The first waiter's key is the one used: its caller zeroes it only
          // after its promise settles, which is after this pass.
          const results = await searchPass(batch[0].scope, batch.map((w) => w.query));
          batch.forEach((w, i) => w.resolve(results[i]));
        } catch (err) {
          for (const w of batch) w.reject(err);
        }
      });
    }
  } finally {
    passQueues.delete(key);
  }
}

/**
 * Keyed search passes running at once, server-wide. A pass is CPU work in this
 * process (opening and scoring rows); past this many, more of them only slow
 * every other request down. A pass waiting for a slot keeps collecting
 * searches of its own vault, so the wait is shared too.
 */
const SEARCH_PASSES_AT_ONCE = 2;
let passesRunning = 0;
const passSlotWaiters: Array<() => void> = [];

async function withPassSlot<T>(run: () => Promise<T>): Promise<T> {
  if (passesRunning < SEARCH_PASSES_AT_ONCE) passesRunning++;
  else await new Promise<void>((resolve) => passSlotWaiters.push(resolve));
  try {
    return await run();
  } finally {
    // Handed straight to the next waiter, so a newcomer cannot take it first.
    const next = passSlotWaiters.shift();
    if (next) next();
    else passesRunning--;
  }
}

/** Searches of one vault waiting for a pass (tests). */
export function pendingSearchPasses(): number {
  return passQueues.size;
}

/**
 * Score every query in `queries` over one read of the scope's rows. Each
 * query's result is exactly what it would get alone: same formula, same
 * candidates, same tie order.
 */
async function searchPass(scope: PassScope, queries: PassQuery[]): Promise<NoteSearchHit[][]> {
  const { db, docIds, legacySql, crypto } = scope;
  // The SQL keyword count for plaintext rows, for every query at once: token
  // `flatTokens[i]` belongs to query `flatQuery[i]`.
  const flatTokens: string[] = [];
  const flatQuery: number[] = [];
  queries.forEach((q, qi) => {
    for (const t of q.qTokens) {
      flatTokens.push(t);
      flatQuery.push(qi);
    }
  });
  const boosted = (q: PassQuery, sim: number, matched: number) =>
    sim + (q.qTokens.length > 0 ? 0.1 * (matched / q.qTokens.length) : 0);

  // Phase 1: score every candidate, retaining only id + score per note.
  const scored: Array<Array<{ docId: string; score: number }>> = queries.map(() => []);
  const all = queries.map((_, qi) => qi);

  /** Score the rows of `ids` (doc_id order), one `emit` per row per query. */
  const scoreRows = async (ids: string[], emit: (qi: number, docId: string, score: number) => void) => {
    let after = "";
    for (; ids.length > 0; ) {
      const { rows } = await db.query<{
        doc_id: string;
        vector: number[] | null;
        search_tokens: string | null;
        matched_legacy: number[] | null;
        search_enc: Buffer | null;
        search_score_enc: Buffer | null;
        title: string | null;
      }>(
        // A sealed row with a score blob sends only that, never the body.
        `SELECT ni.doc_id,
                CASE WHEN ni.search_score_enc IS NULL THEN ni.search_enc END AS search_enc,
                ni.search_score_enc,
                ni.title,
                -- The plaintext columns only for a plaintext row: a sealed row
                -- keeps its pre-keying copy until the null-out, and scanning
                -- that (hundreds of MB on a big vault) for a result the sealed
                -- branch never reads made every search slow.
                CASE WHEN ni.search_enc IS NULL AND ni.search_score_enc IS NULL THEN ni.vector END AS vector,
                CASE WHEN $6::boolean OR ni.search_enc IS NOT NULL OR ni.search_score_enc IS NOT NULL THEN NULL
                     ELSE ni.search_tokens END AS search_tokens,
                -- One count per query, in query order.
                CASE WHEN ni.search_enc IS NULL AND ni.search_score_enc IS NULL AND (ni.search_tokens IS NULL OR $6::boolean) THEN ARRAY(
                  SELECT coalesce(c.n, 0)::int
                    FROM generate_series(0, $7::int - 1) AS g(i)
                    LEFT JOIN (
                      SELECT t.qi, count(*) AS n
                        FROM unnest($4::text[], $8::int[]) AS t(tok, qi)
                       WHERE position(t.tok IN lower(coalesce(ni.title, '') || ' ' || ni.content)) > 0
                       GROUP BY t.qi
                    ) c ON c.qi = g.i
                   ORDER BY g.i
                ) END AS matched_legacy
           FROM note_index ni
           JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
          WHERE ni.vault_id = $1
            AND ni.doc_id = ANY($2::text[])
            AND ni.doc_id > $3
          ORDER BY ni.doc_id
          LIMIT $5`,
        [scope.vaultId, ids, after, flatTokens, SEARCH_BATCH, legacySql, queries.length, flatQuery],
      );
      if (rows.length === 0) break;
      for (const [i, r] of rows.entries()) {
        if (i > 0 && i % SEARCH_YIELD_EVERY === 0) await yieldToEventLoop();
        let rest = all;
        let searchEnc = r.search_enc;
        if (r.search_score_enc) {
          if (!crypto) throw new KeyRequiredError();
          const s = openScoreOrNull(crypto, r.doc_id, r.search_score_enc);
          const needBody: number[] = [];
          for (const qi of all) {
            const q = queries[qi];
            // Answers alone unless unopenable, or the query has words and the
            // row has no token set (the pre-068 rule needs the body).
            if (s && Array.isArray(s.vector) && !(q.qTokens.length > 0 && (s.tokens === null || legacySql))) {
              const matched = q.qTokens.length > 0 ? keywordMatchCount(q.qTokens, s.tokens!) : 0;
              emit(qi, r.doc_id, boosted(q, cosineSimilarity(q.qVec, s.vector), matched));
            } else {
              needBody.push(qi);
            }
          }
          if (needBody.length === 0) continue;
          // Unopenable, or a row that needs its body: the full row, as before.
          rest = needBody;
          searchEnc = await fullSealedRow(db, r.doc_id);
        }
        if (searchEnc) {
          // Sealed row: same score from the decrypted fields. No token set means
          // the pre-068 rule, substring-counted over the same "title body" text.
          if (!crypto) throw new KeyRequiredError();
          const sealed = openSearchRow(crypto, r.doc_id, searchEnc);
          for (const qi of rest) {
            const q = queries[qi];
            const sim = sealed.vector ? cosineSimilarity(q.qVec, sealed.vector) : 0;
            const matched =
              sealed.tokens !== null && !legacySql
                ? keywordMatchCount(q.qTokens, sealed.tokens)
                : legacySubstringCount(q.qTokens, `${r.title ?? ""} ${sealed.body}`);
            emit(qi, r.doc_id, boosted(q, sim, matched));
          }
          continue;
        }
        for (const qi of rest) {
          const q = queries[qi];
          const sim = r.vector ? cosineSimilarity(q.qVec, r.vector) : 0;
          const matched =
            r.search_tokens !== null ? keywordMatchCount(q.qTokens, r.search_tokens) : (r.matched_legacy?.[qi] ?? 0);
          emit(qi, r.doc_id, boosted(q, sim, matched));
        }
      }
      after = rows[rows.length - 1].doc_id;
      if (rows.length < SEARCH_BATCH) break;
    }
  };

  // Keyed: rows on a fresh search page are scored from the page; the rest
  // (edited since the page was built, never paged, a page that did not open)
  // from their own rows, exactly as without pages.
  const pages = crypto && !legacySql && docIds.length > 0 ? await loadPages(db, "note", crypto) : null;
  if (!pages || pages.rows.size === 0) {
    await scoreRows(docIds, (qi, docId, score) => scored[qi].push({ docId, score }));
  } else {
    const { rows: live } = await db.query<{ doc_id: string; stamp: string }>(
      `SELECT ni.doc_id, ni.updated_at::text AS stamp
         FROM note_index ni
         JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
        WHERE ni.vault_id = $1 AND ni.doc_id = ANY($2::text[])
        ORDER BY ni.doc_id`,
      [scope.vaultId, docIds],
    );
    const stale = live.filter((r) => pages.rows.get(r.doc_id)?.stamp !== r.stamp).map((r) => r.doc_id);
    const fromRows = new Map<string, number[]>();
    await scoreRows(stale, (qi, docId, score) => {
      let s = fromRows.get(docId);
      if (!s) fromRows.set(docId, (s = new Array<number>(queries.length)));
      s[qi] = score;
    });
    const masks = pages.pages.map((page) => queries.map((q) => vocabMasks(page, q.qTokens)));
    const scratch = new Uint32Array(Math.max(1, ...queries.map((q) => Math.ceil(q.qTokens.length / 32))));
    // In doc_id order, the order the row walk scores in, so ties sort the same.
    for (const [i, r] of live.entries()) {
      if (i > 0 && i % SEARCH_YIELD_EVERY === 0) await yieldToEventLoop();
      const at = pages.rows.get(r.doc_id);
      if (at && at.stamp === r.stamp) {
        const page = pages.pages[at.page];
        const vec = page.vectors.subarray(at.row * EMBED_DIM, (at.row + 1) * EMBED_DIM) as unknown as number[];
        for (const qi of all) {
          const q = queries[qi];
          const matched = q.qTokens.length > 0 ? pageMatchCount(page, at.row, masks[at.page][qi], scratch) : 0;
          scored[qi].push({ docId: r.doc_id, score: boosted(q, cosineSimilarity(q.qVec, vec), matched) });
        }
        continue;
      }
      const s = fromRows.get(r.doc_id);
      if (!s) continue; // gone between the two reads
      for (const qi of all) if (s[qi] !== undefined) scored[qi].push({ docId: r.doc_id, score: s[qi] });
    }
  }

  const fileHits = scope.includeFiles
    ? await searchBlobText(scope, queries, flatTokens, flatQuery)
    : queries.map(() => [] as NoteSearchHit[]);

  // Stable sort over doc_id-ordered input, so equal scores keep a deterministic
  // order (the previous version left ties at the database's arbitrary order).
  const tops = scored.map((s, qi) => s.sort((a, b) => b.score - a.score).slice(0, queries[qi].k));
  const winners = Array.from(new Set(tops.flat().map((t) => t.docId)));

  // Phase 2: fetch the display fields for the winners only.
  const meta = new Map<string, { title: string | null; rel_path: string }>();
  if (winners.length > 0) {
    const { rows: metaRows } = await db.query<{
      doc_id: string;
      title: string | null;
      rel_path: string;
    }>(
      `SELECT ni.doc_id, ni.title, n.rel_path
         FROM note_index ni
         JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
        WHERE ni.doc_id = ANY($1::text[])`,
      [winners],
    );
    for (const r of metaRows) meta.set(r.doc_id, r);
  }

  return queries.map((q, qi) => {
    const top = tops[qi];
    if (top.length === 0) return fileHits[qi].slice(0, q.k);
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
    if (fileHits[qi].length === 0) return hits;

    // One ranking, two sources. Notes win a TIE rather than being nudged by a
    // magic penalty term: the scores are comparable (same embedder, same keyword
    // boost), so the only place the two kinds need separating is where they are
    // equal — and there the note, whose text a person actually wrote, is the
    // better answer.
    return [...hits, ...fileHits[qi]]
      .sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === "note" ? -1 : 1))
      .slice(0, q.k);
  });
}

/** A score blob opened, or null when it cannot be (search then opens the full row). */
function openScoreOrNull(crypto: DocCrypto, docId: string, sealed: Buffer): SealedScoreRow | null {
  try {
    return openScoreRow(crypto, docId, sealed);
  } catch {
    return null;
  }
}

async function fullSealedRow(db: Queryable, docId: string): Promise<Buffer | null> {
  const { rows } = await db.query<{ search_enc: Buffer | null }>(
    "SELECT search_enc FROM note_index WHERE doc_id = $1",
    [docId],
  );
  return rows[0]?.search_enc ?? null;
}

/** The pre-068 SQL rule in app memory: query tokens found as substrings of lower(text). */
function legacySubstringCount(qTokens: string[], text: string): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of qTokens) if (hay.includes(t)) n++;
  return n;
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
async function searchBlobText(
  scope: PassScope,
  queries: PassQuery[],
  flatTokens: string[],
  flatQuery: number[],
): Promise<NoteSearchHit[][]> {
  const { db, legacySql, crypto } = scope;
  const fullRows = (only: string[] | null) => db.query<{
    search_enc: Buffer | null;
    search_score_enc: Buffer | null;
    blob_id: string;
    doc_id: string | null;
    rel_path: string | null;
    filename: string | null;
    vector: number[] | null;
    search_tokens: string | null;
    matched_legacy: number[] | null;
  }>(
    // A sealed row with a score blob sends only that, never the text.
    `SELECT bt.blob_id,
            CASE WHEN bt.search_score_enc IS NULL THEN bt.search_enc END AS search_enc,
            bt.search_score_enc,
            b.doc_id,
            b.rel_path,
            b.filename,
            -- Plaintext columns only for a plaintext row (see the note query).
            CASE WHEN bt.search_enc IS NULL AND bt.search_score_enc IS NULL THEN bt.vector END AS vector,
            CASE WHEN $6::boolean OR bt.search_enc IS NOT NULL OR bt.search_score_enc IS NOT NULL THEN NULL
                 ELSE bt.search_tokens END AS search_tokens,
            -- One count per query, in query order.
            CASE WHEN bt.search_enc IS NULL AND bt.search_score_enc IS NULL
                  AND (bt.search_tokens IS NULL OR $6::boolean OR b.rel_path ~ '[^\x01-\x7f]') THEN ARRAY(
              SELECT coalesce(c.n, 0)::int
                FROM generate_series(0, $7::int - 1) AS g(i)
                LEFT JOIN (
                  SELECT t.qi, count(*) AS n
                    FROM unnest($3::text[], $8::int[]) AS t(tok, qi)
                   WHERE position(t.tok IN lower(coalesce(b.rel_path, '') || ' ' || bt.content)) > 0
                   GROUP BY t.qi
                ) c ON c.qi = g.i
               ORDER BY g.i
            ) END AS matched_legacy
       FROM blob_text bt
       JOIN blobs b ON b.id = bt.blob_id AND b.status = 'ready'
      WHERE bt.vault_id = $1
        AND (
          (b.doc_id IS NOT NULL AND b.doc_id = ANY($2::text[]))
          OR (b.doc_id IS NULL AND $4::boolean)
        )
        AND ($9::text[] IS NULL OR bt.blob_id = ANY($9::text[]))
      ORDER BY bt.blob_id
      LIMIT $5`,
    [scope.vaultId, scope.docIds, flatTokens, scope.vaultWideReader, FILE_SEARCH_CAP, legacySql, queries.length, flatQuery, only],
  );
  type FileRow = Awaited<ReturnType<typeof fullRows>>["rows"][number];

  const hitOf = (r: { blob_id: string; doc_id: string | null; rel_path: string | null; filename: string | null }, score: number) => {
    const relPath = r.rel_path ?? "";
    return {
      docId: r.doc_id,
      blobId: r.blob_id,
      relPath,
      title: r.filename ?? (relPath ? (relPath.split("/").pop() ?? relPath) : r.blob_id),
      ext: extOf(relPath),
      score,
      kind: "file" as const,
    } as NoteSearchHit;
  };
  const scoreFileRow = async (r: FileRow, emit: (qi: number, hit: NoteSearchHit) => void) => {
    const relPath = r.rel_path ?? "";
    const nonAsciiPath = /[^\x01-\x7f]/.test(relPath);
    let scoreRow: SealedScoreRow | null = null;
    let searchEnc = r.search_enc;
    if (r.search_score_enc) {
      if (!crypto) throw new KeyRequiredError();
      try {
        scoreRow = openBlobScoreRow(crypto, r.blob_id, r.search_score_enc);
      } catch {
        scoreRow = null;
      }
      // Answers alone unless the match needs the text (no token set, legacy
      // mode, a non-ASCII rel_path): then the full row, as before.
      if (!(scoreRow && Array.isArray(scoreRow.vector) && scoreRow.tokens !== null && !legacySql && !nonAsciiPath)) {
        scoreRow = null;
        searchEnc = await fullBlobTextRow(db, r.blob_id);
      }
    }
    // W3 sealed row: the same formula over the decrypted fields. The SQL
    // count (no stored set, a non-ASCII rel_path, or legacy mode) becomes the
    // identical substring count over lower(rel_path || ' ' || body).
    let sealed: ReturnType<typeof openBlobTextRow> | null = null;
    if (!scoreRow && searchEnc) {
      if (!crypto) throw new KeyRequiredError();
      sealed = openBlobTextRow(crypto, r.blob_id, searchEnc);
    }
    const pathTokens = searchTokenSet(relPath) ?? "";
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      let vector = r.vector;
      let matchedSealed: number | null = null;
      if (scoreRow) {
        vector = scoreRow.vector;
        matchedSealed = keywordMatchCount(q.qTokens, `${pathTokens} ${scoreRow.tokens}`);
      } else if (sealed) {
        vector = sealed.vector;
        matchedSealed =
          sealed.tokens === null || legacySql || nonAsciiPath
            ? legacySubstringCount(q.qTokens, `${relPath} ${sealed.body}`)
            : keywordMatchCount(q.qTokens, `${pathTokens} ${sealed.tokens}`);
      }
      const sim = vector ? cosineSimilarity(q.qVec, vector) : 0;
      // rel_path is file metadata, not content: its tokens are matched live, the
      // extracted text through the stored set. Union of the two = the old
      // `position(tok IN lower(rel_path || ' ' || content))` (the space is outside
      // the token alphabet, so no match can straddle it).
      // Any row the SQL counted (no stored set, or a non-ASCII rel_path) keeps
      // that count; otherwise both halves here are pure ASCII.
      const matched =
        matchedSealed !== null
          ? matchedSealed
          : r.matched_legacy !== null || r.search_tokens === null
          ? (r.matched_legacy?.[qi] ?? 0)
          : keywordMatchCount(q.qTokens, `${pathTokens} ${r.search_tokens}`);
      const boost = q.qTokens.length > 0 ? 0.1 * (matched / q.qTokens.length) : 0;
      emit(qi, hitOf(r, sim + boost));
    }
  };

  const scored: NoteSearchHit[][] = queries.map(() => []);
  // Keyed: files on a fresh search page are scored from the page (unless the
  // live rel_path is non-ASCII, which needs the text); the rest row by row.
  const pages = crypto && !legacySql ? await loadPages(db, "file", crypto) : null;
  if (!pages || pages.rows.size === 0) {
    const { rows } = await fullRows(null);
    for (const [i, r] of rows.entries()) {
      if (i > 0 && i % SEARCH_YIELD_EVERY === 0) await yieldToEventLoop();
      await scoreFileRow(r, (qi, hit) => scored[qi].push(hit));
    }
  } else {
    // The same candidates in the same order and window as the row query.
    const { rows: live } = await db.query<{ blob_id: string; doc_id: string | null; rel_path: string | null; filename: string | null; stamp: string }>(
      `SELECT bt.blob_id, b.doc_id, b.rel_path, b.filename, bt.updated_at::text AS stamp
         FROM blob_text bt
         JOIN blobs b ON b.id = bt.blob_id AND b.status = 'ready'
        WHERE bt.vault_id = $1
          AND (
            (b.doc_id IS NOT NULL AND b.doc_id = ANY($2::text[]))
            OR (b.doc_id IS NULL AND $3::boolean)
          )
        ORDER BY bt.blob_id
        LIMIT $4`,
      [scope.vaultId, scope.docIds, scope.vaultWideReader, FILE_SEARCH_CAP],
    );
    const paged = (r: (typeof live)[number]) =>
      pages.rows.get(r.blob_id)?.stamp === r.stamp && !/[^\x01-\x7f]/.test(r.rel_path ?? "");
    const stale = live.filter((r) => !paged(r)).map((r) => r.blob_id);
    const fromRows = new Map<string, NoteSearchHit[]>();
    if (stale.length > 0) {
      const { rows } = await fullRows(stale);
      for (const [i, r] of rows.entries()) {
        if (i > 0 && i % SEARCH_YIELD_EVERY === 0) await yieldToEventLoop();
        await scoreFileRow(r, (qi, hit) => {
          let h = fromRows.get(r.blob_id);
          if (!h) fromRows.set(r.blob_id, (h = new Array<NoteSearchHit>(queries.length)));
          h[qi] = hit;
        });
      }
    }
    const masks = pages.pages.map((page) => queries.map((q) => vocabMasks(page, q.qTokens)));
    const scratch = new Uint32Array(Math.max(1, ...queries.map((q) => Math.ceil(q.qTokens.length / 32))));
    for (const [i, r] of live.entries()) {
      if (i > 0 && i % SEARCH_YIELD_EVERY === 0) await yieldToEventLoop();
      if (!paged(r)) {
        const h = fromRows.get(r.blob_id);
        if (h) for (let qi = 0; qi < queries.length; qi++) if (h[qi]) scored[qi].push(h[qi]);
        continue;
      }
      const at = pages.rows.get(r.blob_id)!;
      const page = pages.pages[at.page];
      const vec = page.vectors.subarray(at.row * EMBED_DIM, (at.row + 1) * EMBED_DIM) as unknown as number[];
      // rel_path tokens are matched live, as in the row path: a query token
      // counts once if it is in the path's tokens OR the page's.
      const pathTokens = searchTokenSet(r.rel_path ?? "") ?? "";
      for (let qi = 0; qi < queries.length; qi++) {
        const q = queries[qi];
        const matched = q.qTokens.length > 0 ? pageMatchCountWithPath(page, at.row, masks[at.page][qi], scratch, q.qTokens, pathTokens) : 0;
        const boost = q.qTokens.length > 0 ? 0.1 * (matched / q.qTokens.length) : 0;
        scored[qi].push(hitOf(r, cosineSimilarity(q.qVec, vec) + boost));
      }
    }
  }
  return scored.map((s, qi) => s.sort((a, b) => b.score - a.score).slice(0, queries[qi].k));
}

async function fullBlobTextRow(db: Queryable, blobId: string): Promise<Buffer | null> {
  const { rows } = await db.query<{ search_enc: Buffer | null }>(
    "SELECT search_enc FROM blob_text WHERE blob_id = $1",
    [blobId],
  );
  return rows[0]?.search_enc ?? null;
}

/** Filename stem of a rel_path, used as a fallback title. */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}
