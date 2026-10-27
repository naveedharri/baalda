import type pg from "pg";
import { planEnforced, resolveAccountPlan } from "../billing/plan.js";

/**
 * How often a vault's checkpoints are taken, by its plan.
 *
 * A paid vault (resolved plan `team`; under the legacy per-vault model, an
 * active Pro vault) and any deployment that does not enforce billing (self-host,
 * dev, billing off) keep the full cadence: the automatic daily checkpoint plus
 * unlimited manual ones. A Free vault with billing enforced takes no automatic
 * checkpoints and may make one manual checkpoint per {@link FREE_MANUAL_CHECKPOINT_MS},
 * counted from its newest `manual` checkpoint whoever made it. Existing
 * checkpoints stay listable, revertable and deletable either way.
 */

type Queryable = Pick<pg.Pool, "query">;

export interface CheckpointSchedule {
  /** Whether `maybeDailyCheckpoint` takes automatic checkpoints. */
  auto: boolean;
  /** Minimum gap between manual checkpoints, or null for unlimited. */
  manualEveryMs: number | null;
}

/** Rolling window for a Free vault's one manual checkpoint. */
export const FREE_MANUAL_CHECKPOINT_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a vault's schedule is remembered in-process. The daily-checkpoint
 * path is activity-triggered and on a Free vault its "due" test is always true
 * (it has no `auto` rows), so without this it would resolve the plan on every
 * activity burst. A plan change is picked up within this window; the HTTP
 * routes ask with `fresh` so an upgrade shows at once.
 */
export const CHECKPOINT_SCHEDULE_TTL_MS = 5 * 60_000;

const FULL: CheckpointSchedule = { auto: true, manualEveryMs: null };
const FREE: CheckpointSchedule = { auto: false, manualEveryMs: FREE_MANUAL_CHECKPOINT_MS };

const cache = new Map<string, { at: number; schedule: CheckpointSchedule }>();

export async function checkpointSchedule(
  db: Queryable,
  vaultId: string,
  opts: { fresh?: boolean; now?: number } = {},
): Promise<CheckpointSchedule> {
  if (!planEnforced()) return FULL;
  const now = opts.now ?? Date.now();
  if (!opts.fresh) {
    const hit = cache.get(vaultId);
    if (hit && now - hit.at < CHECKPOINT_SCHEDULE_TTL_MS) return hit.schedule;
  }
  const { rows } = await db.query<{ org: string }>(
    "SELECT organization_id AS org FROM vaults WHERE id = $1",
    [vaultId],
  );
  const orgId = rows[0]?.org;
  // An unknown vault has nothing to checkpoint; answer the full cadence rather
  // than invent a limit for it.
  const schedule = orgId
    ? (await resolveAccountPlan(db, { orgId })).plan === "team"
      ? FULL
      : FREE
    : FULL;
  cache.set(vaultId, { at: now, schedule });
  return schedule;
}

/** When the next manual checkpoint may be made, or null if it may be made now. */
export async function nextManualCheckpointAt(
  db: Queryable,
  vaultId: string,
  schedule: CheckpointSchedule,
  now: number = Date.now(),
): Promise<Date | null> {
  if (schedule.manualEveryMs === null) return null;
  const { rows } = await db.query<{ at: Date | null }>(
    "SELECT max(created_at) AS at FROM vault_checkpoints WHERE vault_id = $1 AND kind = 'manual'",
    [vaultId],
  );
  const at = rows[0]?.at;
  if (!at) return null;
  const next = new Date(at).getTime() + schedule.manualEveryMs;
  return next > now ? new Date(next) : null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 3 Nov" (UTC). */
export function plainCheckpointDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Forget every cached schedule (tests). */
export function resetCheckpointScheduleCache(): void {
  cache.clear();
}
