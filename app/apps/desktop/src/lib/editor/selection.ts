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
        // its box, inset to the prose column like the widget itself
        // (`cm-block-inset`). Measured per line it came out as a full-width
        // band from the scroller's edge, wider than anything on the page.
        const block = view.lineBlockAt(pos);
        if (block.type !== BlockType.Text) {
          const box = proseColumn(view);
          if (box) {
            out.push(
              new RectangleMarker(
                "cm-proseSelection",
                box.left,
                box.top + block.top,
                box.width,
                block.bottom - block.top,
              ),
            );
          }
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
    return u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged;
  },
});

/** The prose column in layer coordinates: the content box minus the
 *  `--editor-pad-x` inset every `.cm-line` carries. */
function proseColumn(view: EditorView): { left: number; top: number; width: number } | null {
  const line = view.contentDOM.querySelector(":scope > .cm-line");
  if (!line) return null;
  const content = view.contentDOM.getBoundingClientRect();
  const scroller = view.scrollDOM.getBoundingClientRect();
  const cs = getComputedStyle(line);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  return {
    left: content.left + padL - scroller.left + view.scrollDOM.scrollLeft,
    top: content.top - scroller.top + view.scrollDOM.scrollTop,
    width: Math.max(0, content.width - padL - padR),
  };
}
