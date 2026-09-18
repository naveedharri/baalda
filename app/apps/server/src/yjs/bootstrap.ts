import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import * as Y from "yjs";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import { listReadableDocsInVault } from "../permissions/vault-docs.js";
import type { BootstrapSession } from "../http/routes/bulk-types.js";
import { encodeBootstrapPage, encodedDocBytes, type BootstrapDoc } from "../sync/bulk-protocol.js";

/**
 * Bootstrap: the whole-vault download a joiner (or a re-installed device) needs,
 * served as resumable binary pages instead of N per-doc WebSocket backfills.
 *
 * The session is the load-bearing idea. Creating one MATERIALISES the caller's
 * ACL-resolved, byte-sized doc list into `bootstrap_session_docs` once, ordered
 * by `rel_path COLLATE "C"`, so that:
 *
 *  · every page after it is an index-only keyset read rather than a re-run of
 *    `listReadableDocsInVault`'s recursive CTEs (300–500 runs for one joiner);
 *  · "exactly once across pages" is provable — the set cannot move underneath a
 *    cursor, because it is a row per doc, not a query;
 *  · `bytes` is an honest progress denominator the client can show, computed
 *    before a single BYTEA is read;
 *  · a folder's notes arrive together, so the tree fills in top-down rather than
 *    in doc_id order.
 *
 * Only NOTES are in it. A `files` row is a tree binary with no CRDT at all — its
 * bytes travel through the blob store — so including it would put a permanent
 * zero-byte doc in every session and, worse, name every PDF in the vault as an
 * "empty doc the client should seed from disk".
 */

const gzipAsync = promisify(gzip);

type Queryable = Pick<pg.Pool, "query">;

/** Cap on the `emptyDocs` list a session reports. Bigger than the vault
 *  channel's 2,000 `ready.empty` cap deliberately: naming 5,000 in one answer is
 *  what lets a 5,000-note enable heal in ONE pass instead of three connect
 *  rounds, which was the whole reason that cap kept coming back. */
export const EMPTY_DOCS_CAP = 5000;

/** The GET was refused because the session is gone or expired → 410. */
export class SessionExpiredError extends Error {}
/** Too many page builds in flight → 503 + Retry-After. */
export class BootstrapBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("bootstrap_busy");
  }
}

// ── the concurrency gate ───────────────────────────────────────────────────

/**
 * A page is built entirely in memory — keyset read, per-doc `Y.mergeUpdates`,
 * page encode, gzip — before a byte is written. So the peak is roughly
 * `inFlight × (page + merge transient + gzip buffer)`, and at a 512 MB heap cap
 * (the Dockerfile's NODE_OPTIONS) that has to be bounded by something other than
 * how many people happen to join at once.
 *
 * Refusal rather than queueing: a client that waits in a server-side queue holds
 * a socket and a pool slot for it, and its own retry timer is a better place to
 * wait than our heap. 503 + `Retry-After` is backpressure the client can obey.
 */
let inFlight = 0;

export function bootstrapInFlight(): number {
  return inFlight;
}

async function withBootstrapSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= config.bootstrapConcurrency) throw new BootstrapBusyError(2);
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

// ── session creation ───────────────────────────────────────────────────────

export interface CreateSessionInput {
  vaultId: string;
  userId: string;
  /** docIds the client already holds CRDT state for; subtracted from the
   *  download set. A resume after a crash sends what actually landed. */
  have?: string[];
  db?: Queryable;
}

