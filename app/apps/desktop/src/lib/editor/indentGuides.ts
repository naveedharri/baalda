// Indentation guides — the faint vertical rules that show which level of a
// nested list a line belongs to.
//
// **Why this is hand-written.** The stage plan budgeted one dependency,
// `@replit/codemirror-indentation-markers`, gated on a spike. It failed the
// spike on three counts, two of them unfixable from outside the package:
//
//   1. Its gradients step in `ch` units. `ch` is the advance of "0", and our
//      editor is set in a PROPORTIONAL font (`--font-body`), where a space is
//      roughly half that — so every guide landed about twice as far right as
//      the indent it was meant to mark, i.e. inside the text. The step is baked
//      into JS-generated `background-position`/`background-size`, so no
//      stylesheet of ours could move it.
//   2. Its pseudo-element is pinned at `left: 2px` from the line's padding box,
//      which is blind to our `--editor-pad-x` prose inset (64 px and up).
//      Overridable, but only by rewriting its whole rule.
//   3. It draws at `z-index: -1`, which puts guides *behind* any line that has
//      its own background — our code-fence well and callout tint — so they
//      vanish exactly where an indent is deepest.
//
// So: no dependency, and the step is MEASURED instead of assumed. A probe span
// of real spaces is laid out once per geometry change and its width published as
// `--indent-guide-step` on the scroller, which means the guides track the font
// the moment a webfont finishes loading and stay right at any zoom.
//
// The guide itself is a `::before` on the line, inset by `--editor-pad-x` and
// filled with a repeating gradient one step wide — so a line's guides cost one
// custom property, and a wrapped line's guides run the full height of every row
// it occupies (the pseudo-element stretches `top: 0; bottom: 0`).

import { indentUnit } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Deepest level we draw. Past this a line is not nested, it is broken. */
const MAX_DEPTH = 12;
/** How many spaces the probe lays out. More characters, less rounding error. */
const PROBE_SPACES = 20;

/** Indent depth of a line: how many whole indent units its leading run holds. */
export function indentDepth(text: string, unitWidth: number, tabSize: number): number {
  let columns = 0;
  for (const ch of text) {
    if (ch === " ") columns += 1;
    else if (ch === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return Math.min(MAX_DEPTH, Math.floor(columns / unitWidth));
}

/**
 * Measures one indent unit's rendered width and publishes it as
 * `--indent-guide-step` on the scroller.
 *
 * The probe lives in `.cm-scroller`, NOT in `.cm-content`: CodeMirror's
 * DOMObserver watches the content element's subtree and would treat a foreign
 * node there as an edit to the document.
 */
const indentStepProbe = ViewPlugin.fromClass(
  class {
    view: EditorView;
    probe: HTMLSpanElement;
    last: number;
    unit: string;

    constructor(view: EditorView) {
      this.view = view;
      this.last = 0;
      this.unit = "";
      const probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText =
        "position:absolute;top:0;left:-9999px;white-space:pre;visibility:hidden;pointer-events:none";
      probe.textContent = " ".repeat(PROBE_SPACES);
      view.scrollDOM.appendChild(probe);
      this.probe = probe;
      this.measure();
    }

    update(u: ViewUpdate) {
      // Geometry changes cover a font swap, a zoom and a window resize; the
      // indent unit itself can only change with a reconfigure.
      if (u.geometryChanged || u.view.state.facet(indentUnit) !== this.unit) this.measure();
    }

    measure() {
      this.unit = this.view.state.facet(indentUnit);
      const unitWidth = Math.max(1, this.unit.length);
      this.view.requestMeasure({
        read: () => this.probe.getBoundingClientRect().width / PROBE_SPACES,
        write: (spaceWidth) => {
          // jsdom (and a detached editor) measures zero — leave the last good
          // value rather than collapsing every guide onto the same pixel.
          if (!(spaceWidth > 0)) return;
          const step = spaceWidth * unitWidth;
          if (Math.abs(step - this.last) < 0.01) return;
          this.last = step;
          this.view.scrollDOM.style.setProperty("--indent-guide-step", `${step}px`);
        },
      });
    }

    destroy() {
      this.probe.remove();
    }
  },
);

function buildGuides(view: EditorView): DecorationSet {
  const decos = [];
  const { state } = view;
  const unitWidth = Math.max(1, state.facet(indentUnit).length);
  const tabSize = state.tabSize;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const depth = indentDepth(line.text, unitWidth, tabSize);
      if (depth > 0) {
        decos.push(
          Decoration.line({
            class: "cm-indent-guides",
            attributes: { style: `--indent-depth:${depth}` },
          }).range(line.from),
        );
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}

const indentGuidePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildGuides(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildGuides(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const indentGuides: Extension[] = [indentStepProbe, indentGuidePlugin];
