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

/** Anything that can run a query — the pool, or a test double counting calls. */
export type Queryable = Pick<pg.Pool, "query">;

/**
 * Build a single merged update for a doc: snapshot (if any) + all logged
 * updates, in insertion order. Returns null if the doc has no state yet.
 *
 * Merges with `Y.mergeUpdates` rather than replaying into a throwaway `Y.Doc`.
 * Same bytes-in/state-out, minus the doc: building one costs the full struct
 * graph of the note in heap, and this runs per doc — the whole point of the
 * relay is that server memory tracks docs being *edited*, not docs that exist.
 *
 * One deliberate difference: a `Y.Doc` (gc on) drops deleted content as it
 * applies, so the old path returned a GC'd update while `mergeUpdates` keeps
 * tombstoned content. Bounded and small in practice — `compact()` still writes
 * a GC'd snapshot, so the un-GC'd part is only the tail of the update log
 * (≤ `COMPACTION_THRESHOLD` updates).
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

  return mergeParts(snapshotBuf, updates.rows);
}

/**
 * Merge a snapshot + update log into one V1 update. V1 only, everywhere:
 * yjs#687 (open) reports corruption in the V2 merge functions, and mixing
 * encodings across the snapshot/log boundary would be unrecoverable.
 */
function mergeParts(
  snapshotBuf: Buffer | null,
  updateRows: Array<{ update: Buffer }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (snapshotBuf) parts.push(new Uint8Array(snapshotBuf));
  for (const row of updateRows) parts.push(new Uint8Array(row.update));
  // A lone part is already a complete update; merging it would just re-encode.
  return parts.length === 1 ? parts[0] : Y.mergeUpdates(parts);
}

/**
 * Backfill diff for the vault channel (spec 05 §3.1). Returns only the ops the
 * client is missing relative to `clientStateVector`, plus the server's current
 * state vector. When the client's vector already equals the server's,
 * `upToDate` is true and the caller sends nothing — this is what makes an idle
 * reconnect ~free.
 *
 * Returns null when the doc has no state at all (nothing to send).
 *
 * Two layers keep a reconnect from paying for content nobody needs — the whole
 * cost of `/vault-sync` used to be one full doc rebuild per readable doc, on
 * every reconnect, whether or not the client was already current:
 *
 *  1. **The probe.** `compact()` has always written `doc_snapshots.state_vector`
 *     and nothing ever read it. One narrow row (no BYTEA) now answers the common
 *     case — compacted doc, empty update log, client already current — so the
 *     up-to-date reconnect never touches the snapshot blob at all.
 *  2. **No Y.Doc on the slow path.** `mergeUpdates` + `encodeStateVectorFromUpdate`
 *     + `diffUpdate` compute the same three values off the raw bytes. See
 *     `loadDocState` for why the doc is worth avoiding.
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
  // Probe: does a snapshot exist, is its stored state vector usable, and is
  // anything sitting in the log on top of it? Deliberately selects no BYTEA.
  const probe = await db.query<{ state_vector: Buffer | null; pending: boolean }>(
    `SELECT s.state_vector,
            EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = $1) AS pending
       FROM doc_snapshots s
      WHERE s.doc_id = $1`,
    [docId],
  );
  const row = probe.rows[0];
  if (!row) {
    // No snapshot row, so the probe learned nothing about the log — ask.
    // Cheap, and it short-circuits the never-written doc, which is the shape
    // most of a vault's registry is right after a bulk register.
    const { rows } = await db.query<{ pending: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM doc_updates WHERE doc_id = $1) AS pending",
      [docId],
    );
    if (!rows[0]?.pending) return null;
  } else if (row.state_vector && !row.pending && clientStateVector) {
    const serverStateVector = new Uint8Array(row.state_vector);
    if (bytesEqual(clientStateVector, serverStateVector)) {
      return { update: new Uint8Array(0), serverStateVector, upToDate: true };
    }
  }
  // Fall through: uncompacted doc, a pre-`state_vector` snapshot row (the column
  // is nullable and older rows have it NULL), a client with no vector, or a
  // client that is genuinely behind.

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

  const merged = mergeParts(snapshotBuf, updates.rows);
  const serverStateVector = Y.encodeStateVectorFromUpdate(merged);
  const upToDate =
    clientStateVector != null && bytesEqual(clientStateVector, serverStateVector);
  const update = upToDate
    ? new Uint8Array(0)
    : clientStateVector
      ? Y.diffUpdate(merged, clientStateVector)
      : merged;
  return { update, serverStateVector, upToDate };
}

/**
 * Which of `docIds` have NO server-side content at all — no snapshot, no logged
 * update? One query for the whole set, so the vault channel can answer it once
 * per connect instead of probing per doc.
 *
 * Exists because of the 2026-08 bulk-register incident: a client can register
 * hundreds of notes and then fail to upload their bodies, leaving rows that look
 * like notes and hold nothing. Backfill has nothing to send for those, so the
 * client cannot tell "empty on the server" from "not backfilled yet" and waits
 * forever. Naming them on the `ready` frame lets the client seed them from disk.
 *
 * `cap` bounds the answer so one enormous vault can't make the frame unbounded;
 * `truncated` tells the client the list is partial and another pass is needed.
 */
