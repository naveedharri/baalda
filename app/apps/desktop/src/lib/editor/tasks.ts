// Clickable task checkboxes. Off the active line a `- [ ]` / `- [x]` task item
// renders its `[ ]` marker as a real checkbox you can click to toggle; put the
// caret on the line and the raw `- [ ]` returns for editing (same rule as the
// rest of live preview). The dash itself is hidden by livePreview on task lines
// so the item reads as "☐ text", not "• ☐ text". Toggling is a one-character
// transaction (space ↔ x), keeping the markdown + Yjs doc the source of truth.

import { RangeSetBuilder } from "@codemirror/state";
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { focusMoved, isFocused } from "./reveal";

// A task marker: indent, a bullet, then `[ ]`/`[x]`. Group 1 is the box.
export const TASK_RE = /^\s*[-*+]\s+(\[[ xX]\])\s/;

// A bullet item with no task box yet: indent, bullet, whitespace.
const BULLET_RE = /^(\s*)([-*+])(\s+)/;

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't move the caret / steal focus
      if (view.state.readOnly) return;
      // The char inside the brackets sits one past `[`, i.e. pos + 1.
      const at = this.pos + 1;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle-task",
      });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  // Same LINE rule as livePreview's task-dash hiding, focus and all: a blurred
  // editor has no active line, so every checkbox renders (see ./reveal.ts).
  const active = new Set<number>();
  if (isFocused(view.state)) {
    for (const r of selection.ranges) {
      for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) {
        active.add(n);
      }
    }
  }
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const m = TASK_RE.exec(line.text);
      if (m && !active.has(line.number)) {
        const boxFrom = line.from + line.text.indexOf(m[1]);
        const boxTo = boxFrom + m[1].length;
        const checked = /[xX]/.test(m[1]);
        builder.add(
          boxFrom,
          boxTo,
          Decoration.replace({ widget: new CheckboxWidget(checked, boxFrom) })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/**
 * ⌘L — "make this a task, or tick it off".
 *
 * One chord, three cases, so the key does the obvious thing wherever the caret
 * happens to be:
 *
 *   `- [ ] a` / `- [x] a` → flip the box
 *   `- a`                 → gains a box: `- [ ] a`
 *   `a`                   → becomes an item: `- [ ] a` (after any indent)
 *
 * Every line the selection touches changes in ONE transaction, so ⌘Z takes the
 * whole gesture back and the Yjs binding ships it as a single update.
 */
export const toggleTaskAtCursor: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const seen = new Set<number>();
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const task = TASK_RE.exec(line.text);
      if (task) {
        // The state char sits one past the box's `[`.
        const at = line.from + line.text.indexOf(task[1]) + 1;
        changes.push({ from: at, to: at + 1, insert: /[xX]/.test(task[1]) ? " " : "x" });
        continue;
      }
      const bullet = BULLET_RE.exec(line.text);
      if (bullet) {
        const at = line.from + bullet[0].length;
        changes.push({ from: at, to: at, insert: "[ ] " });
        continue;
      }
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      const at = line.from + indent;
      changes.push({ from: at, to: at, insert: "- [ ] " });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.toggle-task" });
  return true;
};

export function taskKeymap() {
  return keymap.of([{ key: "Mod-l", run: toggleTaskAtCursor, preventDefault: true }]);
}

export const checkboxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || focusMoved(u)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
