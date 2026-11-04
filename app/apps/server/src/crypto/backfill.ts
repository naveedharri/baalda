// SPDX-License-Identifier: Apache-2.0
//
// Sealing a keyed vault's EXISTING plaintext rows (W3 "Migration of existing
// vaults"). Once a vault is keyed every new write is sealed, but rows written
// before stay plaintext. This worker gives each of them a sealed copy.
//
// ZERO DATA LOSS — the rules this file never breaks:
//   · Per row: seal → open the sealed bytes again → compare them byte for byte
//     with the original → only then write the `*_enc` column. A row that does
//     not round-trip is counted and left exactly as it was.
//   · The plaintext column is NEVER nulled, rewritten or deleted here. Nulling
//     is a separate, later, delayed step (`null-out.ts`). Readers already prefer
//     `*_enc`, so a sealed copy must always equal the current plaintext.
//   · Every write is conditional on the row still holding exactly what was
//     read (`*_enc IS NULL AND <plaintext> = <original>` and, where the row is
//     mutable, its version columns). A row replaced meanwhile (compaction,
//     re-index) gets 0 rows updated, is counted `skipped`, and is picked up on
//     the re-pass — a stale sealed copy can never land over newer data.
//
// Runs only while `vaultKeyCache.get(vaultId)` returns a key (a member is
// connected), re-checked before every batch; never from `pendingKeyCache` (a
// pending vault must not be sealed). One runner per vault across instances
// (session advisory lock). Progress lives in `vault_crypto_state.cursors`, so a
// crash or a key eviction resumes where it stopped.
//
// Pre-038 inline `note_versions.content` / `vault_checkpoint_docs.content` have
// no sealed column of their own; their sealed form is the content-addressed
// `note_texts (doc_id, sha256)` row readers already resolve when the inline
// copy is NULL. The `*_inline` passes create that sealed row (verified, insert
// only, never touching the inline text) for every inline row whose `sha256`
// matches its text; a row whose hash does not match is never sealed and stays
// plaintext (counted by `plaintextStatus`, never nulled).
//
// Not covered (no sealed column exists): Postgres `blobs.data`,
// `checkpoint_blob_bytes`, skills files.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { inc } from "../metrics/sync-metrics.js";
import {
  isUncompressedScore,
  openBlobScorePlain,
  openBlobScoreRow,
  openBlobTextRow,
  openScorePlain,
  openScoreRow,
  openSearchRow,
  sealBlobScoreRow,
  sealBlobTextRow,
  sealScoreRow,
  sealSearchRow,
} from "../index/sealed-index.js";
import { refreshSearchPages } from "../index/search-pages.js";
import { sealedTokenSet } from "../index/search-tokens.js";
import { openNoteTextBytes, sealNoteText } from "../versions/texts.js";
import { sha256Hex } from "../versions/capture.js";
import { indexDoc, setIndexDeferredHook } from "../index/indexer.js";
import { vaultKeysEnabled } from "./config.js";
import { openDocBytes, sealDocBytes, type DocCrypto } from "./doc-crypto.js";
import { vaultKeyCache, type VaultKeyCache } from "./key-cache.js";
import { verifyVk } from "./vk-check.js";
import { nullOutVault } from "./null-out.js";

type Queryable = Pick<pg.Pool, "query">;
type ClientSource = Queryable & { connect: () => Promise<pg.PoolClient> };

/** Fixed order; a table is finished before the next starts. */
export const BACKFILL_TABLES = [
  "doc_updates",
  "doc_snapshots",
  "note_index",
  "blob_text",
  "note_texts",
  "note_versions_inline",
  "checkpoint_docs_inline",
  // Not plaintext: the ranking half of an already-sealed `search_enc` row
  // (`note_index.search_score_enc`). Never counted by `encryptionStatus`, so it
  // neither delays the null-out nor reads as plaintext remaining.
  "note_index_score",
  "blob_text_score",
  // Score blobs written before they were compressed, re-sealed compressed in
  // place (same content). Also never counted by `encryptionStatus`.
  "note_index_score_pack",
  "blob_text_score_pack",
  // Score blobs of rows past the old 64 KB token bound, given their token set
  // so search stops opening the whole sealed body. Also never counted.
  "note_index_score_tokens",
  "blob_text_score_tokens",
] as const;
export type BackfillTable = (typeof BACKFILL_TABLES)[number];

export const BACKFILL_BATCH = 200;
/**
 * Bytes one batch may hold. Rows are taken in order until this is reached (a
 * row larger than it goes alone), because 200 rows of version text can be a
 * few hundred MB: each is held as plaintext, sealed copy and verify-open at
 * once, and a vault with 10 MB versions took the server down (2026-11-02).
 */
export const BACKFILL_BATCH_BYTES = 16 * 1024 * 1024;

/** `sql` (already ordered and LIMITed) cut to the rows that fit
 *  {@link BACKFILL_BATCH_BYTES}; at least one. `size` and `order` name columns
 *  of `sql`'s output as `x.<col>`. The budget is parameter `$<budgetParam>`. */
function byteBudgeted(sql: string, size: string, order: string, budgetParam: number): string {
  return `SELECT * FROM (
            SELECT x.*, count(*) OVER () AS scanned_rows, coalesce(octet_length(${size}), 0) AS row_bytes,
                   sum(coalesce(octet_length(${size}), 0)) OVER (ORDER BY ${order}) AS run_bytes
              FROM (${sql}) x) b
           WHERE b.run_bytes - b.row_bytes < $${budgetParam}
           ORDER BY ${order.replaceAll("x.", "b.")}`;
}

/** Rows the keyset LIMIT scanned, and whether the byte budget left some of
 *  them for the next batch (then the table is not done, however few came). */
function scanned(rows: unknown[]): { rows: number; more: boolean } {
  const n = rows.length === 0 ? 0 : Number((rows[0] as { scanned_rows?: unknown }).scanned_rows ?? rows.length);
  return { rows: n, more: rows.length < n };
}
export const BACKFILL_THROTTLE_MS = 50;
/** Batches one vault may run per tick, so one big vault cannot starve others. */
export const BACKFILL_BATCHES_PER_TICK = 50;
export const BACKFILL_TICK_MS = 30_000;
/** A completed vault is re-counted at most this often (late plaintext rows). */
export const BACKFILL_RECHECK_MS = 60 * 60_000;
/**
 * Least time between two recounts of one vault, and the recount's own time
 * limit. The recount hashes every inline version text, which on a large vault
 * outlasts the pool's 15 s statement timeout; it then failed on every 30 s
 * tick, a full scan each time (2026-11-02).
 */
