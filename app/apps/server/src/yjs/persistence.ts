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
 * Per-doc serialisation for the snapshot/log pair.
 *
 * Two statements against `doc_snapshots` and `doc_updates` are NOT one answer:
 * a `compact()` that commits between them folds the log into the snapshot and
 * deletes it, so a reader can see the PRE-compact snapshot and the POST-compact
 * (empty) log — a state missing every op the compact absorbed. Read that way it
 * serves a truncated doc; cached that way (`rememberStateVector` with a NULL
 * watermark, which `currentStateVector` reads as fresh precisely because the log
 * IS empty) it keeps serving it on every later connect.
 *
 * So both sides take a Postgres advisory lock keyed by doc, inside one
 * transaction:
 *   · `compact()` — EXCLUSIVE. Its read-merge-upsert-delete cycle is the only
 *     thing that rewrites what the log contains, and two of them racing each
 *     other silently drop committed updates (an older merge upserted over a
 *     newer one).
 *   · the readers — SHARED. They do not conflict with each other (backfill runs
 *     many at once), only with a compact.
 * Transaction-scoped, so COMMIT/ROLLBACK releases it even if the process dies.
 */
type ClientSource = { connect: () => Promise<pg.PoolClient> };

/**
 * The pool behind a `Queryable`, or null when it is a bare `{ query }` — the
 * shape the tests inject to count SQL. Without a dedicated client there is no
 * transaction to scope a lock to, so those callers run the same statements
 * un-serialised; correctness in production rides on the real pool.
 */
function clientSource(db: Queryable): ClientSource | null {
  const maybe = db as Partial<ClientSource>;
  return typeof maybe.connect === "function" ? (maybe as ClientSource) : null;
}

