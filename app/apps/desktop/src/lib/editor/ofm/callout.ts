// Callouts — `> [!note] Title` and friends.
//
// A DECORATION LAYER, not a parser. A callout IS a blockquote in every markdown
// reader on earth; only the first line's `[!type]` marks it. Teaching the parser
// about it would fork the tree for something that is purely a look, and would
// put a second authority next to blocks.ts's `cm-blockquote`. So: find
// `Blockquote` nodes, read their first line, and paint.
//
// Off the active line the `[!type][+-] ` marker is replaced by an icon widget;
// the `>` itself is hidden by livePreview's QuoteMark rule, which is why this
// replace starts at the `[` and not at the line start — two overlapping replace
// decorations over the same characters is a shape CodeMirror should never be
// handed.
//
// The icon is built with `createElementNS`, never `innerHTML`: the type comes
// out of the note, and a note is untrusted text.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { activeLineChecker, focusMoved } from "../reveal";

/** `> [!type]` + an optional fold marker + an optional title. */
export const CALLOUT_RE = /^\s*>\s*\[!([\w-]+)\]([+-]?)\s*(.*)$/;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The 14 Obsidian callout families, folded onto the four semantic tokens we
 * already have. An unknown type falls back to `note`, so a typo reads as a
 * plain callout instead of an unstyled one.
 */
const FAMILY: Record<string, string> = {
  note: "note",
  info: "note",
  abstract: "note",
  summary: "note",
  tldr: "note",
  todo: "note",
  example: "note",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  question: "warning",
  help: "warning",
  faq: "warning",
  danger: "danger",
  error: "danger",
  bug: "danger",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  quote: "quote",
  cite: "quote",
};

/** One line of SVG path data per family — drawn, not fetched. */
const ICON: Record<string, string> = {
  // An "i" in a circle.
  note: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 5v1m0 3v5",
  // A flame-ish lightbulb.
  tip: "M9 18h6m-5 3h4M12 3a6 6 0 00-3 11v2h6v-2a6 6 0 00-3-11z",
  // A triangle with a bang.
  warning: "M12 4L2 20h20L12 4zm0 6v5m0 3v.5",
  // An octagon with a bang.
  danger: "M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5zm4 5v6m0 3v.5",
  // A quote mark.
  quote: "M7 15c-2 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3c0 3-2 5-4 6m10-3c-2 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3c0 3-2 5-4 6",
};

function familyOf(type: string): string {
  return FAMILY[type.toLowerCase()] ?? "note";
}

/** Sentence-case the raw type for the default title (`tip` → `Tip`). */
function labelOf(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

class CalloutIconWidget extends WidgetType {
  constructor(readonly type: string, readonly label: string) {
    super();
  }
  eq(other: CalloutIconWidget) {
    return other.type === this.type && other.label === this.label;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-callout-icon";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON[familyOf(this.type)] ?? ICON.note);
    svg.appendChild(path);
    wrap.appendChild(svg);
    if (this.label) {
      // Only when the author wrote no title of their own — otherwise their
      // title is right there in the document text, unreplaced.
      const name = document.createElement("span");
      name.className = "cm-callout-label";
      name.textContent = this.label;
      wrap.appendChild(name);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function buildCallouts(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const isActive = activeLineChecker(state);
  const decos: Range<Decoration>[] = [];
  const seen = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return;
        const first = doc.lineAt(node.from);
        // A blockquote inside a blockquote reaches this twice; the outer one
        // owns the marker line.
        if (seen.has(first.from)) return;
        const m = CALLOUT_RE.exec(first.text);
        if (!m) return;
        seen.add(first.from);

        const type = m[1].toLowerCase();
        const lineDeco = Decoration.line({
          class: "cm-callout",
          attributes: { "data-callout": familyOf(type) },
        });
        const titleDeco = Decoration.line({
          class: "cm-callout cm-callout-title",
          attributes: { "data-callout": familyOf(type) },
        });
        const lastLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let n = first.number; n <= lastLine; n++) {
          const line = doc.line(n);
          decos.push((n === first.number ? titleDeco : lineDeco).range(line.from));
        }

        if (isActive(first.from, first.to)) return;
        // Replace `[!type][+-] ` — from the `[` to the start of the title —
        // with the icon. The `>` before it is livePreview's to hide.
        const markerFrom = first.from + first.text.indexOf("[!");
        const title = m[3].trim();
        const markerTo = title
          ? first.from + first.text.length - title.length
          : first.to;
        decos.push(
          Decoration.replace({
            widget: new CalloutIconWidget(type, title ? "" : labelOf(m[1])),
          }).range(markerFrom, markerTo),
        );
      },
    });
  }
  return Decoration.set(decos, true);
}

/** Is this line the first line of a callout? Exported for tests. */
export function calloutTypeAt(state: EditorState, pos: number): string | null {
  const m = CALLOUT_RE.exec(state.doc.lineAt(pos).text);
  return m ? familyOf(m[1]) : null;
}

export const callouts = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildCallouts(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || focusMoved(u)) {
        this.decorations = buildCallouts(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
