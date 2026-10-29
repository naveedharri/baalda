// SPDX-License-Identifier: Apache-2.0
//
// Clearing a keyed vault's OLD plaintext once every row has a verified sealed
// copy (W3 "null-out"). `backfill.ts` gives each pre-keying row a sealed copy
// and never touches the plaintext; this worker is the separate, delayed step
// that removes the plaintext.
//
// ZERO DATA LOSS — the rules this file never breaks:
//   · Runs for a vault only when it is keyed, its backfill is complete AND a
//     fresh `encryptionStatus` count says every sealable row has its sealed
//     copy, and `VAULT_PLAINTEXT_RETENTION_DAYS` (default 30) have passed since
//     that completion. Any late plaintext resets the backfill's completion, so
//     the clock starts over.
//   · Per row: open the sealed copy with the held key and compare it BYTE FOR
//     BYTE with the plaintext. Only an exact match clears the plaintext, and
//     the clearing statement is guarded by `WHERE <plaintext> = <original>`
//     AND the sealed column still holding the exact bytes that were compared,
//     so a row changed meanwhile (an edit, a compaction, a re-index) gets 0
//     rows updated and is left as it is.
//   · A mismatch (sealed copy differs, e.g. a search row re-indexed under the
//     key while its old plaintext stayed) clears NOTHING: both copies stay; the
//     row is counted and only its id is logged, never its content.
//   · Runs only while `vaultKeyCache` holds the vault's key, re-verified before
//     every batch and zeroed after it. One runner per vault across instances
//     (session advisory lock).
//
// Columns cleared (to NULL, or '' where the column is NOT NULL):
//   doc_updates.update, doc_snapshots.snapshot,
//   note_index.content/vector/search_tokens/ref_text (ref_text is a pure excerpt
//   of content; ref_heads are anchor prefixes, not note text, and stay),
//   blob_text.content/vector/search_tokens, note_texts.content,
//   note_versions.content, vault_checkpoint_docs.content (inline pre-038 texts,
//   compared against their sealed `note_texts` copy).
// Never covered (no sealed column exists): Postgres `blobs.data`,
// `checkpoint_blob_bytes`, skills files.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { inc } from "../metrics/sync-metrics.js";
import { openBlobTextRow, openSearchRow } from "../index/sealed-index.js";
import { openNoteTextBytes } from "../versions/texts.js";
import { sha256Hex } from "../versions/capture.js";
import { vaultKeysEnabled } from "./config.js";
import { openDocBytes, type DocCrypto } from "./doc-crypto.js";
import { vaultKeyCache, type VaultKeyCache } from "./key-cache.js";
import { encryptionStatus, heldCrypto, type BackfillCursors } from "./backfill.js";

type Queryable = Pick<pg.Pool, "query">;
type ClientSource = Queryable & { connect: () => Promise<pg.PoolClient> };

export const NULL_OUT_TABLES = [
  "doc_updates",
  "doc_snapshots",
  "note_index",
  "blob_text",
  "note_texts",
  "note_versions",
  "vault_checkpoint_docs",
] as const;
export type NullOutTable = (typeof NULL_OUT_TABLES)[number];

export const NULL_OUT_BATCH = 200;
/** Pause between batches, so a big vault leaves the pool to live traffic. */
export const NULL_OUT_THROTTLE_MS = 50;
/** Ids logged per table per pass for rows kept on a mismatch (the rest are counted). */
const MISMATCH_IDS_LOGGED = 10;
/** A finished pass is repeated at most this often per vault. */
export const NULL_OUT_RECHECK_MS = 60 * 60_000;
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * `VAULT_PLAINTEXT_RETENTION_DAYS`: days between a verified-complete backfill
 * and the null-out. Default 30; 0 allowed (tests, staging). Anything that is
 * not a non-negative number falls back to the default (the safe direction).
 */
export function plaintextRetentionMs(): number {
  const raw = (process.env.VAULT_PLAINTEXT_RETENTION_DAYS ?? "").trim();
  const days = raw === "" ? DEFAULT_RETENTION_DAYS : Number(raw);
  const safe = Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
  return safe * 24 * 60 * 60_000;
}