async function withDocLock<T>(
  docId: string,
  db: Queryable,
  mode: "shared" | "exclusive",
  fn: (q: Queryable, inTransaction: boolean) => Promise<T>,
): Promise<T> {
  const source = clientSource(db);
  if (!source) return fn(db, false);
  const client = await source.connect();
  try {
    // REPEATABLE READ for the READERS, which is the whole point: their two
    // statements must describe one instant. The WRITER stays READ COMMITTED —
    // it holds the lock EXCLUSIVELY, so nothing can move under it anyway, and
    // under RR its own writes would raise 40001 against a row some reader's
    // cache write touched after its snapshot was taken (a lock statement takes
    // the snapshot BEFORE it blocks, so a waiter's snapshot always predates the
    // holder's commit).
    await client.query(
      mode === "exclusive" ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ",
    );
    await client.query(
      mode === "exclusive"
        ? "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
        : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      [`doc:${docId}`],
    );
    const out = await fn(client, true);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a best-effort write inside a transaction WITHOUT risking the transaction.
 *
 * A failed statement poisons a Postgres transaction: everything after it, COMMIT
 * included, fails with "current transaction is aborted". So a write whose own
 * contract is "a failure here is a slow read, never a failed one" — the state
 * vector cache — has to be able to fail without taking the read it rode in on
 * with it. Under REPEATABLE READ that is not hypothetical: two readers
 * refreshing the same doc's cache is a plain 40001.
 */
async function bestEffort(
  q: Queryable,
  inTransaction: boolean,
  name: string,
  fn: (q: Queryable) => Promise<void>,
): Promise<void> {
  if (!inTransaction) return fn(q);
  await q.query(`SAVEPOINT ${name}`);
  try {
    await fn(q);
    await q.query(`RELEASE SAVEPOINT ${name}`);
  } catch (err) {
    await q.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await q.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    console.warn(`[yjs] ${name} failed (ignored):`, err);
  }
}

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
  // Snapshot + log under one consistent read (see `withDocLock`). Split across
  // two transactions this can return a doc missing everything a concurrent
  // `compact()` folded in — which for the detached MCP writer is content
  // CORRUPTION, not a slow read: `setContent` deletes only the text it can see,
  // so the unseen ops' text survives beside the new body once the two merge.
  return withDocLock(docId, db, "shared", async (q) => {
    const snap = await q.query<{ snapshot: Buffer | null }>(
      "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const updates = await q.query<{ update: Buffer }>(
      "SELECT update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );

    const snapshotBuf = snap.rows[0]?.snapshot ?? null;
    if (!snapshotBuf && updates.rows.length === 0) return null;

    return mergeParts(snapshotBuf, updates.rows);
  });
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
  /** The client already holds every op the server has; `update` is empty. */
  upToDate: boolean;
  /**
   * The CLIENT holds ops the server has never seen — its state vector runs past
   * ours for at least one client id. Nothing here can fetch those (this is a
   * downstream feed), so the vault channel names such docs on `ready.behind`
   * and the client pushes them over its per-doc socket.
   *
   * This is also why `upToDate` is "covered", not "equal": a client that is
   * strictly ahead has NOTHING to receive, and treating the unequal vectors as
   * "behind" shipped it a 2-byte empty diff on every connect — 40 docs holding
   * unpushed edits made one vault re-download "40 notes" on every reload,
   * forever, while the edits themselves never went anywhere.
   */
  clientAhead: boolean;
}

/**
 * How a client's state vector relates to the server's. `serverCovered` means
 * the client has at least the server's clock for every client id the server
 * knows (the backfill diff would be empty); `clientAhead` means the client has a
 * clock the server lacks (it holds ops we have never received). Both can be true.
 * A vector that fails to decode is treated as unknown: not covered, not ahead —
 * the caller then ships the full diff, which is the safe direction.
 */
export function compareStateVectors(
  client: Uint8Array,
  server: Uint8Array,
): { serverCovered: boolean; clientAhead: boolean } {
  let c: Map<number, number>;
  let s: Map<number, number>;
  try {
    c = Y.decodeStateVector(client);
    s = Y.decodeStateVector(server);
  } catch {
    return { serverCovered: false, clientAhead: false };
  }
  let serverCovered = true;
  for (const [id, clock] of s) {
    if ((c.get(id) ?? 0) < clock) {
      serverCovered = false;
      break;
    }
  }
  let clientAhead = false;
  for (const [id, clock] of c) {
    if ((s.get(id) ?? 0) < clock) {
      clientAhead = true;
      break;
    }
  }
  return { serverCovered, clientAhead };
}

/** Drop the cached vector for a doc whose history was rewritten underneath it. */
async function invalidateStateVector(docId: string, db: Queryable): Promise<void> {
  try {
    await db.query("DELETE FROM doc_state_vectors WHERE doc_id = $1", [docId]);
  } catch (err) {
    console.warn(`[yjs] state-vector cache invalidate failed for ${docId}:`, err);
  }
}

/**
 * The cached state vector for `docId`, but ONLY when it provably describes the
 * doc's current log. `upto_update_id` must equal the log's max id (both NULL when
 * the log is empty); anything else means an append landed after the vector was
 * written, and a vector that is merely close is worse than none — it would report
 * a client "up to date" while ops it has never seen sit in the log.
 *
 * One indexed query, no BYTEA of the log, no merge.
 */
async function currentStateVector(
  docId: string,
  db: Queryable,
): Promise<Uint8Array | null> {
  const { rows } = await db.query<{ state_vector: Buffer; fresh: boolean }>(
    `SELECT v.state_vector,
            v.upto_update_id IS NOT DISTINCT FROM
              (SELECT max(u.id) FROM doc_updates u WHERE u.doc_id = $1) AS fresh
       FROM doc_state_vectors v
      WHERE v.doc_id = $1`,
    [docId],
  );
  const row = rows[0];
  if (!row || !row.fresh) return null;
  return new Uint8Array(row.state_vector);
}

/**
 * Record the state vector for `docId` along with the log position it accounts
 * for. Safe to call from a read path: the pair is written together, so a stale
 * write is detected by the freshness check rather than trusted.
 */
async function rememberStateVector(
  docId: string,
  stateVector: Uint8Array,
  uptoUpdateId: string | null,
  db: Queryable,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO doc_state_vectors (doc_id, state_vector, upto_update_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (doc_id) DO UPDATE
         SET state_vector = EXCLUDED.state_vector,
             upto_update_id = EXCLUDED.upto_update_id,
             updated_at = now()`,
      [docId, Buffer.from(stateVector), uptoUpdateId],
    );
  } catch (err) {
    // A cache miss is a slow read, never a failed one — this must not be able to
    // fail a sync.
    console.warn(`[yjs] state-vector cache write failed for ${docId}:`, err);
  }
}

export async function loadDocDiff(
  docId: string,
  clientStateVector: Uint8Array | null,
  db: Queryable = defaultPool,
): Promise<DocDiff | null> {
  // FAST PATH, and the one that matters at scale: a cached per-doc state vector
  // that is provably current. This is the question the vault channel asks for
  // every readable doc on every connect, and the honest answer is almost always
  // "you already have everything" — which this settles in ONE indexed query with
  // no log read and no merge. Only a client that is genuinely behind pays for the
  // work below. See `doc_state_vectors` (migration 025).
  if (clientStateVector) {
    const cached = await currentStateVector(docId, db);
    if (cached) {
      const cmp = bytesEqual(clientStateVector, cached)
        ? { serverCovered: true, clientAhead: false }
        : compareStateVectors(clientStateVector, cached);
      if (cmp.serverCovered) {
        return {
          update: new Uint8Array(0),
          serverStateVector: cached,
          upToDate: true,
          clientAhead: cmp.clientAhead,
        };
      }
    }
  }
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
      return { update: new Uint8Array(0), serverStateVector, upToDate: true, clientAhead: false };
    }
    // Unequal is not "behind": a client that is a superset of us has nothing to
    // receive either, and the probe can say so without touching the snapshot.
    const cmp = compareStateVectors(clientStateVector, serverStateVector);
    if (cmp.serverCovered) {
      return {
        update: new Uint8Array(0),
        serverStateVector,
        upToDate: true,
        clientAhead: cmp.clientAhead,
      };
    }
  }
  // Fall through: uncompacted doc, a pre-`state_vector` snapshot row (the column
  // is nullable and older rows have it NULL), a client with no vector, or a
  // client that is genuinely behind.

  // SLOW PATH, under the doc's shared lock and ONE repeatable-read snapshot
  // (see `withDocLock`): the snapshot BYTEA, the whole log, and the cache write
  // that records what they add up to, all describing the same instant. Read
  // across two transactions instead, a `compact()` committing in between hands
  // this the pre-compact snapshot with the post-compact (empty) log — a short
  // doc that `rememberStateVector` then stamps with a NULL watermark, which
  // reads as FRESH forever after because the log genuinely is empty. That
  // combination does not just delay ops, it withholds them silently.
  const read = await withDocLock(docId, db, "shared", async (q, inTx) => {
    const snap = await q.query<{ snapshot: Buffer | null }>(
      "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const updates = await q.query<{ id: string; update: Buffer }>(
      "SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );
    const snapshotBuf = snap.rows[0]?.snapshot ?? null;
    if (!snapshotBuf && updates.rows.length === 0) return null;

    const merged = mergeParts(snapshotBuf, updates.rows);
    const serverStateVector = Y.encodeStateVectorFromUpdate(merged);
    await bestEffort(q, inTx, "sv_cache", (qq) =>
      rememberStateVector(
        docId,
        serverStateVector,
        updates.rows.length > 0 ? (updates.rows[updates.rows.length - 1]?.id ?? null) : null,
        qq,
      ),
    );
    return { merged, serverStateVector };
  });
  if (!read) return null;
  const { merged, serverStateVector } = read;
  const cmp = clientStateVector
    ? bytesEqual(clientStateVector, serverStateVector)
      ? { serverCovered: true, clientAhead: false }
      : compareStateVectors(clientStateVector, serverStateVector)
    : { serverCovered: false, clientAhead: false };
  const upToDate = cmp.serverCovered;
  const update = upToDate
    ? new Uint8Array(0)
    : clientStateVector
      ? Y.diffUpdate(merged, clientStateVector)
      : merged;
  return { update, serverStateVector, upToDate, clientAhead: cmp.clientAhead };
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
 *
 * Past the cap the answer is a RANDOM `cap`-sized sample, not the lowest ids.
 * It used to be `ORDER BY id LIMIT cap`, which named the same 2,000 docs on
 * every connect: when that window filled with docs the client can never push
 * (settled-empty files, permanent failures, notes whose file lives on another
 * device), every doc above it was starved of its heal for good. Sampling costs
 * the same one query per chunk, and a doc named twice is a no-op client-side.
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
  // Shuffled so that, when there are more empties than `cap`, which ones make
  // the cut changes from one connect to the next (see above).
  const order = [...docIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const found: string[] = [];
  for (let i = 0; i < order.length; i += CHUNK) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT d.id
         FROM unnest($1::text[]) WITH ORDINALITY AS d(id, n)
        WHERE NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = d.id)
        ORDER BY d.n
        LIMIT $2`,
      [order.slice(i, i + CHUNK), cap + 1],
    );
    for (const r of rows) found.push(r.id);
    // Already over the cap — the rest of the chunks can only add to a list we
    // are about to truncate anyway.
    if (found.length > cap) break;
  }

  // The answer is sorted so the frame reads the same whatever order the chunks
  // came back in — but trimmed BEFORE sorting: `found` is in shuffled order, so
  // the cut is random, and sorting first would always drop the largest ids.
  const truncated = found.length > cap;
  const empty = (truncated ? found.slice(0, cap) : found).sort();
  return { empty, truncated };
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
  // The cached state vector is deliberately NOT updated here. Appending moves the
  // log's max id past the watermark the cache recorded, which makes the cache read
  // as stale on its own — so the next reader recomputes and re-caches.
  //
  // Maintaining it from this side looks cheaper and is not safe: two concurrent
  // appends would each fold their own update into whatever they had read, and the
  // one that wrote last would stamp a watermark covering an update its vector
  // never saw. A vector that is trusted and wrong withholds ops from a client
  // silently, which is the one failure mode this cache must never have.

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
 * THREE belts keep two compactions of one doc from destroying each other's
 * work (see `compactOnce`): an in-process per-doc promise chain, the doc's
 * EXCLUSIVE advisory lock around a single transaction, and a `seq` guard on the
 * upsert that refuses to move a snapshot backwards.
 */
export async function compact(
  docId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  // FIRST belt, in-process: a per-doc promise chain, so the two `appendUpdate`
  // calls that a pair of typists past the threshold fire concurrently cannot
  // both be merging this doc at once inside ONE server.
  const prev = compactChains.get(docId) ?? Promise.resolve();
  const run = prev.then(
    () => compactOnce(docId, db),
    () => compactOnce(docId, db),
  );
  const tail = run.catch(() => {});
  compactChains.set(docId, tail);
  try {
    await run;
  } finally {
    // Only the tail clears the entry, or a slow compact would delete a chain a
    // later caller has already appended to.
    if (compactChains.get(docId) === tail) compactChains.delete(docId);
  }
}

/** In-flight compaction per doc; see `compact`. Entries are removed as they drain. */
const compactChains = new Map<string, Promise<void>>();

async function compactOnce(docId: string, db: Queryable): Promise<void> {
  // SECOND belt, cross-process and the real one: the doc's EXCLUSIVE advisory
  // lock, with the reads, the upsert and the delete in that one transaction.
  await withDocLock(docId, db, "exclusive", async (q, inTx) => {
    const snap = await q.query<{ snapshot: Buffer | null }>(
      "SELECT snapshot FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const updates = await q.query<{ id: string; update: Buffer }>(
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

      // THIRD belt: never move the snapshot BACKWARDS. `seq` is the
      // `doc_updates.id` high-water mark the snapshot absorbed, so a merge that
      // covers less than what is already stored is by definition older — and
      // upserting it unconditionally is exactly how the racing pair destroyed a
      // committed update: A read the log at 1-3, B wrote 1-4 and truncated, A
      // then stamped its 1-3 merge over B's and update 4 existed nowhere.
      const wrote = await q.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (doc_id) DO UPDATE
           SET snapshot = EXCLUDED.snapshot,
               state_vector = EXCLUDED.state_vector,
               seq = EXCLUDED.seq,
               updated_at = now()
         WHERE doc_snapshots.seq IS NULL OR doc_snapshots.seq < EXCLUDED.seq
         RETURNING doc_id`,
        [docId, merged, stateVector, maxId],
      );
      // Refused by the belt: a newer snapshot already covers at least this much,
      // so there is nothing to truncate against and nothing to invalidate.
      if (wrote.rowCount === 0) return;

      await q.query(
        "DELETE FROM doc_updates WHERE doc_id = $1 AND id <= $2",
        [docId, maxId],
      );
      // Compacting rewrites what the log contains, so any cached vector's watermark
      // now describes rows that are gone. Drop it and let the next read recompute —
      // same reasoning as `appendUpdate`: an update appended while we were merging
      // would otherwise be covered by a watermark whose vector predates it.
      await bestEffort(q, inTx, "sv_invalidate", (qq) => invalidateStateVector(docId, qq));
    } finally {
      doc.destroy();
    }
  });
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
    // REPLACE, never merge: this doc's history was deliberately discarded, so the
    // new vector is not a superset of the old one and folding them together would
    // claim clocks that no longer exist. The log is empty, hence a NULL watermark.
    await rememberStateVector(docId, new Uint8Array(stateVector), null, db);
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
