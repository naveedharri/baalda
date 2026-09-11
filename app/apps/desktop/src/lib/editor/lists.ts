// Tab / Shift-Tab indenting for lists and quotes.
//
//   Tab / Shift-Tab on a list line → indent / outdent the item by one unit.
//   Tab anywhere else              → insert a soft indent (never moves focus).
//
// Enter deliberately does NOT live here. `@codemirror/lang-markdown` registers
// `insertNewlineContinueMarkup` at `Prec.high`, so it runs before any keymap we
// add and already does the whole job — continuing bullets, quotes and task
// items, renumbering ordered lists, and clearing an empty item to end the list
// (and `deleteMarkupBackward` mirrors it on Backspace). We used to ship a
// `listEnter` command that duplicated a worse version of that; it could never
// run, so it is gone. `commands.test.ts` asserts the behaviour through a real
// view, so the day that keymap changes we find out from a test rather than from
// a bug report.
//
// The indent unit is read from the `indentUnit` facet (set to two spaces in
// `lib/editor/index.ts`), so there is one answer to "how wide is an indent" for
// this file, `indentOnInput` and every CodeMirror command.

import { indentUnit } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/**
 * A list or quote item: optional indent, then a bullet (`-`/`*`/`+`), an
 * ordered marker (`1.`/`1)`) or a blockquote `>`, then whitespace. Only the
 * question "is the caret on one of these?" is asked of it — continuing the item
 * is lang-markdown's job (see the header comment).
 */
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)]|>)\s/;

export function isItemLine(lineText: string): boolean {
  return ITEM_RE.test(lineText);
}

function unitOf(state: EditorState): string {
  return state.facet(indentUnit);
}

/** Shift the indent of every line the selection touches by ±one unit. */
function reindent(view: EditorView, outdent: boolean): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const unit = unitOf(state);
  const changes = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (outdent) {
        // One tab, or up to one unit's worth of spaces — whichever the line
        // actually starts with.
        const strip = new RegExp(`^(?:\\t| {1,${unit.length}})`).exec(line.text)?.[0].length ?? 0;
        if (strip) changes.push({ from: line.from, to: line.from + strip });
      } else {
        changes.push({ from: line.from, insert: unit });
      }
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.indent" });
  return true;
}

/** Tab on a list line indents the item; elsewhere inserts a soft indent. */
const listTab: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const range = state.selection.main;
  const onList = isItemLine(state.doc.lineAt(range.head).text);
  if (onList || !range.empty) return reindent(view, false);
  // Plain line, collapsed caret → insert a soft indent.
  view.dispatch(state.replaceSelection(unitOf(state)), { userEvent: "input" });
  return true;
};

const listShiftTab: Command = (view) => reindent(view, true);

export function listKeymap() {
  return keymap.of([
    { key: "Tab", run: listTab, preventDefault: true },
    { key: "Shift-Tab", run: listShiftTab, preventDefault: true },
  ]);
}
