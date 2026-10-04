// When does the OPEN note count as removed from disk?
//
// Not on the watcher's raw `removed`. A rename — in-app, in Finder, by an AI
// agent, or a folder move around the note — also reports the old path as
// `removed`, and setting the banner there flashed "was removed" until the move
// was paired (the in-app rename's server PATCH, or the disk-delete drain's
// 2.5 s grace window). So the question is asked again after the drain's grace
// window (plus {@link OPEN_NOTE_REMOVED_SLACK_MS}), and the banner shows only
// when the open note STILL sits on that path and the file is STILL missing — a
// rename that resolved, or a save that put the file back, shows nothing.
//
// Pure, with injected I/O, so it runs under vitest without the app.

/** Margin past `DISK_DELETE_GRACE_MS` so the drain has paired a rename (and
 *  re-pointed the open note) before this check reads the open path. */
export const OPEN_NOTE_REMOVED_SLACK_MS = 500;

export interface RemovedCheckDeps {
  delayMs: number;
  /** The open note's path at the time of the check (null when none is open). */
  currentPath: () => string | null;
  exists: (path: string) => Promise<boolean>;
  setRemoved: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** One timer per path: a burst of events for the same path checks once. */
const scheduled = new Set<string>();

export function scheduleOpenNoteRemovedCheck(path: string, deps: RemovedCheckDeps): void {
  if (scheduled.has(path)) return;
  scheduled.add(path);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  setTimer(() => {
    scheduled.delete(path);
    void runOpenNoteRemovedCheck(path, deps);
  }, deps.delayMs);
}

/** The check itself (exported for tests). Never assumes a delete it could not
 *  confirm: an `exists` that throws shows no banner. */
export async function runOpenNoteRemovedCheck(path: string, deps: RemovedCheckDeps): Promise<void> {
  if (deps.currentPath() !== path) return;
  let missing = false;
  try {
    missing = !(await deps.exists(path));
  } catch {
    missing = false;
  }
  if (!missing) return;
  if (deps.currentPath() !== path) return;
  deps.setRemoved();
}
