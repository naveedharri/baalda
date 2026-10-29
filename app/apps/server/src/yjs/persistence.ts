import * as Y from "yjs";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import { vaultKeyCache } from "../crypto/key-cache.js";
import { KeyRequiredError, loadVkCheck } from "../crypto/transport.js";
import { verifyVk } from "../crypto/vk-check.js";
import { inc } from "../metrics/sync-metrics.js";
import {
  assertWritableWithoutKey,
  openDocBytes,
  sealDocBytes,
  vaultOfDoc,
  type DocCrypto,
} from "../crypto/doc-crypto.js";

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
 * Run `fn` holding the doc's EXCLUSIVE advisory lock in one transaction, the
 * lock every compaction holds from its first read to its commit. The crypto
 * null-out clears a plaintext log/snapshot row under it, so a compaction that
 * read that plaintext can never re-insert it after the clear (and a compaction
 * that starts later reads the cleared row).
 */
export function withDocWriteLock<T>(
  docId: string,
  db: Queryable,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return withDocLock(docId, db, "exclusive", (q) => fn(q));
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
    // 40001 is the expected outcome of two readers refreshing one doc's cache
    // under REPEATABLE READ (see above): the other reader wrote it. Not news.
    if ((err as { code?: string } | null)?.code === "40001") return;
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
  crypto?: DocCrypto,
): Promise<Uint8Array | null> {
  // Snapshot + log under one consistent read (see `withDocLock`). Split across
  // two transactions this can return a doc missing everything a concurrent
  // `compact()` folded in — which for the detached MCP writer is content
  // CORRUPTION, not a slow read: `setContent` deletes only the text it can see,
  // so the unseen ops' text survives beside the new body once the two merge.
  return withDocLock(docId, db, "shared", async (q) => {
    const snap = await q.query<{ snapshot: Buffer | null; snapshot_enc: Buffer | null }>(
      "SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const raw = await q.query<{ update: Buffer | null; update_enc: Buffer | null }>(
      "SELECT update, update_enc FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );
    const { snapshotBuf, rows } = openParts(docId, crypto, snap.rows[0], raw.rows);
    if (!snapshotBuf && rows.length === 0) return null;

    return mergeParts(snapshotBuf, rows);
  });
}

/**
 * W3: open a doc's rows. A row with `*_enc` is sealed (opened with `crypto`, or
 * {@link KeyRequiredError} without one); any other row is plaintext, exactly as
 * before. An unkeyed doc never has an `*_enc` row, so this is a pass-through.
 */
function openParts<R extends { update: Buffer | null; update_enc: Buffer | null }>(
  docId: string,
  crypto: DocCrypto | undefined,
  snapRow: { snapshot: Buffer | null; snapshot_enc: Buffer | null } | undefined,
  rows: R[],
): { snapshotBuf: Buffer | null; rows: Array<R & { update: Buffer }> } {
  const snapshotBuf = snapRow
    ? openDocBytes(crypto, "doc_snapshots.snapshot", docId, snapRow.snapshot_enc, snapRow.snapshot)
    : null;
  return {
    snapshotBuf,
    rows: rows.map((r) => ({
      ...r,
      update: openDocBytes(crypto, "doc_updates.update", docId, r.update_enc, r.update) ?? Buffer.alloc(0),
    })),
  };
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
async function writeStateVector(
  docId: string,
  stateVector: Uint8Array,
  uptoUpdateId: string | null,
  db: Queryable,
): Promise<void> {
  await db.query(
    `INSERT INTO doc_state_vectors (doc_id, state_vector, upto_update_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (doc_id) DO UPDATE
       SET state_vector = EXCLUDED.state_vector,
           upto_update_id = EXCLUDED.upto_update_id,
           updated_at = now()`,
    [docId, Buffer.from(stateVector), uptoUpdateId],
  );
}

/** {@link writeStateVector} outside a transaction: a failure is logged, never thrown. */
async function rememberStateVector(
  docId: string,
  stateVector: Uint8Array,
  uptoUpdateId: string | null,
  db: Queryable,
): Promise<void> {
  try {
    await writeStateVector(docId, stateVector, uptoUpdateId, db);
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
  crypto?: DocCrypto,
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
    const snap = await q.query<{ snapshot: Buffer | null; snapshot_enc: Buffer | null }>(
      "SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const raw = await q.query<{ id: string; update: Buffer | null; update_enc: Buffer | null }>(
      "SELECT id, update, update_enc FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );
    const { snapshotBuf, rows: updateRows } = openParts(docId, crypto, snap.rows[0], raw.rows);
    const updates = { rows: updateRows };
    if (!snapshotBuf && updates.rows.length === 0) return null;

    const merged = mergeParts(snapshotBuf, updates.rows);
    const serverStateVector = Y.encodeStateVectorFromUpdate(merged);
    // The THROWING write: `bestEffort` is what absorbs a failure, by rolling its
    // savepoint back. A write that swallowed its own error left the transaction
    // aborted under a "successful" call, so the RELEASE that followed failed too
    // — two error lines per read, and the cache never written for a busy doc.
    await bestEffort(q, inTx, "sv_cache", (qq) =>
      writeStateVector(
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
 * Which of `docIds` are live NOTES with NO server-side content at all — no
 * snapshot, no logged update? One query per chunk for the whole set, so the
 * vault channel can answer it once per connect instead of probing per doc.
 *
 * Exists because of the 2026-08 bulk-register incident: a client can register
 * hundreds of notes and then fail to upload their bodies, leaving rows that look
 * like notes and hold nothing. Backfill has nothing to send for those, so the
 * client cannot tell "empty on the server" from "not backfilled yet" and waits
 * forever. Naming them on the `ready` frame lets the client seed them from disk.
 *
 * Only live `notes` rows qualify. The caller passes the whole readable set,
 * which also holds `files` ids (tree binaries: their bytes live in blobs, never
 * in Yjs, so they are ALWAYS "empty" here). Counting them filled the cap on a
 * vault with ~5k files and ~150 genuinely empty notes, and every connect named
 * 2000+ ids the client could do nothing useful with. The `bootstrap` route's
 * upload set already joined `notes`; this now agrees with it.
 *
 * `cap` bounds the answer so one enormous vault can't make the frame unbounded;
 * `truncated` tells the client the list is partial and another pass is needed.
 *
 * Past the cap the answer is the `cap` docs with the lowest `md5(id || rotation)`
 * — deterministic, so repeated connects name the SAME set (a random sample made
 * every connect name a different 2000 and the client re-seeded notes it had
 * just settled), yet `rotation` defaults to the UTC day, so a window full of docs
 * the client can never push (notes whose file lives on another device) gives way
 * to the rest the next day instead of starving them forever, which is what the
 * old `ORDER BY id LIMIT cap` did. The answer itself is sorted by id.
 */
export async function listEmptyDocs(
  docIds: string[],
  db: Queryable = defaultPool,
  cap = 2000,
  rotation: string = new Date().toISOString().slice(0, 10),
): Promise<{ empty: string[]; truncated: boolean }> {
  if (docIds.length === 0) return { empty: [], truncated: false };

  // Postgres takes a large text[] fine, but a single param holding every doc id
  // in a 100k-note vault is a needlessly big bind — chunk it. Each chunk keeps
  // its own lowest `cap + 1` keys, so the merge below is exact; every chunk is
  // read (a later chunk may hold lower keys), which is at most five queries for
  // a 100k-doc vault.
  const CHUNK = 20_000;
  const found: { id: string; k: string }[] = [];
  for (let i = 0; i < docIds.length; i += CHUNK) {
    const { rows } = await db.query<{ id: string; k: string }>(
      `SELECT d.id, md5(d.id || ':' || $3) AS k
         FROM unnest($1::text[]) AS d(id)
         JOIN notes n ON n.id = d.id AND n.deleted_at IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = d.id)
        ORDER BY k, d.id
        LIMIT $2`,
      [docIds.slice(i, i + CHUNK), cap + 1, rotation],
    );
    for (const r of rows) found.push(r);
  }

  // Deduplicate (a caller may pass an id twice across chunks), cut by key, then
  // sort the kept ids so the frame reads the same however the chunks fell.
  const byId = new Map<string, string>();
  for (const r of found) byId.set(r.id, r.k);
  const ranked = [...byId].sort((a, b) =>
    a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const truncated = ranked.length > cap;
  const empty = ranked
    .slice(0, cap)
    .map(([id]) => id)
    .sort();
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
  crypto?: DocCrypto,
): Promise<{ compacted: boolean }> {
  if (crypto) {
    // W3: keyed vault — only the sealed column is written.
    await db.query(
      "INSERT INTO doc_updates (doc_id, update, update_enc) VALUES ($1, NULL, $2)",
      [docId, sealDocBytes(crypto, "doc_updates.update", docId, update)],
    );
  } else {
    await assertWritableWithoutKey(docId, crypto, db);
    await db.query(
      "INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)",
      [docId, Buffer.from(update)],
    );
  }
  // The cached state vector is deliberately NOT updated here. Appending moves the
  // log's max id past the watermark the cache recorded, which makes the cache read
  // as stale on its own — so the next reader recomputes and re-caches.
  //
  // Maintaining it from this side looks cheaper and is not safe: two concurrent
  // appends would each fold their own update into whatever they had read, and the
  // one that wrote last would stamp a watermark covering an update its vector
  // never saw. A vector that is trusted and wrong withholds ops from a client
  // silently, which is the one failure mode this cache must never have.

  // Deciding whether to compact used to `count(*)` the log on EVERY update. The
  // in-process estimate below skips that count when it cannot change the
  // answer, and asks Postgres whenever it might.
  const est = logEstimates.get(docId);
  if (est && est.n + 1 <= threshold && est.sinceCount + 1 < RECOUNT_EVERY) {
    est.n += 1;
    est.sinceCount += 1;
    return { compacted: false };
  }

  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM doc_updates WHERE doc_id = $1",
    [docId],
  );
  const count = Number.parseInt(rows[0]?.count ?? "0", 10);
  if (count > threshold) {
    // Forget the estimate: compaction truncates the log, and whatever survives
    // it (an append racing the merge) is counted fresh on the next write.
    logEstimates.delete(docId);
    await compact(docId, db, crypto);
    return { compacted: true };
  }
  rememberEstimate(docId, count);
  return { compacted: false };
}

/**
 * Per-doc estimate of the `doc_updates` row count, so {@link appendUpdate} need
 * not `count(*)` the log on every write. Seeded from a real count, then bumped
 * once per append made through THIS process.
 *
 * Every insert into `doc_updates` goes through `appendUpdate`, and every other
 * write to the table only DELETES (compaction, CRDT reset, trash purge, vault
 * unsync), so in one process the estimate is either exact or too HIGH — and a
 * high estimate only causes an early recount, never a missed compaction.
 * Compaction fires on exactly the append it always did: once the estimate says
 * the next row could cross the threshold, the real count decides.
 *
 * The one way it runs LOW is another server instance appending to the same doc
 * (HA mode). Recounting every {@link RECOUNT_EVERY} appends bounds that: at worst
 * a log grows a few rows past the threshold before one instance notices, and is
 * then compacted as before. Bounded in size; losing an entry just means a count.
 */
const logEstimates = new Map<string, { n: number; sinceCount: number }>();
const RECOUNT_EVERY = 8;
const MAX_LOG_ESTIMATES = 50_000;

function rememberEstimate(docId: string, n: number): void {
  logEstimates.delete(docId);
  if (logEstimates.size >= MAX_LOG_ESTIMATES) {
    // Oldest entry by insertion order; Map iteration order makes this LRU-ish.
    const oldest = logEstimates.keys().next().value;
    if (oldest !== undefined) logEstimates.delete(oldest);
  }
  logEstimates.set(docId, { n, sinceCount: 0 });
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
  crypto?: DocCrypto,
): Promise<void> {
  // FIRST belt, in-process: a per-doc promise chain, so the two `appendUpdate`
  // calls that a pair of typists past the threshold fire concurrently cannot
  // both be merging this doc at once inside ONE server.
  const prev = compactChains.get(docId) ?? Promise.resolve();
  const run = prev.then(
    () => compactOnce(docId, db, crypto),
    () => compactOnce(docId, db, crypto),
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

async function compactOnce(docId: string, db: Queryable, given?: DocCrypto): Promise<void> {
  // W3: a sealed log needs the key. Background compaction (no caller key) uses
  // a COPY from the process cache and defers — leaves the log as is — when no
  // member is connected to supply one. Unkeyed docs never reach the lookup.
  let crypto = given;
  let cachedCopy: Buffer | null = null;
  if (!crypto) {
    const { rows } = await db.query<{ sealed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM doc_updates WHERE doc_id = $1 AND update_enc IS NOT NULL)
           OR EXISTS (SELECT 1 FROM doc_snapshots WHERE doc_id = $1 AND snapshot_enc IS NOT NULL) AS sealed`,
      [docId],
    );
    if (rows[0]?.sealed) {
      const vaultId = await vaultOfDoc(docId, db);
      const held = vaultId ? vaultKeyCache.get(vaultId) : null;
      if (!vaultId || !held) return;
      // The cache copy must still be the vault's CURRENT key (check and
      // generation), exactly as the backfill's `heldCrypto` demands: after a
      // generation bump a stale cached key would seal a new snapshot nobody
      // holding only the new key can open. Defer instead (log left as is).
      const state = await loadVkCheck(vaultId, db);
      if (!state || state.generation !== held.generation || !verifyVk(held.key, vaultId, state.vkCheck)) {
        held.key.fill(0);
        return;
      }
      cachedCopy = held.key;
      crypto = { vaultId, key: held.key, generation: held.generation };
    }
  }
  try {
    await compactLocked(docId, db, crypto);
  } catch (err) {
    // Fail closed, keep everything: a seal that does not verify leaves the log
    // untouched (the check runs before any write). Compaction retries later.
    if (err instanceof SealVerifyError) {
      console.error(`[compact] ${err.message}`);
      return;
    }
    throw err;
  } finally {
    cachedCopy?.fill(0);
  }
}

/** Thrown when a sealed snapshot does not round-trip; nothing is written. */
export class SealVerifyError extends Error {
  constructor(docId: string) {
    super(`sealed snapshot for ${docId} failed verification; compaction skipped`);
    this.name = "SealVerifyError";
  }
}

/** Exposed for tests: replace to simulate a bad seal. */
export const sealVerifyHooks = { open: openDocBytes };

function verifySealedSnapshot(
  crypto: DocCrypto,
  docId: string,
  sealed: Buffer,
  plain: Buffer,
  expected: Y.Doc,
): void {
  let opened: Buffer | null;
  try {
    opened = sealVerifyHooks.open(crypto, "doc_snapshots.snapshot", docId, sealed, null);
  } catch {
    throw new SealVerifyError(docId);
  }
  if (!opened || !opened.equals(plain)) throw new SealVerifyError(docId);
  const check = new Y.Doc();
  try {
    Y.applyUpdate(check, new Uint8Array(opened));
    const same =
      bytesEqual(Y.encodeStateVector(check), Y.encodeStateVector(expected)) &&
      check.getText("content").toString() === expected.getText("content").toString();
    if (!same) throw new SealVerifyError(docId);
  } finally {
    check.destroy();
  }
}

async function compactLocked(docId: string, db: Queryable, crypto: DocCrypto | undefined): Promise<void> {
  // SECOND belt, cross-process and the real one: the doc's EXCLUSIVE advisory
  // lock, with the reads, the upsert and the delete in that one transaction.
  await withDocLock(docId, db, "exclusive", async (q, inTx) => {
    const snap = await q.query<{ snapshot: Buffer | null; snapshot_enc: Buffer | null }>(
      "SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1",
      [docId],
    );
    const raw = await q.query<{ id: string; update: Buffer | null; update_enc: Buffer | null }>(
      "SELECT id, update, update_enc FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );
    if (raw.rows.length === 0) return;
    // W3 data-loss rule: a keyed compaction never DROPS plaintext. Nulling it
    // is the separate, delayed, per-row compared step (`crypto/null-out.ts`).
    // A doc still converting (plaintext snapshot or plaintext log rows, sealed
    // copies or not) is compacted by `compactConverting` instead, which keeps
    // the plaintext it already had — and only that — in one verified dual row.
    if (crypto) {
      const snapRow = snap.rows[0];
      const plaintextLeft =
        (snapRow && snapRow.snapshot !== null) || raw.rows.some((r) => r.update !== null);
      if (plaintextLeft) {
        await compactConverting(docId, q, inTx, crypto, snapRow, raw.rows);
        return;
      }
    }
    const opened = openParts(docId, crypto, snap.rows[0], raw.rows);
    const updates = { rows: opened.rows };

    const doc = new Y.Doc();
    let maxId = "0";
    try {
      const snapshotBuf = opened.snapshotBuf;
      if (snapshotBuf) Y.applyUpdate(doc, new Uint8Array(snapshotBuf));
      for (const row of updates.rows) {
        Y.applyUpdate(doc, new Uint8Array(row.update));
        maxId = row.id;
      }
      const mergedPlain = Buffer.from(Y.encodeStateAsUpdate(doc));
      const stateVector = Buffer.from(Y.encodeStateVector(doc));
      // W3: a keyed doc's snapshot goes only into `snapshot_enc`.
      const merged = crypto ? null : mergedPlain;
      const mergedEnc = crypto ? sealDocBytes(crypto, "doc_snapshots.snapshot", docId, mergedPlain) : null;
      // Verify before replace: the sealed snapshot must decrypt to exactly the
      // merged bytes AND decode to the same doc (state vector + text) before
      // any row is replaced or deleted. Any mismatch throws, so the
      // transaction rolls back and the log stays as it was.
      if (mergedEnc && crypto) verifySealedSnapshot(crypto, docId, mergedEnc, mergedPlain, doc);

      // THIRD belt: never move the snapshot BACKWARDS. `seq` is the
      // `doc_updates.id` high-water mark the snapshot absorbed, so a merge that
      // covers less than what is already stored is by definition older — and
      // upserting it unconditionally is exactly how the racing pair destroyed a
      // committed update: A read the log at 1-3, B wrote 1-4 and truncated, A
      // then stamped its 1-3 merge over B's and update 4 existed nowhere.
      const wrote = await q.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at, snapshot_enc)
         VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (doc_id) DO UPDATE
           SET snapshot = EXCLUDED.snapshot,
               snapshot_enc = EXCLUDED.snapshot_enc,
               state_vector = EXCLUDED.state_vector,
               seq = EXCLUDED.seq,
               updated_at = now()
         WHERE doc_snapshots.seq IS NULL OR doc_snapshots.seq < EXCLUDED.seq
         RETURNING doc_id`,
        [docId, merged, stateVector, maxId, mergedEnc],
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

/** Exposed for tests: runs inside the transaction right before the first write. */
export const convertingCompactHooks: { beforeWrite: () => Promise<void> | void } = {
  beforeWrite: () => {},
};

/** Same SV and same visible text. */
function sameDoc(a: Y.Doc, b: Y.Doc): boolean {
  return (
    bytesEqual(Y.encodeStateVector(a), Y.encodeStateVector(b)) &&
    a.getText("content").toString() === b.getText("content").toString()
  );
}

/**
 * W3 compaction of a doc whose vault is keyed but which still holds PLAINTEXT
 * (written before the vault was keyed, sealed copy or not). Without this the
 * keyed compaction refused such a doc, so an actively edited note's log grew
 * without bound until the null-out ran.
 *
 * Result, in the ONE exclusive transaction the caller holds:
 *   · the snapshot = the merged state of EVERY row, sealed only
 *     (`snapshot = NULL`), verified as in today's keyed compaction;
 *   · ONE dual "legacy" log row = `Y.mergeUpdates` of exactly the plaintext
 *     parts that already existed (plaintext snapshot + plaintext log rows) in
 *     `update`, plus its sealed copy in `update_enc`. Post-keying edits are
 *     never written to a plaintext column: no new plaintext, and the plaintext
 *     kept is bounded by what was there before (no growth);
 *   · every row folded in is deleted, except a lone legacy row that is already
 *     that dual row (kept in place, so a repeat compaction does not churn).
 *
 * Fails closed BEFORE any write: a dual row whose sealed copy does not open to
 * exactly its plaintext, a legacy merge that does not decode to the plaintext
 * parts' state, a seal that does not round-trip, or a snapshot that does not
 * cover the legacy ops, all throw {@link SealVerifyError} and roll back.
 *
 * The legacy row is byte-equal dual, so the null-out clears its `update` after
 * the retention delay; the next compaction then folds it like any sealed row.
 */
async function compactConverting(
  docId: string,
  q: Queryable,
  inTx: boolean,
  crypto: DocCrypto,
  snapRow: { snapshot: Buffer | null; snapshot_enc: Buffer | null } | undefined,
  rows: Array<{ id: string; update: Buffer | null; update_enc: Buffer | null }>,
): Promise<void> {
  const checkDual = (column: "doc_updates.update" | "doc_snapshots.snapshot", plain: Buffer, enc: Buffer) => {
    let opened: Buffer | null;
    try {
      opened = sealVerifyHooks.open(crypto, column, docId, enc, null);
    } catch {
      throw new SealVerifyError(docId);
    }
    if (!opened || !opened.equals(plain)) throw new SealVerifyError(docId);
  };
  // The plaintext that already exists, taken from the PLAINTEXT columns only.
  const plainParts: Buffer[] = [];
  if (snapRow?.snapshot) {
    if (snapRow.snapshot_enc) checkDual("doc_snapshots.snapshot", snapRow.snapshot, snapRow.snapshot_enc);
    plainParts.push(snapRow.snapshot);
  }
  const plainRows = rows.filter((r) => r.update !== null);
  for (const r of plainRows) {
    if (r.update_enc) checkDual("doc_updates.update", r.update!, r.update_enc);
    plainParts.push(r.update!);
  }
  let opened: ReturnType<typeof openParts<(typeof rows)[number]>>;
  try {
    opened = openParts(docId, crypto, snapRow, rows);
  } catch {
    throw new SealVerifyError(docId);
  }

  const full = new Y.Doc();
  const legacyDoc = new Y.Doc();
  const legacyCheck = new Y.Doc();
  try {
    if (opened.snapshotBuf) Y.applyUpdate(full, new Uint8Array(opened.snapshotBuf));
    let maxId = "0";
    for (const row of opened.rows) {
      Y.applyUpdate(full, new Uint8Array(row.update));
      maxId = row.id;
    }
    const mergedPlain = Buffer.from(Y.encodeStateAsUpdate(full));
    const stateVector = Buffer.from(Y.encodeStateVector(full));
    const mergedEnc = sealDocBytes(crypto, "doc_snapshots.snapshot", docId, mergedPlain);
    verifySealedSnapshot(crypto, docId, mergedEnc, mergedPlain, full);

    // A lone plaintext log row that is already dual IS the legacy row.
    const keep =
      !snapRow?.snapshot && plainRows.length === 1 && plainRows[0]!.update_enc ? plainRows[0]! : null;
    const legacyPlain = keep
      ? keep.update!
      : Buffer.from(plainParts.length === 1 ? plainParts[0]! : Y.mergeUpdates(plainParts.map((p) => new Uint8Array(p))));
    // The legacy merge must stand for exactly the plaintext parts.
    for (const p of plainParts) Y.applyUpdate(legacyDoc, new Uint8Array(p));
    Y.applyUpdate(legacyCheck, new Uint8Array(legacyPlain));
    if (!sameDoc(legacyDoc, legacyCheck)) throw new SealVerifyError(docId);
    // The sealed snapshot must already cover every legacy op.
    const covered = new Y.Doc();
    try {
      Y.applyUpdate(covered, new Uint8Array(mergedPlain));
      Y.applyUpdate(covered, new Uint8Array(legacyPlain));
      if (!sameDoc(covered, full)) throw new SealVerifyError(docId);
    } finally {
      covered.destroy();
    }
    let legacyEnc: Buffer | null = null;
    if (!keep) {
      legacyEnc = sealDocBytes(crypto, "doc_updates.update", docId, legacyPlain);
      checkDual("doc_updates.update", legacyPlain, legacyEnc);
    }

    await convertingCompactHooks.beforeWrite();
    // Same backwards-move belt as `compactLocked`.
    const wrote = await q.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at, snapshot_enc)
       VALUES ($1, NULL, $2, $3, now(), $4)
       ON CONFLICT (doc_id) DO UPDATE
         SET snapshot = NULL,
             snapshot_enc = EXCLUDED.snapshot_enc,
             state_vector = EXCLUDED.state_vector,
             seq = EXCLUDED.seq,
             updated_at = now()
       WHERE doc_snapshots.seq IS NULL OR doc_snapshots.seq < EXCLUDED.seq
       RETURNING doc_id`,
      [docId, stateVector, maxId, mergedEnc],
    );
    // Refused by the belt: a newer snapshot already covers more; nothing was
    // written and nothing is deleted.
    if (wrote.rowCount === 0) return;
    if (legacyEnc) {
      await q.query("INSERT INTO doc_updates (doc_id, update, update_enc) VALUES ($1, $2, $3)", [
        docId,
        legacyPlain,
        legacyEnc,
      ]);
    }
    await q.query("DELETE FROM doc_updates WHERE doc_id = $1 AND id <= $2 AND id <> $3", [
      docId,
      maxId,
      keep?.id ?? "0",
    ]);
    inc("compact.converting");
    await bestEffort(q, inTx, "sv_invalidate", (qq) => invalidateStateVector(docId, qq));
  } finally {
    full.destroy();
    legacyDoc.destroy();
    legacyCheck.destroy();
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
    // W3: no sealed reset yet; refuse rather than write plaintext into a keyed
    // vault. Also refuse whenever sealed rows exist, flag on or off: deleting
    // rows nobody here can read is never a reset this server may do.
    await assertWritableWithoutKey(docId, undefined, db);
    const sealed = await db.query<{ sealed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM doc_updates WHERE doc_id = $1 AND update_enc IS NOT NULL)
           OR EXISTS (SELECT 1 FROM doc_snapshots WHERE doc_id = $1 AND snapshot_enc IS NOT NULL) AS sealed`,
      [docId],
    );
    if (sealed.rows[0]?.sealed) throw new KeyRequiredError();
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
       COALESCE((SELECT SUM(octet_length(COALESCE(snapshot_enc, snapshot))) FROM doc_snapshots WHERE doc_id = $1), 0)
     + COALESCE((SELECT SUM(octet_length(COALESCE(update_enc, update))) FROM doc_updates WHERE doc_id = $1), 0)
     )::text AS bytes`,
    [docId],
  );
  return Number(rows[0]?.bytes ?? 0);
}
