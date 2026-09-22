/**
 * Blob lifecycle sweeps.
 *
 * THREE of them, on one timer:
 *
 *   1. **pending** (always on) — abandoned uploads, below.
 *   2. **deletion queue** (always on) — objects whose `blobs` row is already
 *      gone. Migration 027's `AFTER DELETE` trigger queues them, because a
 *      vault cascade and an org delete remove rows without running a line of
 *      application code; this is the only place that knows the bytes survived
 *      and has a store to remove them with.
 *   3. **orphan** (OPT-IN, `BLOB_GC_ENABLED`) — a stored attachment no note
 *      references any more. The only sweep that deletes something a user made,
 *      and therefore the only one wrapped in guards rather than just a TTL.
 *
 * The pending sweep, and why it has to exist at all: `intent` made abandoned
 * uploads possible. Before it, every `blobs` row
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
 * So the sweep deletes the row and, best-effort first, the bytes.
 *
 * Scheduling: there is no scheduler in this process, so it is an `unref()`ed
 * interval — a timer that never holds the process open — and every tick runs
 * under a Postgres advisory lock so N instances behind a load balancer do not
 * all sweep the same rows. Same pattern as `versions/checkpoints.ts`.
 */
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import {
  BLOB_GC_ENABLED,
  BLOB_GC_INTERVAL_MS,
  BLOB_GC_MAX_DELETES_PER_RUN,
  BLOB_GC_ORPHAN_DAYS,
  BLOB_PENDING_TTL_MINUTES,
} from "./config.js";
import { rebuildBlobRefs } from "./refs.js";
import { BlobStoreError, resolveStoreForRow, storageKeyForRow, type StorageRow } from "./store.js";

/**
 * How often a tick runs. The pending TTL is an hour and the deletion queue
 * wants draining promptly, so four looks per hour suits both; the orphan sweep
 * runs on the same timer but no more often than `BLOB_GC_INTERVAL_MS` (see
 * {@link runBlobGcTick}), which is what keeps this ONE timer rather than three.
 */
export const BLOB_GC_TICK_MS = 15 * 60_000;

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
      // The swept row held the (vault, sha256) dedupe slot, so the most likely
      // next event is someone re-uploading exactly these bytes — onto exactly
      // this key. Never delete an object a live row is standing on.
      if (await objectStillReferenced(pool, row.storage_provider, key)) {
        console.log(
          `[blob-gc] kept the bytes of swept pending blob ${row.id}: a live blobs row still points at ${key}.`,
        );
        continue;
      }
      await store.delete(key);
    } catch (err) {
      console.warn(`[blob-gc] could not remove bytes for swept blob ${row.id}:`, err);
    }
  }
  return rows.length;
}

/**
 * Is a LIVE `blobs` row still standing on this object?
 *
 * Object keys are content-addressed and deterministic (`keys.ts`:
 * `vaults/<vaultId>/<sha256>`), so "the row that owned this key is gone" is NOT
 * the same as "these bytes are unreferenced". Delete a file and re-upload the
 * same content into the same vault inside the drain window (a tick is 15 min,
 * and a failing row backs off up to ~64 more) and the queued key now addresses
 * the NEW, `ready` row's object — removing it leaves a row whose downloads 404
 * forever, because the desktop's diff sees the row and never re-uploads.
 *
 * Asked immediately before every `store.delete`, never once at claim time: the
 * re-upload is exactly the thing that can happen in between.
 */
