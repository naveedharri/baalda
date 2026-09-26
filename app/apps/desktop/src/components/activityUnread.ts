/* Unread bookkeeping for the Activity feed's toolbar badge. A row is identified
   by `key@at`, so the same row seen again stays read, and a row that comes back
   with a new time (a note deleted again) is new again.

   `since` is when this device first kept a read state for the vault: anything
   older counts as read, so the first launch after this ships does not flag a
   month of Trash. A row that arrives LATE but with a newer time than `since`
   (a teammate's delete fetched on the next poll) still counts.

   Persisted per vault in localStorage (try/catch), so a restart re-flags nothing. */

export interface ReadState {
  since: number;
  /** `key@at` of rows marked read, newest kept first. */
  read: string[];
}

export const READ_STATE_MAX = 1000;
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
 *  a caller can skip a write. Keeps at most READ_STATE_MAX ids, newest first. */
export function markAllRead(state: ReadState, rows: readonly RowLike[]): ReadState {
  const fresh = unreadRows(rows, state);
  if (fresh.length === 0) return state;
  const added = fresh
    .slice()
    .sort((a, b) => b.at - a.at)
    .map(rowId);
  return { since: state.since, read: [...added, ...state.read].slice(0, READ_STATE_MAX) };
}

/** "99+" past 99; empty at 0. */
export function badgeText(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

export function parseReadState(raw: string | null): ReadState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReadState>;
    if (typeof v?.since !== "number" || !Array.isArray(v.read)) return null;
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