export async function createBootstrapSession(input: CreateSessionInput): Promise<BootstrapSession> {
  const db = input.db ?? defaultPool;
  const { vaultId, userId } = input;

  // Expired sessions are swept here as well as on the GC tick: creation is the
  // one moment we KNOW a client is bootstrapping, so a server that never runs
  // the tick (a test, a short-lived instance) still doesn't accumulate rows.
  await sweepExpiredBootstrapSessions(db).catch((err) =>
    console.warn("[bootstrap] sweep failed", err),
  );

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  const have = new Set(input.have ?? []);
  const candidates = [...readable].filter((id) => !have.has(id));

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + config.bootstrapTtlHours * 3600_000);
  await db.query(
    `INSERT INTO bootstrap_sessions (id, vault_id, user_id, doc_count, byte_estimate, expires_at)
     VALUES ($1, $2, $3, 0, 0, $4)`,
    [sessionId, vaultId, userId, expiresAt],
  );

  // ONE statement does both halves of the split:
  //   · the data-modifying CTE inserts the DOWNLOAD set (stored bytes > 0),
  //     numbered densely in path order;
  //   · the outer SELECT returns the UPLOAD set (readable notes the server holds
  //     nothing for), which the client seeds from its own disk.
  // Splitting them would compute `sized` twice, and — since the two are
  // complements — could disagree if a push landed between the statements.
  const { rows: emptyRows } = await db.query<{ doc_id: string }>(
    `WITH ids AS (SELECT unnest($2::text[]) AS doc_id),
          sized AS (
            SELECT n.id AS doc_id,
                   n.rel_path,
                   COALESCE(octet_length(s.snapshot), 0)
                     + COALESCE((SELECT sum(octet_length(u.update))
                                   FROM doc_updates u WHERE u.doc_id = n.id), 0) AS bytes
              FROM ids i
              JOIN notes n ON n.id = i.doc_id AND n.vault_id = $3 AND n.deleted_at IS NULL
              LEFT JOIN doc_snapshots s ON s.doc_id = n.id
          ),
          ins AS (
            INSERT INTO bootstrap_session_docs (session_id, seq, doc_id, bytes)
            SELECT $1,
                   row_number() OVER (ORDER BY rel_path COLLATE "C", doc_id),
                   doc_id,
                   bytes
              FROM sized
             WHERE bytes > 0
            RETURNING 1
          )
     SELECT doc_id FROM sized
      WHERE bytes = 0
      ORDER BY rel_path COLLATE "C", doc_id
      LIMIT $4`,
    [sessionId, candidates, vaultId, EMPTY_DOCS_CAP + 1],
  );

  const { rows: totals } = await db.query<{ docs: string; bytes: string }>(
    `SELECT count(*)::text AS docs, COALESCE(sum(bytes), 0)::text AS bytes
       FROM bootstrap_session_docs WHERE session_id = $1`,
    [sessionId],
  );
  const docs = Number.parseInt(totals[0]?.docs ?? "0", 10);
  const bytes = Number.parseInt(totals[0]?.bytes ?? "0", 10);
  await db.query(
    "UPDATE bootstrap_sessions SET doc_count = $2, byte_estimate = $3 WHERE id = $1",
    [sessionId, docs, bytes],
  );

  const emptyTruncated = emptyRows.length > EMPTY_DOCS_CAP;
  return {
    sessionId,
    docs,
    bytes,
    emptyDocs: emptyRows.slice(0, EMPTY_DOCS_CAP).map((r) => r.doc_id),
    emptyTruncated,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Drop sessions past their TTL. Cheap (one index scan) and idempotent, so it
 *  can run from the GC tick AND from session creation without coordination. */
export async function sweepExpiredBootstrapSessions(db: Queryable = defaultPool): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM bootstrap_sessions WHERE expires_at < now()");
  return rowCount ?? 0;
}

// ── page loading ───────────────────────────────────────────────────────────

export interface BootstrapPageResult {
  /** gzip(level 4) of the `bulk-protocol` page. */
  body: Buffer;
  /** Next `seq` to ask for, or null when the session is drained. */
  nextCursor: number | null;
  docs: number;
  /** UNCOMPRESSED page size, so a client's progress bar matches `session.bytes`. */
  bytes: number;
}

export interface LoadPageInput {
  sessionId: string;
  vaultId: string;
  userId: string;
  /** Exclusive: the last seq the client stored. 0 (or absent) starts at the top. */
  cursor: number;
  maxBytes?: number;
  db?: pg.Pool;
  /** Test seam: counts statements to prove a page is O(1) queries, not O(docs). */
  onQuery?: (sql: string) => void;
}

export async function loadBootstrapPage(input: LoadPageInput): Promise<BootstrapPageResult> {
  return withBootstrapSlot(() => loadPageLocked(input));
}

