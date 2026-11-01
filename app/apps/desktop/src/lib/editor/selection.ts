// Triple-click line selection, trimmed to the line's content.
//
// CodeMirror's default triple-click selects a whole line *including* its
// trailing newline, so the `drawSelection()` layer paints the highlight running
// to column 0 of the next line — a stray block that bleeds one line down
// (most visible on tall heading lines). We intercept the third click and select
// `line.from`→`line.to`, which stops just before the line break.

import { EditorSelection } from "@codemirror/state";
import { BlockType, EditorView, layer, RectangleMarker } from "@codemirror/view";

export const tripleClickLine = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail < 3) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    view.dispatch({
      selection: EditorSelection.range(line.from, line.to),
      userEvent: "select",
    });
    event.preventDefault();
    return true;
  },
});

// Selection that hugs the text, the way a browser paints it. drawSelection()
// paints one rectangle per range: every middle line ran to the right edge and
// the gaps between paragraphs filled in, so a selection read as a solid block.
// Here each line is painted only across its own text, and blank lines and the
// space between blocks stay clear. drawSelection() still draws the caret; its
// own wash is hidden in the theme.
export const proseSelection = layer({
  above: true,
  class: "cm-proseSelectionLayer",
  markers(view) {
    const out: RectangleMarker[] = [];
    const { from: vFrom, to: vTo } = view.viewport;
    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      const from = Math.max(r.from, vFrom);
      const to = Math.min(r.to, vTo);
      for (let pos = from; pos <= to; ) {
        // A block widget (a rendered table, a code well) gets ONE rect over
        // what it actually draws: the table's own box, not the column and not
        // the widget's spacing above it. While you type in one of its cells
        // the wash stays off: you are editing, not selecting.
        const block = view.lineBlockAt(pos);
        if (block.type !== BlockType.Text) {
          const rect = widgetBox(view, block.from);
          if (rect) out.push(rect);
          pos = block.to + 1;
          continue;
        }
        const line = view.state.doc.lineAt(pos);
        const a = Math.max(from, line.from);
        const b = Math.min(to, line.to);
        if (b > a) out.push(...RectangleMarker.forRange(view, "cm-proseSelection", EditorSelection.range(a, b)));
        pos = line.to + 1;
      }
    }
    return out;
  },
  update(u) {
    return u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged;
  },
});

/** The selection rect for the block widget starting at `from`, in layer
 *  coordinates, or null when it is being edited or not drawn. */
function widgetBox(view: EditorView, from: number): RectangleMarker | null {
  for (const child of Array.from(view.contentDOM.children)) {
    if (!(child instanceof HTMLElement) || child.classList.contains("cm-line")) continue;
    let at: number;
    try {
      at = view.posAtDOM(child, 0);
    } catch {
      continue;
    }
    if (at !== from) continue;
    if (child.contains(document.activeElement)) return null;
    const drawn = (child.querySelector("table") as HTMLElement | null) ?? child;
    const r = drawn.getBoundingClientRect();
    const clip = child.getBoundingClientRect();
    const left = Math.max(r.left, clip.left);
    const right = Math.min(r.right, clip.right);
    if (right <= left || r.height <= 0) return null;
    const scroller = view.scrollDOM.getBoundingClientRect();
    return new RectangleMarker(
      "cm-proseSelection",
      left - scroller.left + view.scrollDOM.scrollLeft,
      r.top - scroller.top + view.scrollDOM.scrollTop,
      right - left,
      r.height,
    );
  }
  return null;
}
