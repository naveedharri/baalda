/* "+12 −4 lines": how big a difference is, from a diff-match-patch LINE diff
   (each line hashed to one char, then diffed), so the count is whole lines. */
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from "diff-match-patch";

export interface LineChanges {
  added: number;
  removed: number;
}

function countLines(chunk: string): number {
  if (!chunk) return 0;
  // Each line char stands for one line; linesToChars keeps the trailing "\n".
  return chunk.length;
}

/** Lines only in `right` (added) and only in `left` (removed). */
export function lineChanges(left: string, right: string): LineChanges {
  if (left === right) return { added: 0, removed: 0 };
  const dmp = new diff_match_patch();
  const { chars1, chars2 } = dmp.diff_linesToChars_(left, right);
  const diffs = dmp.diff_main(chars1, chars2, false);
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffs) {
    if (op === DIFF_INSERT) added += countLines(text);
    else if (op === DIFF_DELETE) removed += countLines(text);
  }
  return { added, removed };
}

/** `+12 −4 lines`, `No differences` when equal. */
export function formatLineChanges({ added, removed }: LineChanges): string {
  if (added === 0 && removed === 0) return "No differences";
  return `+${added} −${removed} lines`;
}
