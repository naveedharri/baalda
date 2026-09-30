/**
 * Server-side brakes on renaming OTHER people's notes (`PATCH /api/notes/:id`).
 *
 * On 2026-09-30 one desktop client, after a "Reset local copy", mistook freshly
 * downloaded notes for same-path clashes and renamed 619 teammates' notes to
 * `<stem> (conflict YYYY-MM-DD).md` in six minutes. Every rename was a valid,
 * permitted request on its own, so nothing here stopped it. The client is fixed;
 * these two rules make sure no client — including one that has not updated yet —
 * can do that to a team again:
 *
 *  1. A rename that ADDS a conflict suffix to a note someone else created is
 *     refused. Only the desktop's same-path reconciliation makes those names,
 *     and it already falls back to moving its own copy when the server says no,
 *     which is always the safe side of that choice.
 *  2. Renames of notes someone else created are budgeted per (user, vault):
 *     past {@link FOREIGN_RENAME_MAX} inside {@link FOREIGN_RENAME_WINDOW_MS}
 *     the route answers 429. A person reorganising a teammate's notes by hand
 *     never gets near it; a folder move is one request to `/folders/:id`.
 *
 * In process memory on purpose: it is a burst brake, not an audit trail, and a
 * restart forgetting a window is harmless. MCP moves (`move_note`) are an
 * explicit instruction and are not budgeted here.
 */

export const FOREIGN_RENAME_MAX = 100;
export const FOREIGN_RENAME_WINDOW_MS = 5 * 60_000;

/** ` (conflict 2026-09-30)` right before the extension (or at the end). */
const CONFLICT_SUFFIX = / \(conflict \d{4}-\d{2}-\d{2}\)(?:\.[^./]*)?$/;

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Does `to` carry a conflict suffix that `from` did not? */
export function gainsConflictSuffix(from: string, to: string): boolean {
  return CONFLICT_SUFFIX.test(baseName(to)) && !CONFLICT_SUFFIX.test(baseName(from));
}

const windows = new Map<string, number[]>();

/**
 * Spend one foreign rename for (user, vault). False ⇒ over budget; nothing is
 * spent. Returns the seconds until a slot frees up via `retryAfter`.
 */
export function takeForeignRename(
  userId: string,
  vaultId: string,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfter: number } {
  const key = `${userId}\u0000${vaultId}`;
  const cutoff = now - FOREIGN_RENAME_WINDOW_MS;
  const hits = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= FOREIGN_RENAME_MAX) {
    windows.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0]! - cutoff) / 1000)) };
  }
  hits.push(now);
  windows.set(key, hits);
  // Bounded: keys whose window has fully expired are dropped as we go.
  if (windows.size > 10_000) {
    for (const [k, ts] of windows) if (!ts.some((t) => t > cutoff)) windows.delete(k);
  }
  return { ok: true };
}

/** Tests only. */
export function resetRenameGuard(): void {
  windows.clear();
}
