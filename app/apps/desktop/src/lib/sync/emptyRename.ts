// Pairing a renamed EMPTY note (a 0-byte placeholder) in the disk-delete drain.
//
// The drain pairs a vanished mapped path with an appearing unmapped one by
// content hash (`SyncManager.matchRename`). Every empty file hashes the same,
// so with several empties in one window the hash names no particular file and
// the first empty candidate won — or, with no hash to compare, nothing paired
// and the server saw delete + create (a teammate then got "deleted" for a note
// that was only renamed).
//
// An empty pair is taken only when it is UNIQUE: exactly one empty note went
// and exactly one empty candidate appeared in the window, and the two share a
// basename or a parent folder. Anything else returns null and the caller keeps
// its usual behaviour.

/** sha256 of zero bytes. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * The single empty candidate `from` was renamed to, or null.
 *
 * @param emptyGone how many vanished notes in this window have empty text.
 * @param candidates unmapped paths that appeared in the window and are still unpaired.
 * @param shaOf the indexed sha256 of a candidate (undefined/null when unknown).
 */
export function pickUniqueEmptyRename(
  from: string,
  emptyGone: number,
  candidates: Iterable<string>,
  shaOf: (path: string) => string | null | undefined,
): string | null {
  if (emptyGone !== 1) return null;
  let only: string | null = null;
  for (const c of candidates) {
    if (shaOf(c) !== EMPTY_SHA256) continue;
    if (only != null) return null; // two empty candidates: ambiguous
    only = c;
  }
  if (only == null) return null;
  if (parentOf(only) !== parentOf(from) && baseOf(only) !== baseOf(from)) return null;
  return only;
}
