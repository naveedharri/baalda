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
//     is a separate, later, delayed step (not built). Readers already prefer
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
// Not covered (no sealed column exists): pre-038 inline `note_versions.content`
// / `vault_checkpoint_docs.content`, Postgres `blobs.data`,
// `checkpoint_blob_bytes`, skills files. `encryptionStatus` reports the inline
// version/checkpoint rows so the null-out gate cannot overlook them.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { inc } from "../metrics/sync-metrics.js";
import { openBlobTextRow, openSearchRow, sealBlobTextRow, sealSearchRow } from "../index/sealed-index.js";
import { openNoteTextBytes, sealNoteText } from "../versions/texts.js";
import { indexDoc } from "../index/indexer.js";
import { vaultKeysEnabled } from "./config.js";
import { openDocBytes, sealDocBytes, type DocCrypto } from "./doc-crypto.js";
import { vaultKeyCache, type VaultKeyCache } from "./key-cache.js";
import { verifyVk } from "./vk-check.js";

type Queryable = Pick<pg.Pool, "query">;
type ClientSource = Queryable & { connect: () => Promise<pg.PoolClient> };

/** Fixed order; a table is finished before the next starts. */
export const BACKFILL_TABLES = ["doc_updates", "doc_snapshots", "note_index", "blob_text", "note_texts"] as const;
export type BackfillTable = (typeof BACKFILL_TABLES)[number];

export const BACKFILL_BATCH = 200;
export const BACKFILL_THROTTLE_MS = 50;
/** Batches one vault may run per tick, so one big vault cannot starve others. */
export const BACKFILL_BATCHES_PER_TICK = 50;
export const BACKFILL_TICK_MS = 30_000;
/** A completed vault is re-counted at most this often (late plaintext rows). */
export const BACKFILL_RECHECK_MS = 60 * 60_000;

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
    `SELECT u.id::text AS id, u.doc_id, u.update
       FROM doc_updates u
      WHERE u.doc_id IN ${VAULT_DOCS}
        AND u.id > $2::bigint
        AND u.update_enc IS NULL AND u.update IS NOT NULL
      ORDER BY u.id
      LIMIT $3`,
    [c.vaultId, after ?? "0", limit],
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
  return { rows: rows.length, last: rows.at(-1)?.id ?? after };
}

