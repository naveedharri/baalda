// diff-match-patch helpers for the bridge. We diff the CRDT's *current*
// serialization against the incoming file text and replay the result as
// Y.Text insert/delete ops, so concurrent edits merge as operations rather
// than being clobbered by a blind overwrite (spec 03 §5).

import { diff_match_patch, DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "diff-match-patch";
import type * as Y from "yjs";

export type Diff = [number, string];

/** Minimal char-level diff from `oldText` to `newText`. */
export function computeDiff(oldText: string, newText: string): Diff[] {
  const dmp = new diff_match_patch();
  return dmp.diff_main(oldText, newText) as Diff[];
}

/**
 * Fraction of content that churns in this diff, relative to the combined size
 * of both versions. ~1.0 for a whole-file rewrite, ~0 for a tiny edit.
 */
export function changeRatio(diffs: Diff[], oldLen: number, newLen: number): number {
  let changed = 0;
  for (const [op, data] of diffs) {
    if (op !== DIFF_EQUAL) changed += data.length;
  }
  const base = oldLen + newLen;
  return base === 0 ? 0 : changed / base;
}

/**
 * Apply a diff to a Y.Text as insert/delete ops. Indices are UTF-16 code units,
 * which is exactly how both diff-match-patch and Y.Text count, so unicode /
 * surrogate pairs round-trip faithfully. Must be called inside `doc.transact`.
 */
export function applyDiff(text: Y.Text, diffs: Diff[]): void {
  let index = 0;
  for (const [op, data] of diffs) {
    if (op === DIFF_EQUAL) {
      index += data.length;
    } else if (op === DIFF_DELETE) {
      text.delete(index, data.length);
    } else {
      // DIFF_INSERT
      text.insert(index, data);
      index += data.length;
    }
  }
}

/** Shortest pull insertion stripped from a disk hunk that merely CONTAINS it
 *  (an exact whole-hunk match is always stripped). Shorter fragments are too
 *  likely to be a coincidental part of a genuine external edit. */
const MIN_STRIPPED_PULL_INSERT = 8;

/**
 * Remove from a pre-pull → file diff the text the pull already delivered.
 *
 * `preToFile` is diffed against the doc as it was BEFORE the pull. When the
 * file already holds the server's newer text, every peer insertion shows up
 * here as an insert of its own, and applying it would type the peer's text a
 * second time under this device's client id. So:
 *  - `liveToFile` has no inserts ⇒ the file brings nothing the live doc lacks:
 *    keep only the deletions (deleting an item twice is harmless in a CRDT);
 *  - otherwise strip each pull insertion (`preToLive`'s inserts) out of the
 *    insert hunk that carries it, keeping the genuinely new bytes.
 * A diff with nothing of the pull in it is returned as it was.
 */
export function withoutPullInsertions(
  preToFile: Diff[],
  preToLive: Diff[],
  liveToFile: Diff[],
): Diff[] {
  if (!liveToFile.some(([op]) => op === DIFF_INSERT)) {
    return preToFile.filter(([op]) => op !== DIFF_INSERT);
  }
  const pulled = preToLive.filter(([op]) => op === DIFF_INSERT).map(([, t]) => t);
  if (pulled.length === 0) return preToFile;
  const out: Diff[] = [];
  for (const [op, data] of preToFile) {
    if (op !== DIFF_INSERT) {
      out.push([op, data]);
      continue;
    }
    let rest = data;
    for (let i = 0; i < pulled.length && rest.length > 0; i++) {
      const s = pulled[i];
      if (s.length === 0) continue;
      if (s !== rest && s.length < MIN_STRIPPED_PULL_INSERT) continue;
      const at = rest.indexOf(s);
      if (at < 0) continue;
      rest = rest.slice(0, at) + rest.slice(at + s.length);
      pulled[i] = ""; // each pull insertion is consumed once
    }
    if (rest.length > 0) out.push([DIFF_INSERT, rest]);
  }
  return out;
}
