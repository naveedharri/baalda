// Folding — collapse a heading's section, a list item's children, a callout or
// a code fence, and have it still be folded the next time you open the note.
//
// **What we did NOT write.** `@codemirror/lang-markdown` already folds
// everything we want: `headerIndent` (a `foldService`) folds a heading down to
// the next heading of the same or higher level, and its `foldNodeProp` gives
// every other block — `ListItem`, `Blockquote` (which is what a callout is),
// `FencedCode` — the range "end of my first line → end of me". The plan for
// this stage called for hand-written `listItemFold` and `calloutFold` services;
// a probe against the real parser showed both ranges already come out correct,
// so the services would have been a second authority saying the same thing. All
// this file adds is `codeFolding()` (the placeholder pill), the chevron affordance
// and the persistence.
//
// **Which lines get a chevron** is ours to decide, and is NOT simply "wherever
// `foldable()` answers". lang-markdown's blanket `foldNodeProp` also makes a
// hard-wrapped paragraph and a GFM table foldable, and neither should sprout a
// control: a table is drawn by a block replace widget (`editor/table/`) whose
// range is atomic, and folding a paragraph is meaningless. `foldOwner` walks out
// from the line to the nearest block that IS worth a chevron and refuses the
// rest.
//
// **Persistence is by line anchor, never by offset.** A fold recorded as
// `{line: 12, text: "## Design notes"}` survives a teammate inserting a
// paragraph above it (we scan ±8 lines for the same text) and is DROPPED when
// that heading is rewritten — which is the right failure: reopening a note with
// a section folded shut that no longer says what you folded is worse than
// reopening it open. Offsets would survive neither.

import { syntaxTree } from "@codemirror/language";
import {
  codeFolding,
  foldable,
  foldedRanges,
  foldEffect,
  unfoldEffect,
} from "@codemirror/language";
import type { EditorState, Extension, Line, StateEffect } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

// ---- Which blocks own a fold ----------------------------------------------

/**
 * The block a chevron on this line would fold, or null for a line that should
 * not offer one. Walks OUT from the line's last character, stopping as soon as
 * it leaves the line, so the innermost enclosing block wins (a list item inside
 * a callout folds as a list item).
 */
function foldOwner(state: EditorState, line: Line): string | null {
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.to, -1);
  for (; n; n = n.parent) {
    if (n.from < line.from) break;
    const name = n.name;
    if (name === "Table") return null; // an atomic block widget owns these lines
    if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) return "heading";
    if (name === "ListItem") return "list";
    if (name === "Blockquote") return "quote";
    if (name === "FencedCode" || name === "CodeBlock") return "code";
  }
  return null;
}

/** The range a chevron on this line folds, or null if it should not show one. */
export function chevronRange(
  state: EditorState,
  line: Line,
): { from: number; to: number } | null {
  if (!foldOwner(state, line)) return null;
  return foldable(state, line.from, line.to);
}

/** Is this line's fold currently closed? */
function isFolded(state: EditorState, line: Line): boolean {
  let folded = false;
  foldedRanges(state).between(line.from, line.to, (from) => {
    if (from >= line.from && from <= line.to) folded = true;
  });
  return folded;
}

/** True when `pos` sits inside a collapsed range (and so has no coordinates). */
export function insideFold(state: EditorState, pos: number): boolean {
  let hidden = false;
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from < pos && pos < to) hidden = true;
  });
  return hidden;
}

// ---- The placeholder pill --------------------------------------------------

function placeholderDOM(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-foldPlaceholder";
  el.textContent = "…";
  el.title = "Click to unfold";
  el.setAttribute("aria-label", "Folded — click to unfold");
  // CodeMirror's own handler: it knows which range this placeholder stands for.
  el.addEventListener("click", onclick);
  return el;
}

// ---- The chevron -----------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A disclosure triangle in the margin. Plan A of the two the stage plan
 * weighed: an absolutely-positioned widget pulled left out of the line, NOT a
 * `foldGutter()`. A gutter would take real width from `.cm-content`, so the
 * prose column would shift sideways the first time a note grew a foldable
 * heading — and back again when it lost one.
 */
class ChevronWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(other: ChevronWidget) {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-foldChevron";
    el.dataset.folded = String(this.folded);
    el.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS(SVG_NS, "path");
    // Pointing down when open, right when folded — the universal direction.
    path.setAttribute("d", this.folded ? "M9 5l7 7-7 7" : "M5 9l7 7 7-7");
    svg.appendChild(path);
    el.appendChild(svg);
    el.addEventListener("mousedown", (e) => {
      // Never move the caret or steal focus: this is a control, not text.
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(el));
      const folded = isFolded(view.state, line);
      if (folded) {
        const effects: StateEffect<unknown>[] = [];
        foldedRanges(view.state).between(line.from, line.to, (from, to) => {
          if (from >= line.from && from <= line.to) effects.push(unfoldEffect.of({ from, to }));
        });
        if (effects.length) view.dispatch({ effects });
        return;
      }
      const range = chevronRange(view.state, line);
      if (range) view.dispatch({ effects: foldEffect.of(range) });
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function buildChevrons(view: EditorView): DecorationSet {
  const decos = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.length > 0 && chevronRange(state, line)) {
        decos.push(
          Decoration.widget({
            widget: new ChevronWidget(isFolded(state, line)),
            side: -1,
          }).range(line.from),
        );
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}

const foldChevrons = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChevrons(view);
    }
    update(u: ViewUpdate) {
      // Fold/unfold arrives as a state effect, not as a doc change.
      const foldChanged = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
      );
      if (u.docChanged || u.viewportChanged || foldChanged) {
        this.decorations = buildChevrons(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- Persistence -----------------------------------------------------------

/** Longest prefix of a line we store to recognise it again. */
const ANCHOR_CHARS = 80;
/** How far from the remembered line number to look for the same text. */
const ANCHOR_SCAN = 8;
/**
 * How long after a fold/unfold the state is written. Deliberately far clear of
 * the bridge's 150 ms ingest / 300 ms egest debounces (see CLAUDE.md): this
 * writes to `index.sqlite`, never to the `.md`, and the two must not contend.
 */
export const FOLD_SAVE_DEBOUNCE_MS = 500;

export interface FoldAnchor {
  /** 1-based line number the fold started on, as of the save. */
  line: number;
  /** That line's text, trimmed and capped — the part that must still match. */
  text: string;
}

export interface NoteUiState {
  v: 1;
  folds: FoldAnchor[];
}

function anchorText(text: string): string {
  return text.trim().slice(0, ANCHOR_CHARS);
}

/** The current fold set, as line anchors. */
export function foldAnchors(state: EditorState): FoldAnchor[] {
  const out: FoldAnchor[] = [];
  const seen = new Set<number>();
  const iter = foldedRanges(state).iter();
  for (; iter.value; iter.next()) {
    const line = state.doc.lineAt(iter.from);
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    out.push({ line: line.number, text: anchorText(line.text) });
  }
  return out;
}

/** Serialise the fold set for `ipc.setNoteUiState`. */
export function serializeFolds(state: EditorState): string {
  const value: NoteUiState = { v: 1, folds: foldAnchors(state) };
  return JSON.stringify(value);
}

/** Parse what `ipc.getNoteUiState` returned, tolerating anything at all. */
export function parseNoteUiState(raw: string | null | undefined): FoldAnchor[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<NoteUiState>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.folds)) return [];
    return parsed.folds.filter(
      (f): f is FoldAnchor =>
        !!f && typeof f.line === "number" && typeof f.text === "string",
    );
  } catch {
    return [];
  }
}

/** Find the line an anchor now refers to, or null if it has gone. */
function resolveAnchor(state: EditorState, anchor: FoldAnchor): Line | null {
  const total = state.doc.lines;
  const matches = (n: number) =>
    n >= 1 && n <= total && anchorText(state.doc.line(n).text) === anchor.text;
  if (matches(anchor.line)) return state.doc.line(anchor.line);
  // The note moved on while we were away: look for the same line nearby, which
  // covers the ordinary case of text being added or removed above it.
  for (let d = 1; d <= ANCHOR_SCAN; d++) {
    if (matches(anchor.line - d)) return state.doc.line(anchor.line - d);
    if (matches(anchor.line + d)) return state.doc.line(anchor.line + d);
  }
  return null;
}

/**
 * Turn stored anchors into fold effects against the CURRENT document. An anchor
 * whose text is gone, or whose line is no longer foldable, is silently dropped.
 */
export function foldEffectsFor(
  state: EditorState,
  anchors: readonly FoldAnchor[],
): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const anchor of anchors) {
    const line = resolveAnchor(state, anchor);
    if (!line) continue;
    const range = foldable(state, line.from, line.to);
    if (range) effects.push(foldEffect.of(range));
  }
  return effects;
}

/**
 * Save the fold set whenever it changes, debounced. Nothing is written until a
 * fold actually moves, so merely opening a note touches no rows.
 */
export function persistFolds(save: (json: string) => void): Extension {
  return EditorView.updateListener.of((() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (u: ViewUpdate) => {
      const changed = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
      );
      if (!changed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save(serializeFolds(u.view.state));
      }, FOLD_SAVE_DEBOUNCE_MS);
    };
  })());
}

// ---- The extension ---------------------------------------------------------

/** Folding, ready to drop into the editor's extension list. */
export const folding: Extension[] = [codeFolding({ placeholderDOM }), foldChevrons];