async function batchDocSnapshots(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{ doc_id: string; snapshot: Buffer; seq: string | null }>(
    `SELECT s.doc_id, s.snapshot, s.seq::text AS seq
       FROM doc_snapshots s
      WHERE s.doc_id IN ${VAULT_DOCS}
        AND s.doc_id > $2
        AND s.snapshot_enc IS NULL AND s.snapshot IS NOT NULL
      ORDER BY s.doc_id
      LIMIT $3`,
    [c.vaultId, after ?? "", limit],
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
  return { rows: rows.length, last: rows.at(-1)?.doc_id ?? after };
}

/** The sealed JSON a search row's plaintext columns stand for. */
function searchJson(body: string, vectorText: string | null, tokens: string | null): Buffer {
  const vector = vectorText === null ? null : (JSON.parse(vectorText) as number[]);
  return Buffer.from(JSON.stringify({ body, vector, tokens }), "utf8");
}

async function batchNoteIndex(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{
    doc_id: string;
    content: string;
    vector: string | null;
    search_tokens: string | null;
    updated_at: string;
  }>(
    `SELECT doc_id, content, vector::text AS vector, search_tokens, updated_at::text AS updated_at
       FROM note_index
      WHERE vault_id = $1 AND doc_id > $2 AND search_enc IS NULL
      ORDER BY doc_id
      LIMIT $3`,
    [c.vaultId, after ?? "", limit],
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
  return { rows: rows.length, last: rows.at(-1)?.doc_id ?? after };
}

async function batchBlobText(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const { rows } = await db.query<{
    blob_id: string;
    content: string;
    vector: string | null;
    search_tokens: string | null;
    updated_at: string;
  }>(
    `SELECT blob_id, content, vector::text AS vector, search_tokens, updated_at::text AS updated_at
       FROM blob_text
      WHERE vault_id = $1 AND blob_id > $2 AND search_enc IS NULL
      ORDER BY blob_id
      LIMIT $3`,
    [c.vaultId, after ?? "", limit],
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
  return { rows: rows.length, last: rows.at(-1)?.blob_id ?? after };
}

async function batchNoteTexts(c: DocCrypto, after: string | null, limit: number, db: Queryable): Promise<BatchResult> {
  const [afterDoc, afterSha] = after ? (JSON.parse(after) as [string, string]) : ["", ""];
  const { rows } = await db.query<{ doc_id: string; sha256: string; content: string }>(
    `SELECT doc_id, sha256, content
       FROM note_texts
      WHERE vault_id = $1 AND (doc_id, sha256) > ($2, $3) AND content_enc IS NULL
      ORDER BY doc_id, sha256
      LIMIT $4`,
    [c.vaultId, afterDoc, afterSha, limit],
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
  return { rows: rows.length, last: last ? JSON.stringify([last.doc_id, last.sha256]) : after };
}

// ── status ──────────────────────────────────────────────────────────────────

export interface EncryptionStatus {
  /** Rows per table with plaintext and no sealed copy (what the backfill seals). */
  remaining: Record<BackfillTable, number>;
  /**
   * Pre-038 inline version/checkpoint texts. No sealed column exists for them
   * yet, so the backfill does not touch them; the null-out gate must.
   */
  unsupported: { note_versions_inline: number; checkpoint_docs_inline: number };
  /** Sum of `remaining` (0 = every sealable row has a verified sealed copy). */
  total: number;
}

/** Remaining plaintext-only rows per table, for an admin script and the null-out gate. */
export async function encryptionStatus(vaultId: string, db: Queryable = defaultPool): Promise<EncryptionStatus> {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM doc_updates
         WHERE doc_id IN ${VAULT_DOCS} AND update_enc IS NULL AND update IS NOT NULL) AS doc_updates,
       (SELECT count(*) FROM doc_snapshots
         WHERE doc_id IN ${VAULT_DOCS} AND snapshot_enc IS NULL AND snapshot IS NOT NULL) AS doc_snapshots,
       (SELECT count(*) FROM note_index WHERE vault_id = $1 AND search_enc IS NULL) AS note_index,
       (SELECT count(*) FROM blob_text WHERE vault_id = $1 AND search_enc IS NULL) AS blob_text,
       (SELECT count(*) FROM note_texts WHERE vault_id = $1 AND content_enc IS NULL) AS note_texts,
       (SELECT count(*) FROM note_versions WHERE vault_id = $1 AND content IS NOT NULL) AS note_versions_inline,
       (SELECT count(*) FROM vault_checkpoint_docs d JOIN vault_checkpoints c ON c.id = d.checkpoint_id
         WHERE c.vault_id = $1 AND d.content IS NOT NULL) AS checkpoint_docs_inline`,
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
      note_versions_inline: Number(r.note_versions_inline ?? 0),
      checkpoint_docs_inline: Number(r.checkpoint_docs_inline ?? 0),
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
  return { tables: c.tables ?? {}, passes: c.passes ?? 0, completedAt: c.completedAt, checkedAt: c.checkedAt };
}

async function saveCursors(vaultId: string, cursors: BackfillCursors, db: Queryable): Promise<void> {
  await db.query(
    "UPDATE vault_crypto_state SET cursors = $2::jsonb, updated_at = now() WHERE vault_id = $1",
    [vaultId, JSON.stringify(cursors)],
  );
}

/**
 * The cached key, verified against the vault's CURRENT check and generation.
 * Null: no member connected, the vault is not keyed, or a rotation moved the
 * generation (never seal under a key the vault no longer uses).
 */
async function heldCrypto(vaultId: string, cache: VaultKeyCache, db: Queryable): Promise<DocCrypto | null> {
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

/**
 * Live notes of a vault whose search row is missing or older than the note's
 * latest content change. A keyed vault's indexer DEFERS (writes nothing) while
 * no member holds the key, so a note written then — by MCP, or a socket that
 * closed before its debounce fired — would otherwise stay unsearchable.
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

/** Index what the keyed vault's indexer had to skip; returns how many were indexed. */
export async function catchUpIndex(vaultId: string, db: Queryable = defaultPool): Promise<number> {
  let n = 0;
  for (const docId of await staleIndexDocs(vaultId, db)) {
    try {
      if (await indexDoc(docId, db)) n += 1;
    } catch (err) {
      console.error(`[backfill] index catch-up failed for ${docId}:`, err);
    }
  }
  if (n > 0) inc("backfill.index_catchup", n);
  return n;
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
    await catchUpIndex(vaultId, db);
    if (cursors.completedAt) {
      const checked = Date.parse(cursors.checkedAt ?? cursors.completedAt);
      if (Number.isFinite(checked) && Date.now() - checked < BACKFILL_RECHECK_MS) return "complete";
    }

    let batches = 0;
    let prevTotal = Number.POSITIVE_INFINITY;
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
            if (res.rows < batchSize) cur.done = true;
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
      // those tables start over. Bounded by the batch budget.
      const status = await encryptionStatus(vaultId, db);
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
        await backfillVault(vault_id, { maxBatches: BACKFILL_BATCHES_PER_TICK, ...opts });
      } catch (err) {
        console.error(`[backfill] vault ${vault_id} failed:`, err);
      }
    }
  } finally {
    running = false;
  }
}

const kicked = new Set<string>();

/**
 * A member's key for `vaultId` just reached the cache (vault channel hello):
 * run the worker for that vault now instead of waiting for the next tick, so
 * notes indexed-while-keyless become searchable at once. Deduplicated per vault.
 */
export function kickVaultBackfill(vaultId: string, opts: BackfillOptions = {}): Promise<void> {
  if (kicked.has(vaultId) || !vaultKeysEnabled()) return Promise.resolve();
  kicked.add(vaultId);
  return backfillVault(vaultId, { maxBatches: BACKFILL_BATCHES_PER_TICK, ...opts })
    .then(() => undefined)
    .catch((err) => console.error(`[backfill] vault ${vaultId} failed:`, err))
    .finally(() => kicked.delete(vaultId));
}

/** Started only from `index.ts`. */
export function startCryptoBackfill(): void {
  if (timer) return;
  timer = setInterval(() => void backfillTick(), BACKFILL_TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopCryptoBackfill(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