export const BACKFILL_RECOUNT_GAP_MS = 10 * 60_000;
export const BACKFILL_RECOUNT_TIMEOUT_MS = 120_000;

interface TableCursor {
  /** Keyset position: the last key handled (JSON-encoded for composite keys). */
  after: string | null;
  done: boolean;
}

export interface BackfillCursors {
  tables: Partial<Record<BackfillTable, TableCursor>>;
  passes: number;
  /** ISO time the last full recount found nothing left. */
  completedAt?: string;
  checkedAt?: string;
  /** ISO time the last recount started (see {@link BACKFILL_RECOUNT_GAP_MS}). */
  recountAt?: string;
  /** ISO time of the last index catch-up (see `catchUpIndex`). */
  indexedAt?: string;
  /** ISO time of the last full staleness reconciliation (`reconcileIndexQueue`). */
  reconciledAt?: string;
}


/** Test seams. Production never replaces these. */
export const backfillHooks: {
  /** Runs after verification, right before the conditional write of one row. */
  beforeWrite: (table: BackfillTable, rowKey: string) => Promise<void> | void;
  /** Transforms sealed bytes before verification (simulates a bad seal). */
  tamper: (table: BackfillTable, sealed: Buffer) => Buffer;
} = {
  beforeWrite: () => {},
  tamper: (_t, s) => s,
};

function metric(table: BackfillTable, what: "sealed" | "verified" | "skipped" | "verify_failed"): void {
  inc(`backfill.${table}.${what}`);
}

/** The vault's docs (notes and tree files), soft-deleted ones included. */
const VAULT_DOCS = `(SELECT id FROM notes WHERE vault_id = $1 UNION ALL SELECT id FROM files WHERE vault_id = $1)`;

interface BatchResult {
  rows: number;
  last: string | null;
  /** The byte budget cut this batch short: rows remain past `last`. */
  more?: boolean;
}

/** One keyset batch of one table. Returns how many rows were read. */
async function runBatch(
  table: BackfillTable,
  c: DocCrypto,
  after: string | null,
  limit: number,
  db: Queryable,
): Promise<BatchResult> {
  switch (table) {
    case "doc_updates":
      return batchDocUpdates(c, after, limit, db);
    case "doc_snapshots":
      return batchDocSnapshots(c, after, limit, db);
    case "note_index":
      return batchNoteIndex(c, after, limit, db);
    case "blob_text":
      return batchBlobText(c, after, limit, db);
    case "note_texts":
      return batchNoteTexts(c, after, limit, db);
    case "note_versions_inline":
      return batchInlineTexts("note_versions_inline", c, after, limit, db);
    case "checkpoint_docs_inline":
      return batchInlineTexts("checkpoint_docs_inline", c, after, limit, db);
    case "note_index_score":
      return batchNoteIndexScore(c, after, limit, db);
    case "blob_text_score":
      return batchBlobTextScore(c, after, limit, db);
    case "note_index_score_pack":
      return batchScorePack("note_index_score_pack", c, after, limit, db);
    case "blob_text_score_pack":
      return batchScorePack("blob_text_score_pack", c, after, limit, db);
    case "note_index_score_tokens":
      return batchScoreTokens("note_index_score_tokens", c, after, limit, db);
    case "blob_text_score_tokens":
      return batchScoreTokens("blob_text_score_tokens", c, after, limit, db);
  }
}

/** Seal + verify; null (and counted) when the round trip fails. */
function sealVerified(
  table: BackfillTable,
  rowKey: string,
  expected: Buffer,
  sealFn: () => Buffer,
  openFn: (sealed: Buffer) => Buffer,
): Buffer | null {
  try {
    const sealed = backfillHooks.tamper(table, sealFn());
    const opened = openFn(sealed);
    if (!opened.equals(expected)) throw new Error("mismatch");
    metric(table, "verified");
    return sealed;
  } catch {
    metric(table, "verify_failed");
    console.error(`[backfill] ${table} ${rowKey}: sealed copy did not verify; row left as is`);
    return null;
  }
}

async function write(table: BackfillTable, rowKey: string, sql: string, params: unknown[], db: Queryable): Promise<void> {
  await backfillHooks.beforeWrite(table, rowKey);
  const { rowCount } = await db.query(sql, params);
  metric(table, rowCount ? "sealed" : "skipped");
}

