/**
 * Tables are atomic to the caret.
 *
 * The table widget never un-renders — clicking one opens a cell editor rather
 * than revealing `| a | b |` source — so a caret that walked INTO the table's
 * range would be a caret with nowhere to draw itself, and the next keystroke
 * would type into the middle of a pipe row. Every other block widget in
 * `livePreview.ts` reveals its source when the selection reaches it, which is
 * why this applies to tables only and lives here rather than over that whole
 * field.
 *
 * With the range atomic, ArrowRight/ArrowLeft step across the table in one
 * move, and vertical motion (which CM6 resolves from coordinates) lands on the
 * boundary rather than inside.
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSet, RangeValue, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

class Atom extends RangeValue {}
const ATOM = new Atom();

/** Every GFM table range in the document. */
function tableRanges(state: EditorState): RangeSet<Atom> {
  const ranges: Array<ReturnType<Atom["range"]>> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return undefined;
      if (node.to > node.from) ranges.push(ATOM.range(node.from, node.to));
      return false;
    },
  });
  return RangeSet.of(ranges, true);
}

const tableAtoms = StateField.define<RangeSet<Atom>>({
  create: tableRanges,
  update: (value, tr) => (tr.docChanged ? tableRanges(tr.state) : value),
});

export const tableAtomicRanges = [
  tableAtoms,
  EditorView.atomicRanges.of((view) => view.state.field(tableAtoms)),
];
