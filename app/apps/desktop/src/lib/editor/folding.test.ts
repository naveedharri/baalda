// @vitest-environment jsdom
//
// Folding: which lines offer a chevron, what a fold hides, and whether a fold
// recorded yesterday still finds its heading today.
//
// The first test here is the one that had to be written first: a heading fold
// swallows every block under it, and one of those blocks can be a GFM table,
// which live preview replaces with an atomic block widget. Two block-level
// replacements over the same range is the shape CodeMirror throws a RangeError
// on, so it is checked through a real `EditorView` before anything else.

import { beforeAll, describe, expect, it } from "vitest";
import { foldedRanges, foldEffect } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions } from "./index";
import {
  chevronRange,
  foldAnchors,
  foldEffectsFor,
  parseNoteUiState,
  serializeFolds,
} from "./folding";

beforeAll(() => {
  // jsdom has no layout engine; CodeMirror needs a plausible answer to survive
  // its measure pass (same shim as livePreviewBlocks.test.ts).
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList;
});

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: baseExtensions({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
    }),
  });
}

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: makeState(doc), parent });
}

function lineOf(state: EditorState, n: number) {
  return state.doc.line(n);
}

describe("chevronRange", () => {
  it("offers a fold on a list item with children, but not on a leaf", () => {
    const state = makeState("- parent\n  - child\n  - other\n- leaf\n");
    expect(chevronRange(state, lineOf(state, 1))).not.toBeNull();
    expect(chevronRange(state, lineOf(state, 4))).toBeNull();
  });

  it("offers a fold on a heading and on a callout", () => {
    const headings = makeState("# Title\n\nbody text\n\nmore\n");
    expect(chevronRange(headings, lineOf(headings, 1))).not.toBeNull();

    const callout = makeState("> [!note] Heads up\n> the body\n> and more\n");
    const range = chevronRange(callout, lineOf(callout, 1));
    expect(range).not.toBeNull();
    // The title line survives the fold; only its body is hidden.
    expect(range!.from).toBe(lineOf(callout, 1).to);
  });

  it("offers no fold on a paragraph or on a table", () => {
    const prose = makeState("just a line\n\nand another\n");
    expect(chevronRange(prose, lineOf(prose, 1))).toBeNull();

    const table = makeState("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(chevronRange(table, lineOf(table, 1))).toBeNull();
    expect(chevronRange(table, lineOf(table, 2))).toBeNull();
  });
});

describe("folding in a live view", () => {
  it("folds a heading whose section contains a table without throwing", () => {
    const view = makeView("## Data\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Next\n");
    const line = view.state.doc.line(1);
    const range = chevronRange(view.state, line);
    expect(range).not.toBeNull();
    expect(() => view.dispatch({ effects: foldEffect.of(range!) })).not.toThrow();
    expect(foldAnchors(view.state)).toEqual([{ line: 1, text: "## Data" }]);
    // The fold placeholder is in the DOM and the table's text is not.
    expect(view.dom.querySelector(".cm-foldPlaceholder")).not.toBeNull();
    view.destroy();
  });

  it("hides the section's text when a heading is folded", () => {
    const view = makeView("# Title\n\nsecret body\n\n# Other\n");
    const range = chevronRange(view.state, view.state.doc.line(1))!;
    view.dispatch({ effects: foldEffect.of(range) });
    expect(view.dom.textContent).toContain("Title");
    expect(view.dom.textContent).not.toContain("secret body");
    view.destroy();
  });

  it("draws a chevron on foldable lines only", () => {
    const view = makeView("# Title\n\nplain paragraph\n");
    const chevrons = view.dom.querySelectorAll(".cm-foldChevron");
    expect(chevrons.length).toBe(1);
    view.destroy();
  });
});

describe("fold anchors", () => {
  it("round-trips through JSON and survives a line inserted above", () => {
    const before = makeState("# Alpha\n\nbody\n\n# Beta\n\ntail\n");
    const range = chevronRange(before, lineOf(before, 5))!;
    const folded = before.update({ effects: foldEffect.of(range) }).state;
    const json = serializeFolds(folded);
    expect(parseNoteUiState(json)).toEqual([{ line: 5, text: "# Beta" }]);

    // Someone (or an AI) adds two lines at the top while the note was closed.
    const after = makeState("intro\n\n# Alpha\n\nbody\n\n# Beta\n\ntail\n");
    const effects = foldEffectsFor(after, parseNoteUiState(json));
    expect(effects.length).toBe(1);
    const restored = after.update({ effects }).state;
    expect(foldAnchors(restored)).toEqual([{ line: 7, text: "# Beta" }]);
  });

  it("drops an anchor whose line was rewritten", () => {
    const json = JSON.stringify({ v: 1, folds: [{ line: 5, text: "# Beta" }] });
    const renamed = makeState("# Alpha\n\nbody\n\n# Gamma\n\ntail\n");
    expect(foldEffectsFor(renamed, parseNoteUiState(json))).toEqual([]);
  });

  it("drops an anchor whose line is no longer foldable", () => {
    const json = JSON.stringify({ v: 1, folds: [{ line: 1, text: "# Alpha" }] });
    // Nothing under the heading any more — foldable() says no.
    const emptied = makeState("# Alpha\n");
    expect(foldEffectsFor(emptied, parseNoteUiState(json))).toEqual([]);
  });

  it("treats junk stored state as no folds at all", () => {
    expect(parseNoteUiState(null)).toEqual([]);
    expect(parseNoteUiState("not json")).toEqual([]);
    expect(parseNoteUiState(JSON.stringify({ v: 2, folds: [] }))).toEqual([]);
    expect(parseNoteUiState(JSON.stringify({ v: 1, folds: "nope" }))).toEqual([]);
  });
});

describe("selection inside a fold", () => {
  it("keeps the caret out of the hidden range", () => {
    const view = makeView("# Title\n\nbody\n");
    const range = chevronRange(view.state, view.state.doc.line(1))!;
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      effects: foldEffect.of(range),
    });
    let folds = 0;
    foldedRanges(view.state).between(0, view.state.doc.length, () => {
      folds++;
    });
    expect(folds).toBe(1);
    view.destroy();
  });
});
