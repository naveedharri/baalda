import * as Y from "yjs";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";

/**
 * Server-side binary Yjs store (spec 02 §5A, 03 §3).
 *
 * - `doc_updates`: append-only log of incremental binary updates (BYTEA).
 * - `doc_snapshots`: one merged snapshot per doc, to bound replay length.
 *
 * We store BINARY Y.Doc updates only — never parsed markdown/JSON. Loading a
 * doc = apply the snapshot, then replay the update log, in order.
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * Build a single merged update for a doc: snapshot (if any) + all logged
 * updates, in insertion order. Returns null if the doc has no state yet.
 */
export async function loadDocState(
  docId: string,
  db: Queryable = defaultPool,
): Promise<Uint8Array | null> {
  const snap = await db.query<{ snapshot: Buffer | null }>(
    "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
    [docId],
  );
  const updates = await db.query<{ update: Buffer }>(
    "SELECT update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
    [docId],
  );

  const snapshotBuf = snap.rows[0]?.snapshot ?? null;
  if (!snapshotBuf && updates.rows.length === 0) return null;

  const doc = new Y.Doc();
  try {
    if (snapshotBuf) Y.applyUpdate(doc, new Uint8Array(snapshotBuf));
    for (const row of updates.rows) {
      Y.applyUpdate(doc, new Uint8Array(row.update));
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Backfill diff for the vault channel (spec 05 §3.1). Rebuilds the doc, then
 * returns only the ops the client is missing relative to `clientStateVector`
 * (via `Y.encodeStateAsUpdate(doc, sv)`) plus the server's current state vector.
 * When the client's vector already equals the server's, `upToDate` is true and
 * the caller sends nothing — this is what makes an idle reconnect ~free.
 *
 * Returns null when the doc has no state at all (nothing to send).
 */
export interface DocDiff {
  update: Uint8Array;
  serverStateVector: Uint8Array;
  upToDate: boolean;
}

export async function loadDocDiff(
  docId: string,
  clientStateVector: Uint8Array | null,
  db: Queryable = defaultPool,
): Promise<DocDiff | null> {
  const snap = await db.query<{ snapshot: Buffer | null }>(
    "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
    [docId],
  );
  const updates = await db.query<{ update: Buffer }>(
    "SELECT update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
    [docId],
  );
  const snapshotBuf = snap.rows[0]?.snapshot ?? null;
  if (!snapshotBuf && updates.rows.length === 0) return null;

  const doc = new Y.Doc();
  try {
    if (snapshotBuf) Y.applyUpdate(doc, new Uint8Array(snapshotBuf));
    for (const row of updates.rows) {
      Y.applyUpdate(doc, new Uint8Array(row.update));
    }
    const serverStateVector = Y.encodeStateVector(doc);
    const upToDate =
      clientStateVector != null && bytesEqual(clientStateVector, serverStateVector);
    const update = upToDate
      ? new Uint8Array(0)
      : Y.encodeStateAsUpdate(doc, clientStateVector ?? undefined);
    return { update, serverStateVector, upToDate };
  } finally {
    doc.destroy();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Append one incremental update to the log, then compact if the log is long. */
export async function appendUpdate(
  docId: string,
  update: Uint8Array,
  db: Queryable = defaultPool,
  threshold: number = config.compactionThreshold,
): Promise<{ compacted: boolean }> {
  await db.query(
    "INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)",
    [docId, Buffer.from(update)],
  );

  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM doc_updates WHERE doc_id = $1",
    [docId],
  );
  const count = Number.parseInt(rows[0]?.count ?? "0", 10);
  if (count > threshold) {
    await compact(docId, db);
    return { compacted: true };
  }
  return { compacted: false };
}

/**
 * Merge snapshot + update log into one snapshot row and truncate the log.
 * Captures the current max update id first, then deletes only rows up to that
 * id so concurrently-appended updates are never lost.
 */
export async function compact(
  docId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  const snap = await db.query<{ snapshot: Buffer | null }>(
    "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
    [docId],
  );
  const updates = await db.query<{ id: string; update: Buffer }>(
    "SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
    [docId],
  );
  if (updates.rows.length === 0) return;

  const doc = new Y.Doc();
  let maxId = "0";
  try {
    const snapshotBuf = snap.rows[0]?.snapshot ?? null;
    if (snapshotBuf) Y.applyUpdate(doc, new Uint8Array(snapshotBuf));
    for (const row of updates.rows) {
      Y.applyUpdate(doc, new Uint8Array(row.update));
      maxId = row.id;
    }
    const merged = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));

    await db.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (doc_id) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             state_vector = EXCLUDED.state_vector,
             seq = EXCLUDED.seq,
             updated_at = now()`,
      [docId, merged, stateVector, maxId],
    );
    await db.query(
      "DELETE FROM doc_updates WHERE doc_id = $1 AND id <= $2",
      [docId, maxId],
    );
  } finally {
    doc.destroy();
  }
}

export async function countUpdates(
  docId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM doc_updates WHERE doc_id = $1",
    [docId],
  );
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}
