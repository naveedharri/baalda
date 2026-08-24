/**
 * Deleting vault paths: on the server AND on disk, in that order, once.
 *
 * This exists because the two delete paths in the sidebar were hand-copied and
 * drifted. The single-item delete removed the file and told the server; the
 * multi-select delete removed the file and DIDN'T — so the server rows survived,
 * and the next registry pull dutifully materialized every one of them back as an
 * empty file. A user who selected twenty notes and deleted them watched twenty
 * empty notes reappear.
 *
 * Both callers now share this, so there is one place for the ordering rule to
 * live rather than two places for it to disagree.
 */

export interface DeletePathsDeps {
  /** Vault epoch to pin every call to, so a vault switch mid-loop can't land a
   *  delete in the wrong vault at the same relative path. */
  epoch: number | null | undefined;
  /** Remove the path from disk (recursively, for a folder). */
  deleteDisk(path: string, epoch: number | null | undefined): Promise<void>;
  /** Drop the server row(s) for the path. A no-op for unregistered paths. */
  unregister(path: string): Promise<void>;
  onProgress?(done: number, total: number): void;
}

export interface DeletePathsResult {
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Delete each path on the server and then locally.
 *
 * Deepest-first, so a folder's children are gone before the folder itself.
 *
 * SERVER FIRST, and that order is the whole point — it is the self-healing one:
 *
 *   • Server delete succeeds, disk delete fails (or the app dies in between):
 *     the row is tombstoned, so the next inbound pull trashes the local file.
 *     The delete still sticks.
 *   • Server delete FAILS (offline, or a 403 — no permission): nothing happened
 *     anywhere. The item stays visible and the failure is reported, instead of
 *     the old behaviour — disk deleted, server row alive — where the next pull
 *     resurrected the "deleted" item as an empty ghost and the user learned
 *     their delete silently hadn't counted.
 *
 * The old disk-first ordering predates inbound deletion; with tombstones on
 * both notes and folders, server-first is strictly safer.
 */
export async function deletePaths(
  paths: string[],
  deps: DeletePathsDeps,
): Promise<DeletePathsResult> {
  const ordered = [...paths].sort((a, b) => b.split("/").length - a.split("/").length);
  const result: DeletePathsResult = { deleted: [], failed: [] };
  let done = 0;
  for (const path of ordered) {
    try {
      await deps.unregister(path);
    } catch (e) {
      // The server refused (or is unreachable): the row is still live, so a
      // local delete would only produce the reappearing ghost. Leave the item
      // alone and say so.
      result.failed.push({ path, reason: e instanceof Error ? e.message : String(e) });
      deps.onProgress?.(++done, ordered.length);
      continue;
    }
    try {
      await deps.deleteDisk(path, deps.epoch);
    } catch (e) {
      // The server side is already done (tombstoned), so the next inbound pull
      // cleans this file up — recorded for honesty, not for retry.
      result.failed.push({ path, reason: e instanceof Error ? e.message : String(e) });
      deps.onProgress?.(++done, ordered.length);
      continue;
    }
    result.deleted.push(path);
    deps.onProgress?.(++done, ordered.length);
  }
  return result;
}