/** Test seams. Production never replaces these. */
export const nullOutHooks: {
  /** Runs after the compare passed, right before the guarded clearing write. */
  beforeWrite: (table: NullOutTable, rowKey: string) => Promise<void> | void;
} = { beforeWrite: () => {} };

export interface NullOutCounts {
  cleared: number;
  mismatch: number;
  skipped: number;
  /** First few mismatched ids per table, for one log line per table per pass. */
  mismatchIds: Partial<Record<NullOutTable, string[]>>;
}

/** The sealed JSON a search row's plaintext columns stand for (same shape as the backfill's). */
function searchJson(body: string, vectorText: string | null, tokens: string | null): Buffer {
  const vector = vectorText === null ? null : (JSON.parse(vectorText) as number[]);
  return Buffer.from(JSON.stringify({ body, vector, tokens }), "utf8");
}

function mismatch(table: NullOutTable, key: string, counts: NullOutCounts): void {
  counts.mismatch += 1;
  inc(`nullout.${table}.mismatch`);
  // Ids only, never a byte of content; logged once per table per pass.
  const ids = (counts.mismatchIds[table] ??= []);
  if (ids.length < MISMATCH_IDS_LOGGED) ids.push(key);
}

async function clear(
  table: NullOutTable,
  key: string,
  sql: string,
  params: unknown[],
  db: Queryable,
  counts: NullOutCounts,
): Promise<void> {
  await nullOutHooks.beforeWrite(table, key);
  const { rowCount } = await db.query(sql, params);
  if (rowCount) {
    counts.cleared += rowCount;
    inc(`nullout.${table}.cleared`, rowCount);
  } else {
    counts.skipped += 1;
    inc(`nullout.${table}.skipped`);
  }
}

/** Open, never throw: a sealed copy that cannot be opened is a mismatch. */
function tryOpen(fn: () => Buffer): Buffer | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

const VAULT_DOCS = `(SELECT id FROM notes WHERE vault_id = $1 UNION ALL SELECT id FROM files WHERE vault_id = $1)`;

interface BatchResult {
  rows: number;
  last: string | null;
}

