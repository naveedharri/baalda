/**
 * Blob lifecycle sweeps.
 *
 * PR 2b ships exactly ONE of them — the pending sweep — and it is always on,
 * because `intent` made abandoned uploads possible. Before it, every `blobs` row
 * was created and filled in a single request, so a row existing meant its bytes
 * existed. Now a row is created BEFORE a byte moves, and a client that quits
 * between `intent` and `complete` leaves behind:
 *
 *   · a `pending` row holding the (vault, sha256) DEDUPE SLOT — which is the
 *     real damage, because a later upload of that same content is handed the
 *     abandoned blob id instead of starting a fresh upload;
 *   · possibly an object at its key (the PUT landed, `complete` never ran);
 *   · possibly a multipart upload whose parts the bucket bills for until they
 *     are aborted (S3 and R2 both keep them indefinitely).
 *
 * So the sweep deletes the row and, best-effort first, the bytes. Orphan
 * sweeping (objects with no row) and the deletion queue are PR 2c's; this one
 * needs no new table and no reference tracking, which is why it can ship now.
 *
 * Scheduling: there is no scheduler in this process, so it is an `unref()`ed
 * interval — a timer that never holds the process open — and every tick runs
 * under a Postgres advisory lock so N instances behind a load balancer do not
 * all sweep the same rows. Same pattern as `versions/checkpoints.ts`.
 */
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { BLOB_PENDING_TTL_MINUTES } from "./config.js";
import { resolveStoreForRow, storageKeyForRow, type StorageRow } from "./store.js";

/** How often a tick runs. The TTL is an hour; four looks per hour is plenty. */
export const BLOB_GC_INTERVAL_MS = 15 * 60_000;

/** Rows removed in one tick, so a backlog drains over several ticks instead of
 *  holding a connection (and an advisory lock) for minutes. */
const SWEEP_BATCH = 200;

interface PendingRow extends StorageRow {
  id: string;
  storage_provider: string | null;
  storage_key: string | null;
}

/**
 * One sweep. Returns how many rows were removed.
 *
 * Exported for the tests, and deliberately callable on demand: an operator
 * cleaning up after an incident should not have to wait for a timer.
 *
 * `pg_try_advisory_xact_lock` — TRY, not wait: a second instance whose tick
 * lands during this one skips its turn rather than queueing behind it. The lock
 * is transaction-scoped, so it is released by COMMIT/ROLLBACK even if the
 * process dies mid-sweep.
 */
export async function sweepPendingOnce(pool: pg.Pool = defaultPool): Promise<number> {
  const client = await pool.connect();
  let rows: PendingRow[] = [];
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      ["blob-gc"],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return 0;
    }
    // `updated_at`, not `created_at`: `intent` refreshes it every time a client
    // re-asks for a presign on the same pending row, so a long upload that is
    // being retried is NOT collected out from under the client that is still
    // working on it. (The partial index is on `created_at`; this scan is over
    // the pending rows either way, and there are normally none.)
    //
    // The rows are deleted HERE, inside the lock, and their objects are removed
    // afterwards. The other order would be worse: an object deleted for a row
    // that then survives a rollback is a `ready`-looking blob with no bytes,
    // whereas an object left behind by a deleted row is an orphan, which is
    // exactly what PR 2c's orphan sweep is for.
    const deleted = await client.query<PendingRow>(
      `DELETE FROM blobs
         WHERE id IN (
           SELECT id FROM blobs
            WHERE status = 'pending'
              AND updated_at < now() - ($1 || ' minutes')::interval
            ORDER BY updated_at
            LIMIT $2
         )
         RETURNING id, storage_provider, storage_key`,
      [String(BLOB_PENDING_TTL_MINUTES), SWEEP_BATCH],
    );
    rows = deleted.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const row of rows) {
    // Best-effort, one row at a time, never fatal: the row is already gone, and
    // a bucket that is briefly unreachable must not stop the sweep (or crash
    // the interval, which has no supervisor).
    try {
      const store = await resolveStoreForRow(row);
      const key = storageKeyForRow(row);
      // Aborts first: a multipart upload and a finished object are mutually
      // exclusive, and there is nowhere to record which one this row got to.
      await store.abortMultipartsForKey(key).catch(() => {});
      await store.delete(key);
    } catch (err) {
      console.warn(`[blob-gc] could not remove bytes for swept blob ${row.id}:`, err);
    }
  }
  return rows.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the pending sweep. Idempotent; a second call is a no-op. */
export function startBlobGc(pool: pg.Pool = defaultPool): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepPendingOnce(pool)
      .then((n) => n > 0 && console.log(`[blob-gc] swept ${n} abandoned pending upload(s).`))
      .catch((err) => console.error("[blob-gc] sweep failed:", err));
  }, BLOB_GC_INTERVAL_MS);
  // A background sweep is never a reason for the process to stay alive.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopBlobGc(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