export async function listEmptyDocs(
  docIds: string[],
  db: Queryable = defaultPool,
  cap = 2000,
): Promise<{ empty: string[]; truncated: boolean }> {
  if (docIds.length === 0) return { empty: [], truncated: false };

  // Postgres takes a large text[] fine, but a single param holding every doc id
  // in a 100k-note vault is a needlessly big bind — chunk it.
  const CHUNK = 20_000;
  const found: string[] = [];
  for (let i = 0; i < docIds.length; i += CHUNK) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT d.id
         FROM unnest($1::text[]) AS d(id)
        WHERE NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = d.id)
        ORDER BY d.id
        LIMIT $2`,
      [docIds.slice(i, i + CHUNK), cap + 1],
    );
    for (const r of rows) found.push(r.id);
    // Already over the cap — the rest of the chunks can only add to a list we
    // are about to truncate anyway.
    if (found.length > cap) break;
  }

  // Sort across chunks: each query orders within its own slice only, and a
  // stable answer keeps the frame deterministic for tests and for the client.
  found.sort();
  if (found.length > cap) return { empty: found.slice(0, cap), truncated: true };
  return { empty: found, truncated: false };
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
 *
 * NOTE: this one deliberately still builds a Y.Doc — `encodeStateAsUpdate` on a
 * gc'd doc is what makes a *compacted* snapshot smaller than the sum of its
 * updates, which is the whole point of compacting. The read paths avoid the doc;
 * this write path wants it.
 *
 * It runs under the pool-wide `statement_timeout` (see `db/pool.ts`) and NOT a
 * tighter per-transaction one: `Queryable` is `Pick<Pool, "query">`, so
 * consecutive calls may land on different pooled connections and a
 * `BEGIN`/`SET LOCAL`/`COMMIT` sequence issued through it would set the timeout
 * on an arbitrary connection. Doing it properly means threading a checked-out
 * client through this signature — worth doing, not worth doing here.
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


/**
 * Discard a doc's entire CRDT history and re-seed it from `content`.
 *
 * The repair for a doc that has grown past `MAX_NOTE_MB`. Such a doc is stuck in
 * a way nothing else here can undo: it is refused by `beforeHandleMessage` on
 * every connect, so no client can ever edit it down, and its bulk is *history*
 * (tombstones, duplicated inserts from a past fork) rather than text — one
 * production doc decoded to 29 580 lines of which 68 were distinct.
 *
 * Discarding history is the point, not a side effect, so this is intentionally
 * NOT `compact`: compaction merges the updates into a snapshot and keeps every
 * tombstone, which is why a 44 MB doc stays 44 MB however often it compacts.
 *
 * The new doc gets a fresh clientID and no shared history with the old one, so
 * every client MUST be evicted (see `evictDoc`) rather than left to merge —
 * merging the old state back in is exactly the fork this undoes.
 */
export async function resetDocCrdt(
  docId: string,
  content: string,
  db: Queryable = defaultPool,
): Promise<{ bytes: number }> {
  const doc = new Y.Doc();
  try {
    if (content.length > 0) doc.getText("content").insert(0, content);
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));
    await db.query("DELETE FROM doc_updates WHERE doc_id = $1", [docId]);
    await db.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at)
       VALUES ($1, $2, $3, '0', now())
       ON CONFLICT (doc_id) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             state_vector = EXCLUDED.state_vector,
             seq = EXCLUDED.seq,
             updated_at = now()`,
      [docId, snapshot, stateVector],
    );
    return { bytes: snapshot.byteLength };
  } finally {
    doc.destroy();
  }
}

/** Total persisted bytes for a doc — snapshot plus its un-compacted update log.
 *  The number the size cap is really about, reportable without loading the doc. */
export async function docStoredBytes(
  docId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `SELECT (
       COALESCE((SELECT SUM(octet_length(snapshot)) FROM doc_snapshots WHERE doc_id = $1), 0)
     + COALESCE((SELECT SUM(octet_length(update))   FROM doc_updates   WHERE doc_id = $1), 0)
     )::text AS bytes`,
    [docId],
  );
  return Number(rows[0]?.bytes ?? 0);
}
