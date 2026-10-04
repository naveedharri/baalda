import type pg from "pg";

/**
 * In-process counters that prove (or disprove) one-step note sync
 * (plan `one-step-note-sync.md` §8): seeds applied at registration, the
 * `ready.empty` / `ready.behind` gap new clients still see, and checkpoints
 * that had to store notes structure-only or defer.
 *
 * Deliberately tiny: no dependency, no Postgres writes, no scheduled query.
 * Counters are process-local and reset on restart; a second instance keeps
 * its own. Every 60 s, and only when something changed since the last flush,
 * one structured line goes to the log:
 *
 *   [sync-metrics] {"windowS":60,"counters":{"seed.applied":12,...}}
 *
 * The flushed values are the DELTA since the previous flush, so a log search
 * can sum them across lines and instances. `snapshot()` returns the running
 * totals for tests. Log hygiene: ids and counts only, never paths or text.
 */

type Queryable = Pick<pg.Pool, "query">;

/** Flush period for the one-line summary. */
export const SYNC_METRICS_FLUSH_MS = 60_000;

const totals = new Map<string, number>();
const flushed = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastFlushAt = Date.now();

/** Add `by` (default 1) to counter `name`. Non-finite or zero is ignored. */
export function inc(name: string, by = 1): void {
  if (!Number.isFinite(by) || by === 0) return;
  totals.set(name, (totals.get(name) ?? 0) + by);
  ensureFlushTimer();
}

/** Running totals since process start (or the last {@link resetSyncMetrics}). */
export function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
  return out;
}

/**
 * Bucket label for a per-connect list size. The lists are capped at 2000 on
 * the wire, so the top bucket is `101-2000` (a truncated list lands there too).
 */
export function countBucket(n: number): "0" | "1-10" | "11-100" | "101-2000" {
  if (!(n > 0)) return "0";
  if (n <= 10) return "1-10";
  if (n <= 100) return "11-100";
  return "101-2000";
}

/** Count one connect's list size: `<name>` total, `<name>.connects`, and the bucket. */
export function observeCount(name: string, n: number): void {
  const value = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2000) : 0;
  inc(`${name}.connects`);
  inc(name, value);
  inc(`${name}.bucket.${countBucket(value)}`);
}

/**
 * Changes since the last flush, or null when nothing changed. Advances the
 * flush baseline, so the next call only reports what happened after this one.
 */
export function takeDelta(): Record<string, number> | null {
  const delta: Record<string, number> = {};
  let changed = false;
  for (const [k, v] of totals) {
    const d = v - (flushed.get(k) ?? 0);
    if (d !== 0) {
      delta[k] = d;
      changed = true;
    }
    flushed.set(k, v);
  }
  return changed ? delta : null;
}

/** Emit the one-line summary if anything changed. Exported for tests and shutdown. */
export function flushSyncMetrics(now = Date.now()): string | null {
  const delta = takeDelta();
  const windowS = Math.max(0, Math.round((now - lastFlushAt) / 1000));
  lastFlushAt = now;
  if (!delta) return null;
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(delta).sort()) sorted[k] = delta[k];
  const line = `[sync-metrics] ${JSON.stringify({ windowS, counters: sorted })}`;
  console.info(line);
  return line;
}

function ensureFlushTimer(): void {
  if (timer) return;
  lastFlushAt = Date.now();
  timer = setInterval(() => {
    try {
      flushSyncMetrics();
    } catch {
      // A metrics flush must never take the process down.
    }
  }, SYNC_METRICS_FLUSH_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/** Clear every counter and stop the flush timer (tests). */
export function resetSyncMetrics(): void {
  totals.clear();
  flushed.clear();
  if (timer) clearInterval(timer);
  timer = null;
  lastFlushAt = Date.now();
}

/** Upper bound on the gauge below, so one probe stays cheap on a huge vault. */
export const STATELESS_COUNT_CAP = 10_000;

/**
 * Gauge: live notes in `vaultId` registered more than `olderThanSec` ago that
 * the server still holds NO CRDT for (no `doc_updates`, no `doc_snapshots`).
 * Notes confirmed empty are excluded: they have nothing to send. For new
 * clients this should be 0 once one-step registration ships. Capped at
 * {@link STATELESS_COUNT_CAP}; `capped` says the true number is at least that.
 *
 * One query, called only where the checkpoint deferral already asks the same
 * question — never on a schedule.
 */
export async function countRegisteredWithoutState(
  db: Queryable,
  vaultId: string,
  olderThanSec: number,
): Promise<{ count: number; capped: boolean }> {
  const { rows } = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM notes n
        WHERE n.vault_id = $1 AND n.deleted_at IS NULL AND n.confirmed_empty_at IS NULL
          AND n.created_at < now() - ($2::bigint * interval '1 second')
          AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = n.id)
        LIMIT $3
     ) t`,
    [vaultId, Math.max(0, Math.floor(olderThanSec)), STATELESS_COUNT_CAP],
  );
  const count = Number(rows[0]?.n ?? 0);
  return { count, capped: count >= STATELESS_COUNT_CAP };
}