async function objectStillReferenced(
  db: Pick<pg.Pool, "query">,
  provider: string | null | undefined,
  storageKey: string,
): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM blobs
        WHERE storage_key = $1
          AND lower(coalesce(storage_provider, 'postgres')) = lower($2)
     ) AS live`,
    [storageKey, provider ?? "postgres"],
  );
  return rows[0]?.live === true;
}

// ── the deletion queue ─────────────────────────────────────────────────────

/** Queue rows claimed per tick. Small: each one is a round trip to an object
 *  store, and a backlog drains over several ticks rather than holding one. */
const DELETION_BATCH = 100;

/** After this many failures a row is left alone with its `last_error` for an
 *  operator to look at. Ten failures spread over the backoff below is the best
 *  part of a day of trying; past that the problem is not transient. */
const MAX_DELETION_ATTEMPTS = 10;

interface DeletionRow {
  id: string;
  provider: string;
  storage_key: string;
  attempts: number;
}

/**
 * Drain the object-deletion queue once. Returns how many objects were removed.
 *
 * Always on, whatever `BLOB_GC_ENABLED` says: this deletes bytes whose row is
 * ALREADY gone, on the instruction of a delete that has already committed. It
 * is the opposite of the orphan sweep's judgement call.
 *
 * The lock is held only across the CLAIM, not across the network work. Bumping
 * `last_attempt_at` as rows are claimed doubles as a lease — the backoff filter
 * below then hides them from every other instance's tick — so the transaction
 * commits in milliseconds instead of being held open for a hundred round trips
 * to a bucket.
 */
export async function drainBlobDeletionsOnce(pool: pg.Pool = defaultPool): Promise<number> {
  const client = await pool.connect();
  let rows: DeletionRow[] = [];
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      ["blob-gc-deletions"],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return 0;
    }
    // Exponential backoff measured from the last attempt: 30s, 60s, 2m, … up to
    // ~64 minutes, so a bucket that is down for an hour is retried a handful of
    // times rather than hammered every tick.
    const claimed = await client.query<DeletionRow>(
      `UPDATE blob_deletions
          SET last_attempt_at = now()
        WHERE id IN (
          SELECT id FROM blob_deletions
           WHERE attempts < $1
             AND (
               last_attempt_at IS NULL
               OR last_attempt_at < now()
                  - make_interval(secs => 30 * power(2, least(attempts, 7))::int)
             )
           ORDER BY id
           LIMIT $2
        )
        RETURNING id, provider, storage_key, attempts`,
      [MAX_DELETION_ATTEMPTS, DELETION_BATCH],
    );
    rows = claimed.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let removed = 0;
  for (const row of rows) {
    try {
      // The row carries its own provider, exactly like a `blobs` row does, so a
      // queue filled while the server was on S3 still drains after an operator
      // flips new writes back to Postgres.
      const store = await resolveStoreForRow({
        id: `blob_deletions:${row.id}`,
        storage_provider: row.provider,
        storage_key: row.storage_key,
      });
      // Aborts first: a key may hold an unfinished multipart upload instead of
      // an object, and only one of the two can be true.
      await store.abortMultipartsForKey(row.storage_key).catch(() => {});
      // A queued key can have been re-claimed since the delete that queued it
      // (see `objectStillReferenced`). Dropping the QUEUE row and keeping the
      // object is right: the bytes are in use, and if that row is deleted later
      // the trigger queues them again.
      if (await objectStillReferenced(pool, row.provider, row.storage_key)) {
        console.log(
          `[blob-gc] discarding deletion ${row.id}: a live blobs row now points at ${row.provider}:${row.storage_key}.`,
        );
        await pool.query("DELETE FROM blob_deletions WHERE id = $1", [row.id]);
        continue;
      }
      await store.delete(row.storage_key);
      await pool.query("DELETE FROM blob_deletions WHERE id = $1", [row.id]);
      removed++;
    } catch (err) {
      // A provider this build cannot talk to is not a failed attempt — it is a
      // deployment that has not been given the bucket yet, and counting it
      // would burn the row's ten tries against a configuration problem. The
      // lease expires and it is picked up again once the config arrives.
      if (err instanceof BlobStoreError && err.code === "storage_unavailable") {
        console.warn(
          `[blob-gc] deletion ${row.id} needs \`${row.provider}\`, which this server has no configuration for; leaving it queued.`,
        );
        continue;
      }
      const attempts = row.attempts + 1;
      await pool
        .query(
          "UPDATE blob_deletions SET attempts = $2, last_error = $3 WHERE id = $1",
          [row.id, attempts, String((err as Error)?.message ?? err).slice(0, 500)],
        )
        .catch(() => {});
      if (attempts >= MAX_DELETION_ATTEMPTS) {
        // Left in the table on purpose. The object is still there and still
        // being billed, and a row with a `last_error` is the only record of it;
        // deleting the row would lose the leak AND the reason for it.
        console.error(
          `[blob-gc] giving up on deleting ${row.provider}:${row.storage_key} after ${attempts} attempts:`,
          err,
        );
      } else {
        console.warn(`[blob-gc] deletion ${row.id} failed (attempt ${attempts}):`, err);
      }
    }
  }
  return removed;
}

