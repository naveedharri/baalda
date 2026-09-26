/* A small per-vault, device-local log of the Activity feed's NOTICE rows that
   the app otherwise forgets on restart: reconcile notices (a file restored from
   the server, a folder kept alive), access changes, sync failures and a held
   bulk delete while it is held. Reconcile review items, Trash, shrink events
   and recovery copies have their own durable sources and are not logged here.

   localStorage, one key per vault root, every access in try/catch: an empty or
   throwing store only means the feed starts from this session's rows. Seeded
   entries feed the Activity list only; they never re-enter the reconcile report,
   so they cannot re-raise its banner. The pure half (append / dedupe / prune)
   is what the tests pin. */

export type ActivityLogKind = "restoredFromServer" | "folderKept" | "access" | "failed" | "held";

export interface ActivityLogEntry {
  /** Stable across sessions; the feed row key. */
  id: string;
  kind: ActivityLogKind;
  path: string;
  newPath?: string;
  /** Kind-specific text: the failure reason, the access wording, the held count. */
  detail?: string;
  /** Doc id where there is one (Open / Retry resolve by it). */
  docId?: string;
  at: number;
}

export const ACTIVITY_LOG_MAX_AGE_MS = 30 * 86_400_000;
export const ACTIVITY_LOG_MAX = 500;
const KEY_PREFIX = "baalda.activity.v1:";

export const activityLogKey = (vaultRoot: string) => `${KEY_PREFIX}${vaultRoot}`;

/** Drop entries older than 30 days, then keep the newest ACTIVITY_LOG_MAX. */
export function pruneLog(log: readonly ActivityLogEntry[], now: number): ActivityLogEntry[] {
  const fresh = log.filter((e) => now - e.at <= ACTIVITY_LOG_MAX_AGE_MS);
  fresh.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return fresh.slice(-ACTIVITY_LOG_MAX);
}

/** Append, deduped by id: the FIRST record of an id wins (its time is when it
 *  happened; a re-record is the same event seen again). Pruned after. */
export function appendLog(
  log: readonly ActivityLogEntry[],
  entries: readonly ActivityLogEntry[],
  now: number,
): ActivityLogEntry[] {
  const ids = new Set(log.map((e) => e.id));
  const next = log.slice();
  for (const e of entries) {
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    next.push(e);
  }
  return pruneLog(next, now);
}

/** Remove entries by id (a held batch that resolved). */
export function removeFromLog(log: readonly ActivityLogEntry[], ids: readonly string[]): ActivityLogEntry[] {
  const drop = new Set(ids);
  return log.filter((e) => !drop.has(e.id));
}

function isEntry(v: unknown): v is ActivityLogEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.kind === "string" && typeof e.path === "string" && typeof e.at === "number";
}

/** Parse a stored value; anything malformed is dropped entry by entry. */
export function parseLog(raw: string | null, now: number): ActivityLogEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? pruneLog(v.filter(isEntry), now) : [];
  } catch {
    return [];
  }
}

export function loadLog(vaultRoot: string, now = Date.now()): ActivityLogEntry[] {
  try {
    return parseLog(localStorage.getItem(activityLogKey(vaultRoot)), now);
  } catch {
    return [];
  }
}

export function saveLog(vaultRoot: string, log: readonly ActivityLogEntry[]): void {
  try {
    localStorage.setItem(activityLogKey(vaultRoot), JSON.stringify(log));
  } catch {
    /* private window / quota: the feed still shows this session's rows */
  }
}