async function loadPageLocked(input: LoadPageInput): Promise<BootstrapPageResult> {
  const pool = input.db ?? defaultPool;
  const budget = Math.max(1, Math.min(input.maxBytes ?? config.bootstrapMaxPageBytes, config.bootstrapMaxPageBytes));
  const client = await pool.connect();
  const q = async <R extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<R[]> => {
    input.onQuery?.(sql);
    const { rows } = await client.query<R>(sql, params);
    return rows;
  };
  try {
    // ONE snapshot for the whole page. `loadDocState` takes a per-doc advisory
    // lock for this reason; a page reads up to `bootstrapMaxPageDocs` docs and
    // taking 256 locks would be worse than useless — but the hazard is the same
    // one, and REPEATABLE READ closes it: a `compact()` that commits between the
    // snapshot read and the update read folds the log into the snapshot and
    // deletes it, and a reader split across two snapshots would ship a doc
    // missing every op that compaction absorbed.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

    const session = await q<{ expired: boolean }>(
      `SELECT (expires_at < now()) AS expired FROM bootstrap_sessions
        WHERE id = $1 AND vault_id = $2 AND user_id = $3`,
      [input.sessionId, input.vaultId, input.userId],
    );
    // Missing and expired are ONE answer on purpose: both mean "re-POST with a
    // fresh `have`", and distinguishing them would let a caller probe for the
    // existence of someone else's session id.
    if (!session[0] || session[0].expired) throw new SessionExpiredError("session_expired");

    const planned = await q<{ seq: number; doc_id: string; bytes: number }>(
      `SELECT seq, doc_id, bytes FROM bootstrap_session_docs
        WHERE session_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [input.sessionId, input.cursor, config.bootstrapMaxPageDocs],
    );

    // Pack to the byte budget. A doc bigger than a whole page ships ALONE rather
    // than being refused: a 6 MB note is legitimate (the ceiling is MAX_NOTE_MB)
    // and a joiner that could never receive it would retry the same page
    // forever.
    const take: Array<{ seq: number; doc_id: string }> = [];
    let planBytes = 0;
    for (const row of planned) {
      if (take.length > 0 && planBytes + row.bytes > budget) break;
      take.push({ seq: row.seq, doc_id: row.doc_id });
      planBytes += row.bytes;
    }

    if (take.length === 0) {
      await client.query("COMMIT");
      return { body: await gzipAsync(encodeBootstrapPage([])), nextCursor: null, docs: 0, bytes: 0 };
    }

    const ids = take.map((t) => t.doc_id);
    const [snapshots, updates, paths] = [
      await q<{ doc_id: string; snapshot: Buffer }>(
        "SELECT doc_id, snapshot FROM doc_snapshots WHERE doc_id = ANY($1::text[])",
        [ids],
      ),
      await q<{ doc_id: string; update: Buffer }>(
        "SELECT doc_id, update FROM doc_updates WHERE doc_id = ANY($1::text[]) ORDER BY doc_id, id",
        [ids],
      ),
      await q<{ id: string; rel_path: string }>(
        "SELECT id, rel_path FROM notes WHERE id = ANY($1::text[])",
        [ids],
      ),
    ];
    await client.query("COMMIT");

    const snapById = new Map(snapshots.map((r) => [r.doc_id, r.snapshot]));
    const pathById = new Map(paths.map((r) => [r.id, r.rel_path]));
    const updatesById = new Map<string, Buffer[]>();
    for (const r of updates) {
      const list = updatesById.get(r.doc_id);
      if (list) list.push(r.update);
      else updatesById.set(r.doc_id, [r.update]);
    }

    const docs: BootstrapDoc[] = [];
    let bytes = 0;
    for (const { doc_id } of take) {
      const parts: Uint8Array[] = [];
      const snap = snapById.get(doc_id);
      if (snap) parts.push(new Uint8Array(snap));
      for (const u of updatesById.get(doc_id) ?? []) parts.push(new Uint8Array(u));
      if (parts.length === 0) continue; // raced a purge; the client re-asks
      // `Y.mergeUpdates`, never `new Y.Doc()`: building a doc costs the full
      // struct graph of the note in heap, and this runs 256 times per page.
      const update = parts.length === 1 ? parts[0] : Y.mergeUpdates(parts);
      const doc: BootstrapDoc = { docId: doc_id, relPath: pathById.get(doc_id) ?? "", update };
      docs.push(doc);
      bytes += encodedDocBytes(doc);
    }

    const lastSeq = take[take.length - 1].seq;
    // Drained iff this page emptied the plan — `planned` was read with a LIMIT,
    // so "fewer rows than the limit AND we took them all" is the only honest
    // proof there is nothing after `lastSeq`.
    const drained = planned.length < config.bootstrapMaxPageDocs && take.length === planned.length;
    return {
      body: await gzipAsync(encodeBootstrapPage(docs), { level: 4 }),
      nextCursor: drained ? null : lastSeq,
      docs: docs.length,
      bytes,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
