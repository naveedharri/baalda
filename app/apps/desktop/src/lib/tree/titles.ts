// Pure helper for keeping `store.titles` (the local index's id/path/title rows)
// current without re-reading all of them.
//
// `refreshTitles` marshals EVERY note over IPC (5.9k rows on a large vault) and
// used to run on every watcher batch — i.e. on every egest a sync run performs.
// During a bulk sync that was one full-vault round trip every ~150ms, and every
// one replaced the array, which re-derived the whole sidebar roll-up. A watcher
// batch names the files that changed, so the rows can be patched instead.

import type { NoteTitle } from "../ipc";

/** Byte-wise title order, as SQLite's default `ORDER BY title` collation. */
function byTitle(a: NoteTitle, b: NoteTitle): number {
  return a.title < b.title ? -1 : a.title > b.title ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Apply fresh rows for changed notes and drop removed paths, keeping the array
 * sorted the way the index lists it. Returns the SAME array when nothing changed
 * so callers can skip a store write.
 */
export function applyTitlePatch(
  titles: NoteTitle[],
  updates: NoteTitle[],
  removedPaths: Iterable<string>,
): NoteTitle[] {
  const removed = new Set(removedPaths);
  const fresh = new Map(updates.map((t) => [t.path, t] as const));
  let changed = false;
  const next: NoteTitle[] = [];
  for (const t of titles) {
    if (removed.has(t.path)) {
      changed = true;
      continue;
    }
    const f = fresh.get(t.path);
    if (f) {
      fresh.delete(t.path);
      if (f.id !== t.id || f.title !== t.title) changed = true;
      next.push(f);
    } else {
      next.push(t);
    }
  }
  for (const f of fresh.values()) {
    if (removed.has(f.path)) continue;
    next.push(f); // a note the index has that we didn't list yet
    changed = true;
  }
  if (!changed) return titles;
  return next.sort(byTitle);
}
