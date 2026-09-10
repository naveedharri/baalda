// The CodeMirror half of the active-note registry (see `activeView.ts`). Only
// the Editor — itself a lazy chunk — imports this, so CodeMirror stays out of
// the eager bundle.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ActiveNote } from "./activeView";

/** Wrap a live `EditorView` as the registry's `ActiveNote`. */
export function bindActiveNote(view: EditorView): ActiveNote {
  return {
    editable: () => !view.state.readOnly,
    insert: (md: string) => {
      if (view.state.readOnly) return false;
      const pos = view.state.selection.main.to;
      const atLineStart =
        pos === 0 || view.state.doc.sliceString(pos - 1, pos) === "\n";
      const insert = `${atLineStart ? "" : "\n"}${md}\n`;
      view.dispatch({
        changes: { from: pos, insert },
        selection: EditorSelection.cursor(pos + insert.length),
        userEvent: "input.drop",
      });
      view.focus();
      return true;
    },
  };
}