// ── the orphan sweep ───────────────────────────────────────────────────────

interface OrphanRow {
  id: string;
  vault_id: string;
  rel_path: string | null;
  size: string | number | null;
}

/**
 * Delete stored attachments that no note references any more. Returns how many
 * rows were removed (their objects go through the deletion queue above).
 *
 * The guards, and what each one is defending against:
 *
 *   · **`BLOB_GC_ENABLED`** — off by default. Everything below is a reason this
 *     sweep can be wrong; the switch is the admission that they might not be
 *     enough.
 *   · **age** (`BLOB_GC_ORPHAN_DAYS`) — an attachment is uploaded before the
 *     note embedding it is written, and that note may be indexed days later
 *     (an offline device). Young blobs are not orphans, they are in flight.
 *   · **a vault with no `note_index` rows is skipped** — an unindexed vault
 *     says nothing references anything, which is not the same as nothing
 *     referencing anything.
 *   · **a vault with notes but no `blob_refs` is rebuilt, then re-asked** —
 *     this table is new, so every vault indexed by an older build is in exactly
 *     that state, and it is indistinguishable from "genuinely references
 *     nothing" without asking the note text again.
 *   · **`rel_path IS NULL` is never collected** — a blob with no path cannot be
 *     referenced BY path, so the evidence that it is unused is missing rather
 *     than negative.
 *   · **`doc_id IS NOT NULL` is never collected** — a doc-backed blob IS a
 *     registered tree file, not an attachment, and `blob_refs` only ever holds
 *     `attachments/…` paths (`refs.ts` returns early on anything else). So every
 *     tree file is an "orphan" by construction and this sweep, once enabled,
 *     would delete the bytes of every PDF in the vault. A tree file's lifetime is
 *     `DELETE /api/files/:id`, never a TTL.
 *   · **`BLOB_GC_MAX_DELETES_PER_RUN`** — the blast radius if all of the above
 *     is somehow still wrong.
 *
 * Every deletion is logged with its id, vault, path and size, because the only
 * thing worse than deleting the wrong file is not being able to say which.
 */
