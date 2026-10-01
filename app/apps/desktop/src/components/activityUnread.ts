/* Unread bookkeeping for the Activity feed's toolbar badge. A row is identified
   by `key@at`, so the same row seen again stays read, and a row that comes back
   with a new time (a note deleted again) is new again.

   `since` is when this device first kept a read state for the vault: anything
   older counts as read, so the first launch after this ships does not flag a
   month of Trash. A row that arrives LATE but with a newer time than `since`
   (a teammate's delete fetched on the next poll) still counts. Only a feed too
   big to list moves `since` forward (see `markAllRead`).

   Persisted per vault in localStorage (try/catch), so a restart re-flags nothing. */

export interface ReadState {
  since: number;
  /** `key@at` of rows marked read, newest kept first. */
  read: string[];
}

export const READ_STATE_MAX = 5000;
const KEY_PREFIX = "baalda.activity.read.v1:";

export const readStateKey = (vaultRoot: string) => `${KEY_PREFIX}${vaultRoot}`;

interface RowLike {
  key: string;
  at: number;
}

export const rowId = (r: RowLike) => `${r.key}@${r.at}`;

export function freshReadState(now: number): ReadState {
  return { since: now, read: [] };
}

export function unreadRows<R extends RowLike>(rows: readonly R[], state: ReadState): R[] {
  const read = new Set(state.read);
  return rows.filter((r) => r.at > state.since && !read.has(rowId(r)));
}

export function unreadCount(rows: readonly RowLike[], state: ReadState): number {
  return unreadRows(rows, state).length;
}

/** Mark every given row read. Returns the SAME object when nothing changed, so
 *  a caller can skip a write.
 *
 *  `rows` is the WHOLE feed, so the id list is rebuilt from it rather than
 *  prepended to: ids of rows that left the feed fall away by themselves, and
 *  the list is bounded by the feed, not by history. The old prepend-and-cap at
 *  1,000 could never hold a burst bigger than the cap — 1,853 rows left 853
 *  unread forever, a "99+" that opening the panel could not clear. A feed past
 *  READ_STATE_MAX still cannot be listed, so it moves the watermark instead
 *  (a later row stamped older than the newest one then counts as read). */
export function markAllRead(state: ReadState, rows: readonly RowLike[]): ReadState {
  const fresh = unreadRows(rows, state);
  if (fresh.length === 0) return state;
  const after = rows.filter((r) => r.at > state.since);
  if (after.length <= READ_STATE_MAX) {
    const ids = [...new Set(after.slice().sort((a, b) => b.at - a.at).map(rowId))];
    return { since: state.since, read: ids };
  }
  let newest = state.since;
  for (const r of rows) if (r.at > newest) newest = r.at;
  return { since: newest, read: [] };
}

/** "99+" past 99; empty at 0. */
export function badgeText(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

export function parseReadState(raw: string | null): ReadState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReadState> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (typeof v.since !== "number" || !Number.isFinite(v.since) || !Array.isArray(v.read)) return null;
    return { since: v.since, read: v.read.filter((x): x is string => typeof x === "string").slice(0, READ_STATE_MAX) };
  } catch {
    return null;
  }
}

/** The stored state, or a fresh one starting now (and stored, so `since` holds). */
export function loadReadState(vaultRoot: string, now = Date.now()): ReadState {
  try {
    const got = parseReadState(localStorage.getItem(readStateKey(vaultRoot)));
    if (got) return got;
  } catch {
    return freshReadState(now);
  }
  const fresh = freshReadState(now);
  saveReadState(vaultRoot, fresh);
  return fresh;
}

export function saveReadState(vaultRoot: string, state: ReadState): void {
  try {
    localStorage.setItem(readStateKey(vaultRoot), JSON.stringify(state));
  } catch {
    /* unavailable storage: the badge still works for this session */
  }
}

// ── Clear ────────────────────────────────────────────────────────────────────
// Activity → Clear hides every row up to the moment it was pressed, on this
// device, for this vault. A watermark like the read state, persisted the same
// way; anything that happens afterwards shows normally.

const CLEARED_PREFIX = "baalda.activity.cleared.v1:";

export const clearedKey = (vaultRoot: string) => `${CLEARED_PREFIX}${vaultRoot}`;

export function parseClearedAt(raw: string | null): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function loadClearedAt(vaultRoot: string): number {
  try {
    return parseClearedAt(localStorage.getItem(clearedKey(vaultRoot)));
  } catch {
    return 0;
  }
}

export function saveClearedAt(vaultRoot: string, at: number): void {
  try {
    localStorage.setItem(clearedKey(vaultRoot), String(at));
  } catch {
    /* unavailable storage: the list is cleared for this session only */
  }
}

/** The rows still shown after a Clear at `clearedAt` (0 = never cleared). */
export function afterClear<R extends RowLike>(rows: readonly R[], clearedAt: number): R[] {
  return clearedAt > 0 ? rows.filter((r) => r.at > clearedAt) : rows.slice();
}
