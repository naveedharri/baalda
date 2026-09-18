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

import { BULK_THRESHOLD_DOCS, IPC_CONCURRENCY, runPool } from "../sync/pool";

/**
 * How many local `deletePath` IPC calls run at once, WITHIN one depth level.
 *
 * Each unit is a Rust filesystem removal plus its index write, so it takes the
 * shared local width ({@link IPC_CONCURRENCY}): the cost of a wider pool is
 * measured in disk queue depth rather than in sockets. Never ACROSS levels —
 * see the ordering rule in {@link deletePaths}.
 */
export const DISK_DELETE_CONCURRENCY = IPC_CONCURRENCY;

/** What {@link DeletePathsDeps.unregisterMany} says about ONE path. */
export interface UnregisterOutcome {
  path: string;
  /** The server row is gone (or was never there). `false` ⇒ nothing may happen
   *  to this path on disk, exactly as a thrown `unregister` means. */
  ok: boolean;
  reason: string | null;
}

export interface DeletePathsDeps {
  /** Vault epoch to pin every call to, so a vault switch mid-loop can't land a
   *  delete in the wrong vault at the same relative path. */
  epoch: number | null | undefined;
  /** Remove the path from disk (recursively, for a folder). */
  deleteDisk(path: string, epoch: number | null | undefined): Promise<void>;
  /** Drop the server row(s) for the path. A no-op for unregistered paths. */
  unregister(path: string): Promise<void>;
  /**
   * The BATCHED twin of {@link unregister}: the same drop, for many paths, in
   * one round trip per chunk (`registry.deletePaths`).
   *
   * Optional, and only taken above {@link BULK_THRESHOLD_DOCS} — a caller that
   * omits it keeps the per-path loop, and a small selection keeps it too. It
   * answers PER PATH rather than throwing, because a batch has N verdicts: the
   * server-first rule is applied to each one separately, so a note the server
   * refused keeps its file while its neighbours lose theirs.
   *
   * Folders need no special handling here — `registry.deletePaths` leaves a
   * folder on its single cascading request and batches only the notes.
   */
  unregisterMany?(paths: string[]): Promise<UnregisterOutcome[]>;
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
 *
 * A selection of {@link BULK_THRESHOLD_DOCS} paths or more takes the batched
 * route when the caller supplied one ({@link DeletePathsDeps.unregisterMany}):
 * ONE request per 200 notes instead of one per note, then the disk removals
 * pooled WITHIN each depth level and strictly deepest-level-first between them
 * (two paths with the same number of segments can never contain one another, so
 * pooling inside a level is safe; pooling across one would race a folder's
 * recursive removal against its own children). Every rule above is unchanged:
 * server first, per path, and a refusal leaves that file exactly where it is.
 */
export async function deletePaths(
  paths: string[],
  deps: DeletePathsDeps,
): Promise<DeletePathsResult> {
  const ordered = [...paths].sort((a, b) => b.split("/").length - a.split("/").length);
  if (deps.unregisterMany && ordered.length >= BULK_THRESHOLD_DOCS) {
    return deleteManyPaths(ordered, deps);
  }
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

/**
 * The batched half of {@link deletePaths}: one server call for the whole
 * selection, then the disk.
 *
 * Split out rather than folded in, because the two halves differ in EXACTLY one
 * thing — where the server verdicts come from — and a single function with a
 * flag through it is how the two sidebar deletes drifted apart in the first
 * place.
 */
async function deleteManyPaths(
  ordered: string[],
  deps: DeletePathsDeps,
): Promise<DeletePathsResult> {
  const result: DeletePathsResult = { deleted: [], failed: [] };
  let done = 0;
  const step = () => deps.onProgress?.(++done, ordered.length);

  let outcomes: UnregisterOutcome[];
  try {
    outcomes = await deps.unregisterMany!(ordered);
  } catch (e) {
    // The batch itself failed, so NO path got a verdict — and with the server
    // rows still live, a local delete would only produce the reappearing ghost.
    for (const path of ordered) {
      result.failed.push({ path, reason: reasonOf(e) });
      step();
    }
    return result;
  }

  const byPath = new Map(outcomes.map((o) => [o.path, o]));
  const cleared: string[] = [];
  for (const path of ordered) {
    const out = byPath.get(path);
    if (!out) {
      // An unanswered path is a refusal, never an assumption: the same reading
      // an unanswered id gets everywhere else in the sync layer.
      result.failed.push({ path, reason: "the server did not answer for this path" });
      step();
      continue;
    }
    if (!out.ok) {
      result.failed.push({ path, reason: out.reason ?? "the server refused this delete" });
      step();
      continue;
    }
    cleared.push(path);
  }

  // Disk, deepest LEVEL first; pooled within a level only.
  for (const level of byDepthDeepestFirst(cleared)) {
    await runPool(
      level,
      async (path) => {
        try {
          await deps.deleteDisk(path, deps.epoch);
        } catch (e) {
          // The server side is already tombstoned, so the next inbound pull
          // cleans this file up — recorded for honesty, not for retry.
          result.failed.push({ path, reason: reasonOf(e) });
          step();
          return;
        }
        result.deleted.push(path);
        step();
      },
      { concurrency: DISK_DELETE_CONCURRENCY },
    );
  }
  return result;
}

/** `paths` grouped by segment count, deepest group first. */
function byDepthDeepestFirst(paths: string[]): string[][] {
  const levels = new Map<number, string[]>();
  for (const path of paths) {
    const depth = path.split("/").length;
    const at = levels.get(depth);
    if (at) at.push(path);
    else levels.set(depth, [path]);
  }
  return [...levels.entries()].sort((a, b) => b[0] - a[0]).map(([, group]) => group);
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
