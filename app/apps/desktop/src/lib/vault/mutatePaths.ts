/**
 * Deleting vault paths: on disk AND on the server, in that order, once.
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
 * Delete each path locally and then on the server.
 *
 * Deepest-first, so a folder's children are gone before the folder itself.
 *
 * The server call runs ONLY after the disk delete succeeded, and that order is
 * the whole point: unregistering without deleting leaves a live local file with a
 * dead mapping, while deleting without unregistering leaves a live server row
 * that comes back as an empty file on the next pull. Of the two, the second is
 * the one that actually shipped.
 *
 * A failed server call is recorded but does not undo the local delete — the file
 * is already gone, and the next reconcile is what reconciles it.
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
      await deps.deleteDisk(path, deps.epoch);
    } catch (e) {
      result.failed.push({ path, reason: e instanceof Error ? e.message : String(e) });
      deps.onProgress?.(++done, ordered.length);
      continue;
    }
    try {
      await deps.unregister(path);
    } catch (e) {
      // The local delete stands; the server row is retried by the next reconcile.
      console.warn("[vault] failed to unregister deleted path", path, e);
    }
    result.deleted.push(path);
    deps.onProgress?.(++done, ordered.length);
  }
  return result;
}