async function batchDocUpdates(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{ id: string; doc_id: string; update: Buffer }>(
    byteBudgeted(
      `SELECT u.id::text AS id, u.doc_id, u.update
         FROM doc_updates u
        WHERE u.doc_id IN ${VAULT_DOCS}
          AND u.id > $2::bigint
          AND u.update_enc IS NULL AND u.update IS NOT NULL
        ORDER BY u.id
        LIMIT $3`,
      `x."update"`,
      "x.id::bigint",
      4,
    ),
    [c.vaultId, after ?? "0", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    const sealed = sealVerified(
      "doc_updates",
      r.id,
      r.update,
      () => sealDocBytes(c, "doc_updates.update", r.doc_id, r.update),
      (s) => openDocBytes(c, "doc_updates.update", r.doc_id, s, null) ?? Buffer.alloc(0),
    );
    if (!sealed) continue;
    await write(
      "doc_updates",
      r.id,
      `UPDATE doc_updates SET update_enc = $2
        WHERE id = $1::bigint AND update_enc IS NULL AND update = $3`,
      [r.id, sealed, r.update],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.id ?? after };
}

async function batchDocSnapshots(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{ doc_id: string; snapshot: Buffer; seq: string | null }>(
    byteBudgeted(
      `SELECT s.doc_id, s.snapshot, s.seq::text AS seq
         FROM doc_snapshots s
        WHERE s.doc_id IN ${VAULT_DOCS}
          AND s.doc_id > $2
          AND s.snapshot_enc IS NULL AND s.snapshot IS NOT NULL
        ORDER BY s.doc_id
        LIMIT $3`,
      "x.snapshot",
      "x.doc_id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    const sealed = sealVerified(
      "doc_snapshots",
      r.doc_id,
      r.snapshot,
      () => sealDocBytes(c, "doc_snapshots.snapshot", r.doc_id, r.snapshot),
      (s) => openDocBytes(c, "doc_snapshots.snapshot", r.doc_id, s, null) ?? Buffer.alloc(0),
    );
    if (!sealed) continue;
    await write(
      "doc_snapshots",
      r.doc_id,
      `UPDATE doc_snapshots SET snapshot_enc = $2
        WHERE doc_id = $1 AND snapshot_enc IS NULL AND snapshot = $3
          AND seq IS NOT DISTINCT FROM $4::bigint`,
      [r.doc_id, sealed, r.snapshot, r.seq],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.doc_id ?? after };
}

/** The sealed JSON a search row's plaintext columns stand for. */
function searchJson(body: string, vectorText: string | null, tokens: string | null): Buffer {
  const vector = vectorText === null ? null : (JSON.parse(vectorText) as number[]);
  return Buffer.from(JSON.stringify({ body, vector, tokens }), "utf8");
}

/**
 * A sealed search row without its score blob: open it, seal vector + tokens
 * apart. A row with no token set gets one from its body now, so the score blob
 * answers alone. Written only while `search_enc` is still the row just read.
 */
async function batchNoteIndexScore(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{ doc_id: string; title: string | null; search_enc: Buffer; updated_at: string }>(
    byteBudgeted(
      `SELECT doc_id, title, search_enc, updated_at::text AS updated_at
         FROM note_index
        WHERE vault_id = $1 AND doc_id > $2 AND search_enc IS NOT NULL AND search_score_enc IS NULL
        ORDER BY doc_id
        LIMIT $3`,
      "x.search_enc",
      "x.doc_id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    let full: ReturnType<typeof openSearchRow>;
    try {
      full = openSearchRow(c, r.doc_id, r.search_enc);
    } catch {
      metric("note_index_score", "verify_failed");
      continue;
    }
    const score = {
      vector: full.vector,
      tokens: full.tokens ?? sealedTokenSet(`${r.title ?? ""} ${full.body}`) ?? null,
    };
    const json = Buffer.from(JSON.stringify(score), "utf8");
    const sealed = sealVerified(
      "note_index_score",
      r.doc_id,
      json,
      () => sealScoreRow(c, r.doc_id, score),
      (s) => Buffer.from(JSON.stringify(openScoreRow(c, r.doc_id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      "note_index_score",
      r.doc_id,
      // A re-index since the read moved `updated_at` (and wrote its own score).
      `UPDATE note_index SET search_score_enc = $2
        WHERE doc_id = $1 AND vault_id = $4 AND search_score_enc IS NULL AND updated_at = $3::timestamptz`,
      [r.doc_id, sealed, r.updated_at, c.vaultId],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.doc_id ?? after };
}

/**
 * An uncompressed score blob re-sealed compressed: the same vector and token
 * set, a third of the bytes search has to receive. Written only while the row
 * still holds exactly the blob just read, so a re-index in between wins.
 */
async function batchScorePack(
  table: "note_index_score_pack" | "blob_text_score_pack",
  c: DocCrypto,
  after: string | null,
  limit: number,
  db: Queryable,
): Promise<BatchResult> {
  const notes = table === "note_index_score_pack";
  const [tbl, key] = notes ? ["note_index", "doc_id"] : ["blob_text", "blob_id"];
  const { rows } = await db.query<{ id: string; search_score_enc: Buffer }>(
    byteBudgeted(
      `SELECT ${key} AS id, search_score_enc
         FROM ${tbl}
        WHERE vault_id = $1 AND ${key} > $2 AND search_score_enc IS NOT NULL
        ORDER BY ${key}
        LIMIT $3`,
      "x.search_score_enc",
      "x.id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    let plain: Buffer;
    try {
      plain = notes ? openScorePlain(c, r.id, r.search_score_enc) : openBlobScorePlain(c, r.id, r.search_score_enc);
    } catch {
      metric(table, "verify_failed");
      continue;
    }
    if (!isUncompressedScore(plain)) continue;
    const score = JSON.parse(plain.toString("utf8")) as Parameters<typeof sealScoreRow>[2];
    const json = Buffer.from(JSON.stringify(score), "utf8");
    const sealed = sealVerified(
      table,
      r.id,
      json,
      () => (notes ? sealScoreRow(c, r.id, score) : sealBlobScoreRow(c, r.id, score)),
      (s) => Buffer.from(JSON.stringify(notes ? openScoreRow(c, r.id, s) : openBlobScoreRow(c, r.id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      table,
      r.id,
      `UPDATE ${tbl} SET search_score_enc = $2
        WHERE ${key} = $1 AND vault_id = $4 AND search_score_enc = $3`,
      [r.id, sealed, r.search_score_enc, c.vaultId],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.id ?? after };
}

/**
 * A score blob with no token set (its row passed the old 64 KB bound) given
 * one from its sealed body, up to `SEALED_TOKENS_MAX`: the same set the
 * row's substring rule matches, so the score blob then answers alone. The
 * vector is kept and must equal the body's; written only while both blobs are
 * still the ones just read. Bodies are opened one at a time and a batch stops
 * after {@link BACKFILL_BATCH_BYTES} of them.
 */
async function batchScoreTokens(
  table: "note_index_score_tokens" | "blob_text_score_tokens",
  c: DocCrypto,
  after: string | null,
  limit: number,
  db: Queryable,
): Promise<BatchResult> {
  const notes = table === "note_index_score_tokens";
  const [tbl, key] = notes ? ["note_index", "doc_id"] : ["blob_text", "blob_id"];
  const { rows } = await db.query<{ id: string; search_score_enc: Buffer }>(
    byteBudgeted(
      `SELECT ${key} AS id, search_score_enc
         FROM ${tbl}
        WHERE vault_id = $1 AND ${key} > $2 AND search_score_enc IS NOT NULL AND search_enc IS NOT NULL
        ORDER BY ${key}
        LIMIT $3`,
      "x.search_score_enc",
      "x.id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  let bodyBytes = 0;
  for (const [i, r] of rows.entries()) {
    if (bodyBytes >= BACKFILL_BATCH_BYTES) {
      return { rows: i, last: rows[i - 1].id, more: true };
    }
    let score: { vector: number[]; tokens: string | null };
    try {
      score = notes ? openScoreRow(c, r.id, r.search_score_enc) : openBlobScoreRow(c, r.id, r.search_score_enc);
    } catch {
      metric(table, "verify_failed");
      continue;
    }
    if (score.tokens !== null) continue;
    const { rows: fullRows } = await db.query<{ title: string | null; search_enc: Buffer }>(
      `SELECT ${notes ? "title" : "NULL::text AS title"}, search_enc FROM ${tbl} WHERE ${key} = $1 AND vault_id = $2`,
      [r.id, c.vaultId],
    );
    const enc = fullRows[0]?.search_enc;
    if (!enc) continue;
    bodyBytes += enc.length;
    let full: ReturnType<typeof openSearchRow>;
    try {
      full = notes ? openSearchRow(c, r.id, enc) : openBlobTextRow(c, r.id, enc);
    } catch {
      metric(table, "verify_failed");
      continue;
    }
    const sameVector =
      Array.isArray(full.vector) &&
      Array.isArray(score.vector) &&
      full.vector.length === score.vector.length &&
      full.vector.every((x, d) => Object.is(x, score.vector[d]));
    const tokens = full.tokens ?? sealedTokenSet(notes ? `${fullRows[0].title ?? ""} ${full.body}` : full.body);
    if (!sameVector || tokens === null) {
      metric(table, "skipped");
      continue;
    }
    const next = { vector: score.vector, tokens };
    const json = Buffer.from(JSON.stringify(next), "utf8");
    const sealed = sealVerified(
      table,
      r.id,
      json,
      () => (notes ? sealScoreRow(c, r.id, next) : sealBlobScoreRow(c, r.id, next)),
      (s) => Buffer.from(JSON.stringify(notes ? openScoreRow(c, r.id, s) : openBlobScoreRow(c, r.id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      table,
      r.id,
      `UPDATE ${tbl} SET search_score_enc = $2
        WHERE ${key} = $1 AND vault_id = $4 AND search_score_enc = $3 AND search_enc = $5`,
      [r.id, sealed, r.search_score_enc, c.vaultId, enc],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.id ?? after };
}

/** The file half of {@link batchNoteIndexScore} (`blob_text.search_score_enc`). */
async function batchBlobTextScore(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{ blob_id: string; search_enc: Buffer; updated_at: string }>(
    byteBudgeted(
      `SELECT blob_id, search_enc, updated_at::text AS updated_at
         FROM blob_text
        WHERE vault_id = $1 AND blob_id > $2 AND search_enc IS NOT NULL AND search_score_enc IS NULL
        ORDER BY blob_id
        LIMIT $3`,
      "x.search_enc",
      "x.blob_id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    let full: ReturnType<typeof openBlobTextRow>;
    try {
      full = openBlobTextRow(c, r.blob_id, r.search_enc);
    } catch {
      metric("blob_text_score", "verify_failed");
      continue;
    }
    const score = { vector: full.vector, tokens: full.tokens ?? sealedTokenSet(full.body) ?? null };
    const json = Buffer.from(JSON.stringify(score), "utf8");
    const sealed = sealVerified(
      "blob_text_score",
      r.blob_id,
      json,
      () => sealBlobScoreRow(c, r.blob_id, score),
      (s) => Buffer.from(JSON.stringify(openBlobScoreRow(c, r.blob_id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      "blob_text_score",
      r.blob_id,
      `UPDATE blob_text SET search_score_enc = $2
        WHERE blob_id = $1 AND vault_id = $4 AND search_score_enc IS NULL AND updated_at = $3::timestamptz`,
      [r.blob_id, sealed, r.updated_at, c.vaultId],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.blob_id ?? after };
}

async function batchNoteIndex(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{
    doc_id: string;
    content: string;
    vector: string | null;
    search_tokens: string | null;
    updated_at: string;
  }>(
    byteBudgeted(
      `SELECT doc_id, content, vector::text AS vector, search_tokens, updated_at::text AS updated_at
         FROM note_index
        WHERE vault_id = $1 AND doc_id > $2 AND search_enc IS NULL
        ORDER BY doc_id
        LIMIT $3`,
      "x.content",
      "x.doc_id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    const json = searchJson(r.content, r.vector, r.search_tokens);
    const row = JSON.parse(json.toString("utf8"));
    const sealed = sealVerified(
      "note_index",
      r.doc_id,
      json,
      () => sealSearchRow(c, r.doc_id, row),
      (s) => Buffer.from(JSON.stringify(openSearchRow(c, r.doc_id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      "note_index",
      r.doc_id,
      `UPDATE note_index SET search_enc = $2
        WHERE doc_id = $1 AND vault_id = $6 AND search_enc IS NULL AND content = $3
          AND vector::text IS NOT DISTINCT FROM $4
          AND search_tokens IS NOT DISTINCT FROM $5
          AND updated_at = $7::timestamptz`,
      [r.doc_id, sealed, r.content, r.vector, r.search_tokens, c.vaultId, r.updated_at],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.doc_id ?? after };
}

async function batchBlobText(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{
    blob_id: string;
    content: string;
    vector: string | null;
    search_tokens: string | null;
    updated_at: string;
  }>(
    byteBudgeted(
      `SELECT blob_id, content, vector::text AS vector, search_tokens, updated_at::text AS updated_at
         FROM blob_text
        WHERE vault_id = $1 AND blob_id > $2 AND search_enc IS NULL
        ORDER BY blob_id
        LIMIT $3`,
      "x.content",
      "x.blob_id",
      4,
    ),
    [c.vaultId, after ?? "", limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    const json = searchJson(r.content, r.vector, r.search_tokens);
    const row = JSON.parse(json.toString("utf8"));
    const sealed = sealVerified(
      "blob_text",
      r.blob_id,
      json,
      () => sealBlobTextRow(c, r.blob_id, row),
      (s) => Buffer.from(JSON.stringify(openBlobTextRow(c, r.blob_id, s)), "utf8"),
    );
    if (!sealed) continue;
    await write(
      "blob_text",
      r.blob_id,
      `UPDATE blob_text SET search_enc = $2
        WHERE blob_id = $1 AND vault_id = $6 AND search_enc IS NULL AND content = $3
          AND vector::text IS NOT DISTINCT FROM $4
          AND search_tokens IS NOT DISTINCT FROM $5
          AND updated_at = $7::timestamptz`,
      [r.blob_id, sealed, r.content, r.vector, r.search_tokens, c.vaultId, r.updated_at],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.blob_id ?? after };
}

async function batchNoteTexts(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const [afterDoc, afterSha] = after ? (JSON.parse(after) as [string, string]) : ["", ""];
  const { rows } = await db.query<{ doc_id: string; sha256: string; content: string }>(
    byteBudgeted(
      `SELECT doc_id, sha256, content
         FROM note_texts
        WHERE vault_id = $1 AND (doc_id, sha256) > ($2, $3) AND content_enc IS NULL
        ORDER BY doc_id, sha256
        LIMIT $4`,
      "x.content",
      "x.doc_id, x.sha256",
      5,
    ),
    [c.vaultId, afterDoc, afterSha, limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    const key = `${r.doc_id}:${r.sha256}`;
    const sealed = sealVerified(
      "note_texts",
      key,
      Buffer.from(r.content, "utf8"),
      () => sealNoteText(c, r.doc_id, r.sha256, r.content),
      (s) => openNoteTextBytes(c, r.doc_id, r.sha256, s),
    );
    if (!sealed) continue;
    await write(
      "note_texts",
      key,
      `UPDATE note_texts SET content_enc = $3
        WHERE doc_id = $1 AND sha256 = $2 AND vault_id = $5 AND content_enc IS NULL AND content = $4`,
      [r.doc_id, r.sha256, sealed, r.content, c.vaultId],
      db,
    );
  }
  const last = rows.at(-1);
  return { ...scanned(rows), last: last ? JSON.stringify([last.doc_id, last.sha256]) : after };
}

/** An inline row's hash matches its text (only such a row has a sealed form). */
const INLINE_SHA_OK = (alias: string) =>
  `encode(sha256(convert_to(${alias}.content, 'UTF8')), 'hex') = ${alias}.sha256`;
/** No sealed `note_texts` copy for this inline row's (doc, sha) yet. */
const NO_SEALED_TEXT = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM note_texts t WHERE t.doc_id = ${alias}.doc_id AND t.sha256 = ${alias}.sha256 AND t.content_enc IS NOT NULL)`;

/**
 * Give a pre-038 inline version/checkpoint text its sealed form: a
 * `note_texts` row with `content = ''` and the verified `content_enc`. Insert
 * only (ON CONFLICT DO NOTHING): an existing plaintext `note_texts` row for the
 * same (doc, sha) is sealed by the `note_texts` pass instead. The inline text is
 * never touched here.
 */
async function batchInlineTexts(
  table: "note_versions_inline" | "checkpoint_docs_inline",
  c: DocCrypto,
  after: string | null,
  limit: number,
  db: Queryable,
): Promise<BatchResult> {
  const sql =
    table === "note_versions_inline"
      ? `SELECT v.id::text AS key, v.doc_id, v.sha256, v.content
           FROM note_versions v
          WHERE v.vault_id = $1 AND v.id > $2::bigint AND v.content IS NOT NULL
            AND ${INLINE_SHA_OK("v")} AND ${NO_SEALED_TEXT("v")}
          ORDER BY v.id LIMIT $3`
      : `SELECT d.checkpoint_id || ':' || d.doc_id AS key, d.doc_id, d.sha256, d.content
           FROM vault_checkpoint_docs d JOIN vault_checkpoints k ON k.id = d.checkpoint_id
          WHERE k.vault_id = $1 AND d.checkpoint_id || ':' || d.doc_id > $2 AND d.content IS NOT NULL
            AND ${INLINE_SHA_OK("d")} AND ${NO_SEALED_TEXT("d")}
          ORDER BY d.checkpoint_id || ':' || d.doc_id LIMIT $3`;
  const order = table === "note_versions_inline" ? "x.key::bigint" : "x.key";
  const { rows } = await db.query<{ key: string; doc_id: string; sha256: string; content: string }>(
    byteBudgeted(sql, "x.content", order, 4),
    [c.vaultId, after ?? (table === "note_versions_inline" ? "0" : ""), limit, BACKFILL_BATCH_BYTES],
  );
  for (const r of rows) {
    // Belt for the SQL hash check: never seal a text under a sha it does not have.
    if (sha256Hex(r.content) !== r.sha256) continue;
    const sealed = sealVerified(
      table,
      r.key,
      Buffer.from(r.content, "utf8"),
      () => sealNoteText(c, r.doc_id, r.sha256, r.content),
      (s) => openNoteTextBytes(c, r.doc_id, r.sha256, s),
    );
    if (!sealed) continue;
    await write(
      table,
      r.key,
      `INSERT INTO note_texts (doc_id, sha256, vault_id, content, content_enc)
       VALUES ($1, $2, $3, '', $4)
       ON CONFLICT (doc_id, sha256) DO NOTHING`,
      [r.doc_id, r.sha256, c.vaultId, sealed],
      db,
    );
  }
  return { ...scanned(rows), last: rows.at(-1)?.key ?? after };
}

// ── status ──────────────────────────────────────────────────────────────────

export interface EncryptionStatus {
  /** Rows per table with plaintext and no sealed copy (what the backfill seals). */
  remaining: Record<BackfillTable, number>;
  /**
   * Pre-038 inline version/checkpoint texts still held inline (sealed form or
   * not); the null-out clears them once their sealed `note_texts` copy matches.
   */
  unsupported: { note_versions_inline: number; checkpoint_docs_inline: number };
  /** Sum of `remaining` (0 = every sealable row has a verified sealed copy). */
  total: number;
}

/** Remaining plaintext-only rows per table, for an admin script and the null-out gate. */
export async function encryptionStatus(
  vaultId: string,
  db: Queryable = defaultPool,
  timeoutMs?: number,
): Promise<EncryptionStatus> {
  // A longer limit than the pool's needs its own connection and transaction.
  const client = timeoutMs && "connect" in db ? await (db as ClientSource).connect() : null;
  try {
    if (client) {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs!)}`);
    }
    return await countRemaining(vaultId, client ?? db);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}

async function countRemaining(vaultId: string, db: Queryable): Promise<EncryptionStatus> {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM doc_updates
         WHERE doc_id IN ${VAULT_DOCS} AND update_enc IS NULL AND update IS NOT NULL) AS doc_updates,
       (SELECT count(*) FROM doc_snapshots
         WHERE doc_id IN ${VAULT_DOCS} AND snapshot_enc IS NULL AND snapshot IS NOT NULL) AS doc_snapshots,
       (SELECT count(*) FROM note_index WHERE vault_id = $1 AND search_enc IS NULL) AS note_index,
       (SELECT count(*) FROM blob_text WHERE vault_id = $1 AND search_enc IS NULL) AS blob_text,
       (SELECT count(*) FROM note_texts WHERE vault_id = $1 AND content_enc IS NULL) AS note_texts,
       (SELECT count(*) FROM note_versions v WHERE v.vault_id = $1 AND v.content IS NOT NULL
           AND ${INLINE_SHA_OK("v")} AND ${NO_SEALED_TEXT("v")}) AS note_versions_inline,
       (SELECT count(*) FROM vault_checkpoint_docs d JOIN vault_checkpoints c ON c.id = d.checkpoint_id
         WHERE c.vault_id = $1 AND d.content IS NOT NULL
           AND ${INLINE_SHA_OK("d")} AND ${NO_SEALED_TEXT("d")}) AS checkpoint_docs_inline,
       (SELECT count(*) FROM note_versions WHERE vault_id = $1 AND content IS NOT NULL) AS inline_versions_all,
       (SELECT count(*) FROM vault_checkpoint_docs d JOIN vault_checkpoints c ON c.id = d.checkpoint_id
         WHERE c.vault_id = $1 AND d.content IS NOT NULL) AS inline_checkpoint_docs_all`,
    [vaultId],
  );
  const r = rows[0] ?? {};
  const remaining = Object.fromEntries(BACKFILL_TABLES.map((t) => [t, Number(r[t] ?? 0)])) as Record<
    BackfillTable,
    number
  >;
  return {
    remaining,
    unsupported: {
      note_versions_inline: Number(r.inline_versions_all ?? 0),
      checkpoint_docs_inline: Number(r.inline_checkpoint_docs_all ?? 0),
    },
    total: BACKFILL_TABLES.reduce((n, t) => n + remaining[t], 0),
  };
}

// ── runner ──────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  db?: ClientSource;
  cache?: VaultKeyCache;
  batchSize?: number;
  throttleMs?: number;
  maxBatches?: number;
  /** Run the index catch-up now even if the queue looked empty (key arrival). */
  indexCatchUp?: boolean;
  /** Pause between index catch-up batches (tests pass 0). */
  indexThrottleMs?: number;
}

export type BackfillOutcome =
  | "complete"
  | "budget"
  | "no_key"
  | "locked"
  | "not_keyed"
  | "stalled"
  | "disabled";

async function loadCursors(vaultId: string, db: Queryable): Promise<BackfillCursors | null> {
  const { rows } = await db.query<{ cursors: Partial<BackfillCursors> | null }>(
    "SELECT cursors FROM vault_crypto_state WHERE vault_id = $1",
    [vaultId],
  );
  if (!rows[0]) return null;
  const c = rows[0].cursors ?? {};
  return {
    tables: c.tables ?? {},
    passes: c.passes ?? 0,
    completedAt: c.completedAt ?? undefined,
    checkedAt: c.checkedAt,
    recountAt: c.recountAt,
    indexedAt: c.indexedAt,
    reconciledAt: c.reconciledAt,
  };
}

async function saveCursors(vaultId: string, cursors: BackfillCursors, db: Queryable): Promise<void> {
  // Merged, not replaced: the null-out keeps its own keys in the same JSON. A
  // cleared completion is written as an explicit null so the merge removes it.
  await db.query(
    "UPDATE vault_crypto_state SET cursors = cursors || $2::jsonb, updated_at = now() WHERE vault_id = $1",
    [vaultId, JSON.stringify({ ...cursors, completedAt: cursors.completedAt ?? null })],
  );
}

/**
 * The cached key, verified against the vault's CURRENT check and generation.
 * Null: no member connected, the vault is not keyed, or a rotation moved the
 * generation (never seal under a key the vault no longer uses).
 */
export async function heldCrypto(vaultId: string, cache: VaultKeyCache, db: Queryable): Promise<DocCrypto | null> {
  const { rows } = await db.query<{ vk_check: Buffer | null; key_generation: number | null }>(
    "SELECT vk_check, key_generation FROM vaults WHERE id = $1",
    [vaultId],
  );
  const v = rows[0];
  if (!v?.vk_check) return null;
  const held = cache.get(vaultId);
  if (!held) return null;
  if (held.generation !== (v.key_generation ?? 1) || !verifyVk(held.key, vaultId, v.vk_check)) {
    held.key.fill(0);
    return null;
  }
  return { vaultId, key: held.key, generation: held.generation };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Notes re-indexed per catch-up run (the rest wait for the next run). */
export const INDEX_CATCHUP_LIMIT = 500;

/** The full staleness reconciliation (a safety net) runs at most this often per vault. */
export const INDEX_RECONCILE_EVERY_MS = 24 * 60 * 60_000;

/**
 * Live notes of a vault whose search row is missing or older than the note's
 * latest content change. EXPENSIVE (a correlated doc_updates read per note):
 * only the once-a-day `reconcileIndexQueue` safety net uses it, to catch a
 * re-index lost without ever reaching the indexer (process restart inside a
 * debounce window). Deferred indexing itself is queued in `index_pending`.
 */
export async function staleIndexDocs(vaultId: string, db: Queryable, limit = INDEX_CATCHUP_LIMIT): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
       LEFT JOIN note_index ni ON ni.doc_id = n.id
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL
        AND (ni.doc_id IS NULL
             OR ni.updated_at < n.updated_at
             OR ni.updated_at < (SELECT max(u.created_at) FROM doc_updates u WHERE u.doc_id = n.id))
      ORDER BY n.id
      LIMIT $2`,
    [vaultId, limit],
  );
  return rows.map((r) => r.id);
}

/** Queue every stale note of the vault (the daily safety net); returns how many. */
export async function reconcileIndexQueue(vaultId: string, db: Queryable = defaultPool): Promise<number> {
  const ids = await staleIndexDocs(vaultId, db, 100_000);
  if (ids.length === 0) return 0;
  await db.query(
    `INSERT INTO index_pending (doc_id, vault_id)
     SELECT unnest($2::text[]), $1
     ON CONFLICT (doc_id) DO NOTHING`,
    [vaultId, ids],
  );
  return ids.length;
}

/** Cheap check: does this vault have deferred notes waiting for a key? */
export async function hasPendingIndex(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rows } = await db.query<{ pending: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM index_pending WHERE vault_id = $1) AS pending",
    [vaultId],
  );
  return rows[0]?.pending === true;
}

export interface CatchUpOptions {
  cache?: VaultKeyCache;
  batchSize?: number;
  throttleMs?: number;
}

/** Pause between catch-up batches, so a 20k drain leaves the pool to live traffic. */
export const INDEX_CATCHUP_THROTTLE_MS = 25;

/**
 * Drain the notes the keyed vault's indexer deferred (`index_pending`), oldest
 * first, in batches of {@link INDEX_CATCHUP_LIMIT}, for as long as a member's
 * key is cached; returns how many were indexed. The key is re-fetched and
 * re-verified before every batch and zeroed after it, so an eviction, a
 * rotation or a shutdown stops the drain at the next batch boundary.
 *
 * A row is removed only after its doc was handled (indexed, or no live note
 * left to index) AND only if nobody re-queued it meanwhile (same `queued_at`);
 * a throw keeps the row. The keyset cursor walks PAST a row that keeps failing,
 * so one poison note cannot spin the drain; a re-queued row has a newer
 * `queued_at` and is met again later in the same drain.
 */
export async function catchUpIndex(
  vaultId: string,
  db: Queryable = defaultPool,
  opts: CatchUpOptions = {},
): Promise<number> {
  const cache = opts.cache ?? vaultKeyCache;
  const limit = opts.batchSize ?? INDEX_CATCHUP_LIMIT;
  const throttleMs = opts.throttleMs ?? INDEX_CATCHUP_THROTTLE_MS;
  let afterTs: string | null = null;
  let afterId = "";
  let total = 0;
  for (let batch = 0; !stopping; batch += 1) {
    if (batch > 0 && throttleMs > 0) await sleep(throttleMs);
    const crypto = await heldCrypto(vaultId, cache, db);
    if (!crypto) break;
    let n = 0;
    let read = 0;
    let removed = 0;
    try {
      // queued_at as TEXT: a JS Date would drop the microseconds the delete matches on.
      const { rows }: { rows: { doc_id: string; queued_at: string }[] } = await db.query<{ doc_id: string; queued_at: string }>(
        `SELECT doc_id, queued_at::text AS queued_at FROM index_pending
          WHERE vault_id = $1
            AND ($2::timestamptz IS NULL OR (queued_at, doc_id) > ($2::timestamptz, $3))
          ORDER BY queued_at, doc_id LIMIT $4`,
        [vaultId, afterTs, afterId, limit],
      );
      read = rows.length;
      for (const { doc_id, queued_at } of rows) {
        afterTs = queued_at;
        afterId = doc_id;
        try {
          // The batch's verified key, so 500 notes cost one key check, not 500.
          if (await indexDoc(doc_id, db, crypto)) n += 1;
          // A deferral inside indexDoc re-queued with a newer queued_at, so this
          // delete matches nothing and the row survives for the next run.
          const del = await db.query("DELETE FROM index_pending WHERE doc_id = $1 AND queued_at = $2::timestamptz", [
            doc_id,
            queued_at,
          ]);
          removed += del.rowCount ?? 0;
        } catch (err) {
          console.error(`[backfill] index catch-up failed for ${doc_id}:`, err);
        }
      }
    } finally {
      crypto.key.fill(0);
    }
    total += n;
    if (n > 0) inc("backfill.index_catchup", n);
    // The end of the queue, or a batch that made no progress (every row failed
    // or was deferred again): stop, the next kick or tick tries again. A row
    // handled without an index write (its note was deleted meanwhile) is
    // progress too, so a batch of deleted notes does not stop the drain.
    if (read < limit || (n === 0 && removed === 0)) break;
  }
  return total;
}

/**
 * Seal one vault's plaintext rows, resuming from its persisted cursors. Takes a
 * session advisory lock so only one instance works on a vault; returns
 * `locked` when another holds it.
 */
export async function backfillVault(vaultId: string, opts: BackfillOptions = {}): Promise<BackfillOutcome> {
  if (!vaultKeysEnabled()) return "disabled";
  const db = opts.db ?? defaultPool;
  const cache = opts.cache ?? vaultKeyCache;
  const batchSize = opts.batchSize ?? BACKFILL_BATCH;
  const throttleMs = opts.throttleMs ?? BACKFILL_THROTTLE_MS;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;

  const lockClient = await db.connect();
  const lockKey = `crypto-backfill:${vaultId}`;
  let locked = false;
  try {
    const { rows } = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [lockKey],
    );
    locked = rows[0]?.ok === true;
    if (!locked) return "locked";

    const cursors = await loadCursors(vaultId, db);
    if (!cursors) return "not_keyed";
    // Notes the indexer skipped while no key was held (it uses the same cache).
    const probe = await heldCrypto(vaultId, cache, db);
    if (!probe) return "no_key";
    probe.key.fill(0);
    const reconciled = Date.parse(cursors.reconciledAt ?? "");
    if (!Number.isFinite(reconciled) || Date.now() - reconciled >= INDEX_RECONCILE_EVERY_MS) {
      await reconcileIndexQueue(vaultId, db);
      cursors.reconciledAt = new Date().toISOString();
      await saveCursors(vaultId, cursors, db);
    }
    // Drain the WHOLE deferred queue while the key is held (one cheap EXISTS
    // when it is empty). It used to take 500 per run, every 10 minutes: about
    // 6 hours before a 20k-note import was searchable.
    if (opts.indexCatchUp || (await hasPendingIndex(vaultId, db))) {
      await catchUpIndex(vaultId, db, { cache, throttleMs: opts.indexThrottleMs });
      cursors.indexedAt = new Date().toISOString();
      await saveCursors(vaultId, cursors, db);
    }
    if (cursors.completedAt) {
      const checked = Date.parse(cursors.checkedAt ?? cursors.completedAt);
      if (Number.isFinite(checked) && Date.now() - checked < BACKFILL_RECHECK_MS) return "complete";
    }

    let batches = 0;
    let prevTotal = Number.POSITIVE_INFINITY;
    let recounted = false;
    for (;;) {
      for (const table of BACKFILL_TABLES) {
        const cur = cursors.tables[table] ?? { after: null, done: false };
        cursors.tables[table] = cur;
        while (!cur.done) {
          if (batches >= maxBatches) {
            await saveCursors(vaultId, cursors, db);
            return "budget";
          }
          // The key is fetched (a COPY) and re-verified for EVERY batch, and
          // zeroed right after: an eviction stops the run at the next batch.
          const crypto = await heldCrypto(vaultId, cache, db);
          if (!crypto) {
            await saveCursors(vaultId, cursors, db);
            return "no_key";
          }
          try {
            const res = await runBatch(table, crypto, cur.after, batchSize, db);
            cur.after = res.last;
            if (res.rows < batchSize && !res.more) cur.done = true;
          } finally {
            crypto.key.fill(0);
          }
          batches += 1;
          await saveCursors(vaultId, cursors, db);
          if (throttleMs > 0) await sleep(throttleMs);
        }
      }
      // Every table reached its end. Rows replaced behind a cursor (a plaintext
      // compaction rewriting a snapshot, a skipped row) are found by a recount;
      // those tables start over. Bounded by the batch budget, and spaced across
      // runs: a recount is a full scan, so one a previous run just made (or
      // that timed out) waits. Within this run, progress re-passes freely.
      const lastRecount = Date.parse(cursors.recountAt ?? "");
      if (!recounted && Number.isFinite(lastRecount) && Date.now() - lastRecount < BACKFILL_RECOUNT_GAP_MS) {
        return "stalled";
      }
      recounted = true;
      cursors.recountAt = new Date().toISOString();
      await saveCursors(vaultId, cursors, db);
      const status = await encryptionStatus(vaultId, db, BACKFILL_RECOUNT_TIMEOUT_MS);
      const now = new Date().toISOString();
      if (status.total === 0) {
        cursors.completedAt ??= now;
        cursors.checkedAt = now;
        await saveCursors(vaultId, cursors, db);
        return "complete";
      }
      cursors.completedAt = undefined;
      cursors.passes += 1;
      for (const t of BACKFILL_TABLES) {
        if (status.remaining[t] > 0) cursors.tables[t] = { after: null, done: false };
      }
      await saveCursors(vaultId, cursors, db);
      // A pass that made no progress (rows that keep failing verification, or
      // keep moving) stops here; the next tick tries again.
      if (status.total >= prevTotal) return "stalled";
      prevTotal = status.total;
      if (batches >= maxBatches) return "budget";
    }
  } finally {
    if (locked) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => {});
    }
    lockClient.release();
  }
}

/** A keyed vault's search pages (notes, then files), with a fresh key copy each. */
async function refreshVaultSearchPages(vaultId: string, cache: VaultKeyCache, db: ClientSource): Promise<void> {
  for (const kind of ["note", "file"] as const) {
    const crypto = await heldCrypto(vaultId, cache, db);
    if (!crypto) return;
    try {
      const t = Date.now();
      const outcome = await refreshSearchPages(crypto, kind, db);
      if (outcome === "built") console.log(`[search-pages] vault=${vaultId} kind=${kind} built ms=${Date.now() - t}`);
    } catch (err) {
      console.error(`[search-pages] vault=${vaultId} kind=${kind} build failed:`, err);
    } finally {
      crypto.key.fill(0);
    }
  }
}

// ── scheduler ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** One pass over every keyed vault whose key is held right now. */
export async function backfillTick(opts: BackfillOptions = {}): Promise<void> {
  if (running || !vaultKeysEnabled()) return;
  running = true;
  try {
    const db = opts.db ?? defaultPool;
    const cache = opts.cache ?? vaultKeyCache;
    const { rows } = await db.query<{ vault_id: string }>(
      `SELECT s.vault_id FROM vault_crypto_state s
         JOIN vaults v ON v.id = s.vault_id
        WHERE v.vk_check IS NOT NULL
        ORDER BY s.updated_at`,
    );
    for (const { vault_id } of rows) {
      if (!cache.has(vault_id)) continue;
      try {
        const outcome = await backfillVault(vault_id, { maxBatches: BACKFILL_BATCHES_PER_TICK, ...opts });
        // The delayed, compared plaintext removal; gated on its own (retention,
        // fresh recount, key held). Cheap once the vault is sealed.
        if (outcome === "complete") await nullOutVault(vault_id, { maxBatches: BACKFILL_BATCHES_PER_TICK, db: opts.db, cache: opts.cache });
        // Search pages: rebuilt here, from the held key, once enough rows changed.
        if (outcome === "complete") await refreshVaultSearchPages(vault_id, cache, db);
      } catch (err) {
        console.error(`[backfill] vault ${vault_id} failed:`, err);
      }
    }
  } finally {
    running = false;
  }
}

const kicked = new Set<string>();
/** Vaults kicked again while their run was in flight: run once more after it. */
const rearm = new Set<string>();
/** Set on shutdown: a running drain stops at its next batch boundary. */
let stopping = false;
let unsubscribeAcquire: (() => void) | null = null;

/**
 * A key arrival is worth a run only when there is work: deferred notes queued
 * (cheap EXISTS), or sealing not yet complete. An idle, fully sealed vault —
 * the common reconnect — costs exactly this one query.
 */
async function kickNeeded(vaultId: string, db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ pending: boolean; sealing: boolean | null }>(
    `SELECT EXISTS (SELECT 1 FROM index_pending WHERE vault_id = $1) AS pending,
            (SELECT (s.cursors->>'completedAt') IS NULL FROM vault_crypto_state s WHERE s.vault_id = $1) AS sealing`,
    [vaultId],
  );
  return rows[0]?.pending === true || rows[0]?.sealing === true;
}

/**
 * A member's key for `vaultId` just reached the cache (vault channel hello):
 * run the worker for that vault now instead of waiting for the next tick, so
 * notes indexed-while-keyless become searchable at once. Deduplicated per vault.
 */
export function kickVaultBackfill(vaultId: string, opts: BackfillOptions = {}): Promise<void> {
  if (!vaultKeysEnabled() || stopping) return Promise.resolve();
  if (kicked.has(vaultId)) {
    // A run is in flight and may already be past the new work: one more pass.
    rearm.add(vaultId);
    return Promise.resolve();
  }
  kicked.add(vaultId);
  return kickNeeded(vaultId, opts.db ?? defaultPool)
    .then((needed) =>
      needed ? backfillVault(vaultId, { maxBatches: BACKFILL_BATCHES_PER_TICK, indexCatchUp: true, ...opts }) : undefined,
    )
    .then(() => undefined)
    .catch((err) => console.error(`[backfill] vault ${vaultId} failed:`, err))
    .finally(() => {
      kicked.delete(vaultId);
      if (rearm.delete(vaultId)) void kickVaultBackfill(vaultId, opts);
    });
}

/** Started only from `index.ts`. */
export function startCryptoBackfill(): void {
  if (timer) return;
  stopping = false;
  // A note deferred while this process holds the vault's key (it raced the
  // key's arrival) is drained now rather than at the next tick.
  setIndexDeferredHook((vaultId) => void kickVaultBackfill(vaultId));
  // Any key arrival (a vault channel, or a verified request key warming the
  // cache) drains what was deferred while no key was held.
  unsubscribeAcquire = vaultKeyCache.onAcquire((vaultId) => void kickVaultBackfill(vaultId));
  timer = setInterval(() => void backfillTick(), BACKFILL_TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopCryptoBackfill(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopping = true;
  setIndexDeferredHook(null);
  unsubscribeAcquire?.();
  unsubscribeAcquire = null;
}
