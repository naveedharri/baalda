/**
 * Access changes THIS device just made to the signed-in user's own access.
 *
 * The Members and access page can take the viewer's own access away (a
 * person row for themselves, or Everyone → No access). The revocation that
 * follows is applied by sync exactly as any other — the safety guards decide
 * whether the file stays — but it should not read as something that happened
 * TO the user. The UI marks the resources it wrote; the sync layer asks here
 * when it records the outcome. In memory only, for {@link SELF_ACCESS_WINDOW_MS}.
 */
export const SELF_ACCESS_WINDOW_MS = 60_000;

/** resource id (vault org id, folder id or note doc id) → when it was marked. */
const marked = new Map<string, number>();

function prune(now: number): void {
  for (const [id, at] of marked) if (now - at > SELF_ACCESS_WINDOW_MS) marked.delete(id);
}

/** Record that the signed-in user just changed their OWN access to these resources. */
export function markSelfAccessChange(resourceIds: Iterable<string>, now: number = Date.now()): void {
  prune(now);
  for (const id of resourceIds) if (id) marked.set(id, now);
}

/** Was any of these ids (a doc, its ancestor folders, its vault) marked in the window? */
export function isSelfAccessChange(ids: Iterable<string | null | undefined>, now: number = Date.now()): boolean {
  prune(now);
  for (const id of ids) {
    if (!id) continue;
    const at = marked.get(id);
    if (at !== undefined && now - at <= SELF_ACCESS_WINDOW_MS) return true;
  }
  return false;
}

/** Tests only. */
export function resetSelfAccessChanges(): void {
  marked.clear();
}