export async function sweepOrphansOnce(
  pool: pg.Pool = defaultPool,
  opts: { enabled?: boolean; orphanDays?: number; maxDeletes?: number } = {},
): Promise<number> {
  const enabled = opts.enabled ?? BLOB_GC_ENABLED;
  if (!enabled) return 0;
  const orphanDays = opts.orphanDays ?? BLOB_GC_ORPHAN_DAYS;
  const maxDeletes = opts.maxDeletes ?? BLOB_GC_MAX_DELETES_PER_RUN;
  if (maxDeletes <= 0) return 0;

  const client = await pool.connect();
  try {
    // One transaction around the whole sweep. `pg_try_advisory_xact_lock`
    // outside an explicit transaction would be released by the very statement
    // that took it, and there is no network work here to keep it short for —
    // every step is a query, and the object deletions happen later, through the
    // queue the DELETEs below fill.
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      ["blob-gc-orphans"],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return 0;
    }

    // Only vaults that HAVE a candidate are considered, so the per-vault guards
    // below are paid for once per vault that might lose something rather than
    // once per vault in the database.
    const { rows: vaults } = await client.query<{ vault_id: string }>(
      `SELECT DISTINCT b.vault_id
         FROM blobs b
        WHERE b.status = 'ready'
          AND b.vault_id IS NOT NULL
          AND b.rel_path IS NOT NULL
          AND b.doc_id IS NULL
          AND b.created_at < now() - ($1 || ' days')::interval`,
      [String(orphanDays)],
    );

    let deleted = 0;
    for (const { vault_id: vaultId } of vaults) {
      if (deleted >= maxDeletes) break;

      const { rows: counts } = await client.query<{ notes: number; refs: number }>(
        `SELECT (SELECT count(*) FROM note_index WHERE vault_id = $1)::int AS notes,
                (SELECT count(*) FROM blob_refs  WHERE vault_id = $1)::int AS refs`,
        [vaultId],
      );
      const notes = counts[0]?.notes ?? 0;
      let refs = counts[0]?.refs ?? 0;
      if (notes === 0) {
        console.warn(
          `[blob-gc] vault ${vaultId} has no indexed notes; skipping its attachments rather than calling them orphans.`,
        );
        continue;
      }
      if (refs === 0) {
        // Indexed notes, no references: either the notes genuinely embed
        // nothing, or this vault was indexed by a build with no `blob_refs`.
        // Rebuild from the note text and ask again — the only way to tell.
        const rebuilt = await rebuildBlobRefs(vaultId, client);
        const { rows: after } = await client.query<{ refs: number }>(
          "SELECT count(*)::int AS refs FROM blob_refs WHERE vault_id = $1",
          [vaultId],
        );
        refs = after[0]?.refs ?? 0;
        console.log(
          `[blob-gc] vault ${vaultId} had no blob_refs; rebuilt from ${rebuilt} note(s) → ${refs} reference(s).`,
        );
      }

      const { rows: orphans } = await client.query<OrphanRow>(
        `SELECT b.id, b.vault_id, b.rel_path, b.size
           FROM blobs b
          WHERE b.vault_id = $1
            AND b.status = 'ready'
            AND b.rel_path IS NOT NULL
            AND b.doc_id IS NULL
            AND b.created_at < now() - ($2 || ' days')::interval
            AND NOT EXISTS (
              SELECT 1 FROM blob_refs r
               WHERE r.vault_id = b.vault_id AND r.rel_path = lower(b.rel_path)
            )
          ORDER BY b.created_at
          LIMIT $3`,
        [vaultId, String(orphanDays), maxDeletes - deleted],
      );

      for (const orphan of orphans) {
        // One row at a time, so the log line and the deletion cannot disagree.
        // The AFTER DELETE trigger queues the object; nothing here needs to
        // know whether this vault's bytes live in Postgres or a bucket.
        await client.query("DELETE FROM blobs WHERE id = $1", [orphan.id]);
        deleted++;
        console.log(
          `[blob-gc] orphan removed: blob=${orphan.id} vault=${orphan.vault_id} path=${orphan.rel_path} size=${Number(orphan.size ?? 0)}`,
        );
      }
    }
    await client.query("COMMIT");
    return deleted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── the timer ──────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
/** When the orphan sweep last ran, so it can be rate-limited to
 *  `BLOB_GC_INTERVAL_MS` without a second timer. Epoch ms; 0 = never. */
let lastOrphanSweep = 0;

/**
 * One tick: the two always-on sweeps, plus the orphan sweep when it is both
 * enabled and due.
 *
 * Exported so an operator (or a test) can run a full cycle on demand. Each
 * sweep takes its OWN advisory lock, so a slow one never blocks the others
 * across instances, and a failure in one is logged rather than skipping the
 * rest.
 */
export async function runBlobGcTick(pool: pg.Pool = defaultPool): Promise<void> {
  await sweepPendingOnce(pool)
    .then((n) => n > 0 && console.log(`[blob-gc] swept ${n} abandoned pending upload(s).`))
    .catch((err) => console.error("[blob-gc] pending sweep failed:", err));

  await drainBlobDeletionsOnce(pool)
    .then((n) => n > 0 && console.log(`[blob-gc] deleted ${n} orphaned object(s) from storage.`))
    .catch((err) => console.error("[blob-gc] deletion queue drain failed:", err));

  if (!BLOB_GC_ENABLED) return;
  const now = Date.now();
  if (now - lastOrphanSweep < BLOB_GC_INTERVAL_MS) return;
  lastOrphanSweep = now;
  await sweepOrphansOnce(pool)
    .then((n) => n > 0 && console.log(`[blob-gc] collected ${n} unreferenced attachment(s).`))
    .catch((err) => console.error("[blob-gc] orphan sweep failed:", err));
}

/** Start the lifecycle sweeps. Idempotent; a second call is a no-op. */
export function startBlobGc(pool: pg.Pool = defaultPool): void {
  if (timer) return;
  // The first orphan sweep waits a full interval rather than running at boot:
  // a process that is restarting in a crash loop must not sweep on every start.
  lastOrphanSweep = Date.now();
  timer = setInterval(() => {
    void runBlobGcTick(pool);
  }, BLOB_GC_TICK_MS);
  // A background sweep is never a reason for the process to stay alive.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopBlobGc(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
