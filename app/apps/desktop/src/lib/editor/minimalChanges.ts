// Minimal typed changes (#200).
//
// A typed character over a selection is ONE change: delete the selection,
// insert the character. In WebKit that change can come back far wider than
// what the user touched — select-all over a note whose frontmatter is folded
// into a `contenteditable=false` widget, then type `/`, and the DOM read-back
// reports `{0..len → <the frontmatter text> + "/"}`: the widget's covered text
// reads back as if the user had retyped it. The resulting DOCUMENT is right,
// but the CHANGE deletes the frontmatter and inserts an identical copy. Through
// yCollab that is a delete of every item in the range and an insert of new
// ones under this client id — so a peer's concurrent edit inside the
// frontmatter is orphaned, and history shows the whole note rewritten.
//
// This filter trims each change of a typing transaction to what actually
// differs: the common prefix and suffix of the deleted and inserted text are
// dropped from the change. The document it produces is byte-for-byte the same
// (the trimmed text was equal on both sides); only the change's shape shrinks.

import { ChangeSet, EditorState, Transaction, type ChangeSpec } from "@codemirror/state";

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Trim the equal head and tail off one replacement. Returns the offsets into
 * `deleted`/`inserted` that bound the part that really changes, never splitting
 * a surrogate pair.
 */
export function trimReplacement(
  deleted: string,
  inserted: string,
): { head: number; tail: number } {
  const max = Math.min(deleted.length, inserted.length);
  let head = 0;
  while (head < max && deleted.charCodeAt(head) === inserted.charCodeAt(head)) head++;
  if (head > 0 && isHigh(deleted.charCodeAt(head - 1))) head--;
  let tail = 0;
  const maxTail = max - head;
  while (
    tail < maxTail &&
    deleted.charCodeAt(deleted.length - 1 - tail) === inserted.charCodeAt(inserted.length - 1 - tail)
  ) {
    tail++;
  }
  if (tail > 0 && isLow(deleted.charCodeAt(deleted.length - tail))) tail--;
  return { head, tail };
}

/** Is this a keyboard typing transaction (not an IME composition, whose range
 *  CodeMirror tracks itself and must not be reshaped mid-flight)? */
function isTyping(tr: Transaction): boolean {
  return tr.isUserEvent("input.type") && !tr.isUserEvent("input.type.compose");
}

export const minimalInputChanges = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isTyping(tr)) return tr;
  const doc = tr.startState.doc;
  const specs: ChangeSpec[] = [];
  let trimmed = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    const deleted = doc.sliceString(fromA, toA);
    const inserted = text.toString();
    const { head, tail } = trimReplacement(deleted, inserted);
    if (head > 0 || tail > 0) trimmed = true;
    specs.push({
      from: fromA + head,
      to: toA - tail,
      insert: inserted.slice(head, inserted.length - tail),
    });
  });
  if (!trimmed) return tr;
  return {
    changes: ChangeSet.of(specs, doc.length),
    // Same resulting document, so the transaction's selection (expressed in
    // it) is still exactly right.
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
    annotations: [
      ...(tr.annotation(Transaction.addToHistory) === false
        ? [Transaction.addToHistory.of(false)]
        : []),
    ],
  };
});