async function batch(
  table: NullOutTable,
  c: DocCrypto,
  after: string | null,
  limit: number,
  db: Queryable,
  counts: NullOutCounts,
): Promise<BatchResult> {
  switch (table) {
    case "doc_updates": {
      const { rows } = await db.query<{ id: string; doc_id: string; update: Buffer; update_enc: Buffer }>(
        `SELECT id::text AS id, doc_id, update, update_enc FROM doc_updates
          WHERE doc_id IN ${VAULT_DOCS} AND id > $2::bigint
            AND update IS NOT NULL AND update_enc IS NOT NULL
          ORDER BY id LIMIT $3`,
        [c.vaultId, after ?? "0", limit],
      );
      for (const r of rows) {
        const opened = tryOpen(() => openDocBytes(c, "doc_updates.update", r.doc_id, r.update_enc, null) ?? Buffer.alloc(0));
        if (!opened || !opened.equals(r.update)) {
          mismatch(table, r.id, counts);
          continue;
        }
        await clear(
          table,
          r.id,
          `UPDATE doc_updates SET update = NULL
            WHERE id = $1::bigint AND update = $2 AND update_enc = $3`,
          [r.id, r.update, r.update_enc],
          db,
          counts,
        );
      }
      return { rows: rows.length, last: rows.at(-1)?.id ?? after };
    }
    case "doc_snapshots": {
      const { rows } = await db.query<{ doc_id: string; snapshot: Buffer; snapshot_enc: Buffer; seq: string | null }>(
        `SELECT doc_id, snapshot, snapshot_enc, seq::text AS seq FROM doc_snapshots
          WHERE doc_id IN ${VAULT_DOCS} AND doc_id > $2
            AND snapshot IS NOT NULL AND snapshot_enc IS NOT NULL
          ORDER BY doc_id LIMIT $3`,
        [c.vaultId, after ?? "", limit],
      );
      for (const r of rows) {
        const opened = tryOpen(
          () => openDocBytes(c, "doc_snapshots.snapshot", r.doc_id, r.snapshot_enc, null) ?? Buffer.alloc(0),
        );
        if (!opened || !opened.equals(r.snapshot)) {
          mismatch(table, r.doc_id, counts);
          continue;
        }
        await clear(
          table,
          r.doc_id,
          `UPDATE doc_snapshots SET snapshot = NULL
            WHERE doc_id = $1 AND snapshot = $2 AND snapshot_enc = $3 AND seq IS NOT DISTINCT FROM $4::bigint`,
          [r.doc_id, r.snapshot, r.snapshot_enc, r.seq],
          db,
          counts,
        );
      }
      return { rows: rows.length, last: rows.at(-1)?.doc_id ?? after };
    }
    case "note_index":
    case "blob_text": {
      const isNote = table === "note_index";
      const keyCol = isNote ? "doc_id" : "blob_id";
      const refCol = isNote ? ", ref_text" : ", NULL::text AS ref_text";
      const { rows } = await db.query<{
        key: string;
        content: string;
        vector: string | null;
        search_tokens: string | null;
        ref_text: string | null;
        search_enc: Buffer;
      }>(
        `SELECT ${keyCol} AS key, content, vector::text AS vector, search_tokens${refCol}, search_enc
           FROM ${table}
          WHERE vault_id = $1 AND ${keyCol} > $2 AND search_enc IS NOT NULL
            AND (content <> '' OR vector IS NOT NULL OR search_tokens IS NOT NULL${isNote ? " OR ref_text IS NOT NULL" : ""})
          ORDER BY ${keyCol} LIMIT $3`,
        [c.vaultId, after ?? "", limit],
      );
      for (const r of rows) {
        const opened = tryOpen(() =>
          Buffer.from(
            JSON.stringify(isNote ? openSearchRow(c, r.key, r.search_enc) : openBlobTextRow(c, r.key, r.search_enc)),
            "utf8",
          ),
        );
        if (!opened || !opened.equals(searchJson(r.content, r.vector, r.search_tokens))) {
          mismatch(table, r.key, counts);
          continue;
        }
        await clear(
          table,
          r.key,
          `UPDATE ${table} SET content = '', vector = NULL, search_tokens = NULL${isNote ? ", ref_text = NULL" : ""}
            WHERE ${keyCol} = $1 AND vault_id = $2 AND search_enc = $3 AND content = $4
              AND vector::text IS NOT DISTINCT FROM $5
              AND search_tokens IS NOT DISTINCT FROM $6
              ${isNote ? "AND ref_text IS NOT DISTINCT FROM $7" : "AND $7::text IS NULL"}`,
          [r.key, c.vaultId, r.search_enc, r.content, r.vector, r.search_tokens, r.ref_text],
          db,
          counts,
        );
      }
      return { rows: rows.length, last: rows.at(-1)?.key ?? after };
    }
    case "note_texts": {
      const [afterDoc, afterSha] = after ? (JSON.parse(after) as [string, string]) : ["", ""];
      const { rows } = await db.query<{ doc_id: string; sha256: string; content: string; content_enc: Buffer }>(
        `SELECT doc_id, sha256, content, content_enc FROM note_texts
          WHERE vault_id = $1 AND (doc_id, sha256) > ($2, $3) AND content <> '' AND content_enc IS NOT NULL
          ORDER BY doc_id, sha256 LIMIT $4`,
        [c.vaultId, afterDoc, afterSha, limit],
      );
      for (const r of rows) {
        const key = `${r.doc_id}:${r.sha256}`;
        const opened = tryOpen(() => openNoteTextBytes(c, r.doc_id, r.sha256, r.content_enc));
        if (!opened || !opened.equals(Buffer.from(r.content, "utf8"))) {
          mismatch(table, key, counts);
          continue;
        }
        await clear(
          table,
          key,
          `UPDATE note_texts SET content = ''
            WHERE doc_id = $1 AND sha256 = $2 AND vault_id = $3 AND content = $4 AND content_enc = $5`,
          [r.doc_id, r.sha256, c.vaultId, r.content, r.content_enc],
          db,
          counts,
        );
      }
      const last = rows.at(-1);
      return { rows: rows.length, last: last ? JSON.stringify([last.doc_id, last.sha256]) : after };
    }
    case "note_versions":
    case "vault_checkpoint_docs": {
      const versions = table === "note_versions";
      const { rows } = await db.query<{
        key: string;
        doc_id: string;
        sha256: string;
        content: string;
        content_enc: Buffer;
      }>(
        versions
          ? `SELECT v.id::text AS key, v.doc_id, v.sha256, v.content, t.content_enc
               FROM note_versions v
               JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256 AND t.vault_id = v.vault_id
              WHERE v.vault_id = $1 AND v.id > $2::bigint AND v.content IS NOT NULL AND t.content_enc IS NOT NULL
              ORDER BY v.id LIMIT $3`
          : `SELECT d.checkpoint_id || ':' || d.doc_id AS key, d.doc_id, d.sha256, d.content, t.content_enc
               FROM vault_checkpoint_docs d
               JOIN vault_checkpoints k ON k.id = d.checkpoint_id
               JOIN note_texts t ON t.doc_id = d.doc_id AND t.sha256 = d.sha256 AND t.vault_id = k.vault_id
              WHERE k.vault_id = $1 AND d.checkpoint_id || ':' || d.doc_id > $2
                AND d.content IS NOT NULL AND t.content_enc IS NOT NULL
              ORDER BY d.checkpoint_id || ':' || d.doc_id LIMIT $3`,
        [c.vaultId, after ?? (versions ? "0" : ""), limit],
      );
      for (const r of rows) {
        const opened = tryOpen(() => openNoteTextBytes(c, r.doc_id, r.sha256, r.content_enc));
        // The inline row is read through its (doc, sha) after clearing, so both
        // the hash and the sealed bytes must match the inline text exactly.
        if (!opened || sha256Hex(r.content) !== r.sha256 || !opened.equals(Buffer.from(r.content, "utf8"))) {
          mismatch(table, r.key, counts);
          continue;
        }
        const guardSealed = `EXISTS (SELECT 1 FROM note_texts t WHERE t.doc_id = $2 AND t.sha256 = $3 AND t.content_enc = $5)`;
        await clear(
          table,
          r.key,
          versions
            ? `UPDATE note_versions SET content = NULL
                WHERE id = $1::bigint AND doc_id = $2 AND sha256 = $3 AND content = $4 AND ${guardSealed}`
            : `UPDATE vault_checkpoint_docs SET content = NULL
                WHERE checkpoint_id || ':' || doc_id = $1 AND doc_id = $2 AND sha256 = $3 AND content = $4 AND ${guardSealed}`,
          [r.key, r.doc_id, r.sha256, r.content, r.content_enc],
          db,
          counts,
        );
      }
      return { rows: rows.length, last: rows.at(-1)?.key ?? after };
    }
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export interface PlaintextStatus {
  /** Rows per table that still hold plaintext in any content column. */
  byTable: Record<NullOutTable, number>;
  total: number;
}

/** Rows still holding plaintext content, sealed copy or not. */
export async function plaintextStatus(vaultId: string, db: Queryable = defaultPool): Promise<PlaintextStatus> {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM doc_updates WHERE doc_id IN ${VAULT_DOCS} AND update IS NOT NULL) AS doc_updates,
       (SELECT count(*) FROM doc_snapshots WHERE doc_id IN ${VAULT_DOCS} AND snapshot IS NOT NULL) AS doc_snapshots,
       (SELECT count(*) FROM note_index WHERE vault_id = $1
         AND (content <> '' OR vector IS NOT NULL OR search_tokens IS NOT NULL OR ref_text IS NOT NULL)) AS note_index,
       (SELECT count(*) FROM blob_text WHERE vault_id = $1
         AND (content <> '' OR vector IS NOT NULL OR search_tokens IS NOT NULL)) AS blob_text,
       (SELECT count(*) FROM note_texts WHERE vault_id = $1 AND content <> '') AS note_texts,
       (SELECT count(*) FROM note_versions WHERE vault_id = $1 AND content IS NOT NULL) AS note_versions,
       (SELECT count(*) FROM vault_checkpoint_docs d JOIN vault_checkpoints c ON c.id = d.checkpoint_id
         WHERE c.vault_id = $1 AND d.content IS NOT NULL) AS vault_checkpoint_docs`,
    [vaultId],
  );
  const r = rows[0] ?? {};
  const byTable = Object.fromEntries(NULL_OUT_TABLES.map((t) => [t, Number(r[t] ?? 0)])) as Record<
    NullOutTable,
    number
  >;
  return { byTable, total: NULL_OUT_TABLES.reduce((n, t) => n + byTable[t], 0) };
}

// ── runner ──────────────────────────────────────────────────────────────────

interface NullOutState {
  tables: Partial<Record<NullOutTable, { after: string | null; done: boolean }>>;
  /** ISO time the last full pass ended. */
  passedAt?: string;
  /** ISO time the gate last counted (plaintext + sealable rows). */
  checkedAt?: string;
  mismatches?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Cursors = BackfillCursors & { nullOut?: NullOutState; plaintextRemaining?: number; sealedAt?: string };

export type NullOutOutcome =
  | "disabled"
  | "locked"
  | "not_keyed"
  | "sealed"
  | "waiting"
  | "no_key"
  | "budget"
  | "remaining";

export interface NullOutOptions {
  db?: ClientSource;
  cache?: VaultKeyCache;
  batchSize?: number;
  maxBatches?: number;
  throttleMs?: number;
  /** Ignore the once-an-hour pass limit (tests). */
  force?: boolean;
  now?: () => number;
}

async function loadState(vaultId: string, db: Queryable): Promise<{ phase: string; cursors: Cursors } | null> {
  const { rows } = await db.query<{ phase: string; cursors: Cursors | null }>(
    "SELECT phase, cursors FROM vault_crypto_state WHERE vault_id = $1",
    [vaultId],
  );
  return rows[0] ? { phase: rows[0].phase, cursors: rows[0].cursors ?? ({} as Cursors) } : null;
}

/** Merge only our own keys into `cursors`, so a concurrent backfill save is not overwritten. */
async function saveOwn(
  vaultId: string,
  patch: { nullOut?: NullOutState; plaintextRemaining?: number; sealedAt?: string },
  db: Queryable,
  phase?: "sealed",
): Promise<void> {
  await db.query(
    `UPDATE vault_crypto_state
        SET cursors = cursors || $2::jsonb,
            phase = COALESCE($3, phase),
            updated_at = now()
      WHERE vault_id = $1`,
    [vaultId, JSON.stringify(patch), phase ?? null],
  );
}

/**
 * Record how much plaintext is left; at zero the vault is `sealed`. Cheap to
 * call: one counting query. A vault keyed from creation reaches `sealed` on its
 * first run, with no retention wait (it never had plaintext).
 */
export async function recordPlaintextStatus(vaultId: string, db: Queryable = defaultPool): Promise<number> {
  const status = await plaintextStatus(vaultId, db);
  if (status.total === 0) {
    await saveOwn(vaultId, { plaintextRemaining: 0, sealedAt: new Date().toISOString() }, db, "sealed");
  } else {
    await saveOwn(vaultId, { plaintextRemaining: status.total }, db);
  }
  return status.total;
}

/**
 * Clear one keyed vault's verified plaintext. Session advisory lock per vault
 * (`locked` when another instance holds it). Gates, all re-checked per run:
 * keyed, key held, backfill complete with a fresh zero `encryptionStatus`,
 * retention elapsed since that completion.
 */
export async function nullOutVault(vaultId: string, opts: NullOutOptions = {}): Promise<NullOutOutcome> {
  if (!vaultKeysEnabled()) return "disabled";
  const db = opts.db ?? defaultPool;
  const cache = opts.cache ?? vaultKeyCache;
  const batchSize = opts.batchSize ?? NULL_OUT_BATCH;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const throttleMs = opts.throttleMs ?? NULL_OUT_THROTTLE_MS;
  const now = opts.now ?? Date.now;

  const lockClient = await db.connect();
  const lockKey = `crypto-nullout:${vaultId}`;
  let locked = false;
  try {
    const { rows } = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [lockKey],
    );
    locked = rows[0]?.ok === true;
    if (!locked) return "locked";

    const state = await loadState(vaultId, db);
    if (!state) return "not_keyed";
    if (state.phase === "sealed") return "sealed";
    const nullOut: NullOutState = state.cursors.nullOut ?? { tables: {} };
    // A pass stopped half way (budget, key eviction) resumes without waiting.
    const midPass = !nullOut.passedAt && Object.values(nullOut.tables).some((t) => t && !t.done);
    // The counts below are heavy: at most once per recheck interval per vault.
    const recent = (iso: string | undefined) => !!iso && now() - Date.parse(iso) < NULL_OUT_RECHECK_MS;
    if (!opts.force && !midPass && recent(nullOut.checkedAt)) return "remaining";
    nullOut.checkedAt = new Date(now()).toISOString();
    await saveOwn(vaultId, { nullOut }, db);
    // Nothing plaintext at all (a vault keyed from creation): sealed now.
    if ((await recordPlaintextStatus(vaultId, db)) === 0) return "sealed";

    const completed = Date.parse(state.cursors.completedAt ?? "");
    if (!Number.isFinite(completed) || now() - completed < plaintextRetentionMs()) return "waiting";
    if (!opts.force && !midPass && recent(nullOut.passedAt)) return "remaining";
    // The backfill's completion is a cached verdict: count again before trusting it.
    if ((await encryptionStatus(vaultId, db)).total !== 0) return "waiting";
    if (nullOut.passedAt) nullOut.tables = {};
    nullOut.passedAt = undefined;

    const counts: NullOutCounts = { cleared: 0, mismatch: 0, skipped: 0, mismatchIds: {} };
    let batches = 0;
    for (const table of NULL_OUT_TABLES) {
      const cur = nullOut.tables[table] ?? { after: null, done: false };
      nullOut.tables[table] = cur;
      while (!cur.done) {
        if (batches >= maxBatches) {
          await saveOwn(vaultId, { nullOut }, db);
          return "budget";
        }
        const crypto = await heldCrypto(vaultId, cache, db);
        if (!crypto) {
          await saveOwn(vaultId, { nullOut }, db);
          return "no_key";
        }
        try {
          const res = await batch(table, crypto, cur.after, batchSize, db, counts);
          cur.after = res.last;
          if (res.rows < batchSize) cur.done = true;
        } finally {
          crypto.key.fill(0);
        }
        batches += 1;
        await saveOwn(vaultId, { nullOut }, db);
        if (throttleMs > 0) await sleep(throttleMs);
      }
      const ids = counts.mismatchIds[table];
      if (ids?.length) {
        console.warn(`[null-out] vault ${vaultId} ${table}: rows kept (sealed copy differs), first ids: ${ids.join(", ")}`);
      }
    }
    nullOut.passedAt = new Date(now()).toISOString();
    nullOut.mismatches = counts.mismatch;
    await saveOwn(vaultId, { nullOut }, db);
    if (counts.mismatch > 0) {
      console.warn(`[null-out] vault ${vaultId}: ${counts.mismatch} rows kept (sealed copy differs from plaintext)`);
    }
    return (await recordPlaintextStatus(vaultId, db)) === 0 ? "sealed" : "remaining";
  } finally {
    if (locked) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => {});
    }
    lockClient.release();
  }
}

/** What `keys/mine` reports: cached by the worker, never counted per request. */
export async function encryptionProgress(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<{ fullyEncrypted: boolean; plaintextRemaining: number | null }> {
  const { rows } = await db.query<{ phase: string; remaining: string | null }>(
    "SELECT phase, cursors->>'plaintextRemaining' AS remaining FROM vault_crypto_state WHERE vault_id = $1",
    [vaultId],
  );
  const r = rows[0];
  if (!r) return { fullyEncrypted: false, plaintextRemaining: null };
  if (r.phase === "sealed") return { fullyEncrypted: true, plaintextRemaining: 0 };
  const n = r.remaining === null ? null : Number(r.remaining);
  return { fullyEncrypted: false, plaintextRemaining: n === null || !Number.isFinite(n) ? null : n };
}
