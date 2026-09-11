// @vitest-environment jsdom
//
// The editing keys, driven through a REAL `EditorView` with the real extension
// stack. That matters more here than anywhere else in the editor: half of what
// this file asserts is behaviour we deliberately did NOT write — Enter
// continuing a list, Backspace eating a marker, ordered items renumbering — and
// the only way to know `@codemirror/lang-markdown` is still doing it for us is
// to press the key and read the document back. When lang-markdown changes, this
// file is how we find out.

import { beforeAll, describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorState } from "./index";

beforeAll(() => {
  // jsdom has no layout engine, and CodeMirror's measure pass (which runs in a
  // rAF after every dispatch) calls Range#getClientRects. Without these it
  // throws asynchronously and vitest reports an unhandled error.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

/** How CodeMirror resolves `Mod-` on the platform the test happens to run on. */
const MOD_IS_META = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function mount(doc: string, at?: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
    } as never),
    parent,
  });
  if (at != null) view.dispatch({ selection: EditorSelection.cursor(at) });
  return view;
}

/** Send a key through the view's real keydown handling. */
function press(
  view: EditorView,
  key: string,
  mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: mods.shift && key.length === 1 ? key.toUpperCase() : key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    // CodeMirror falls back to `keyCode` to recover the UNSHIFTED name of a
    // shifted letter (⌘⇧H arrives as key "H"), and jsdom leaves it at 0.
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    bubbles: true,
    cancelable: true,
    metaKey: !!mods.mod && MOD_IS_META,
    ctrlKey: !!mods.mod && !MOD_IS_META,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });
  view.contentDOM.dispatchEvent(event);
}

function text(view: EditorView): string {
  return view.state.doc.toString();
}

describe("list continuation (lang-markdown's keymap, not ours)", () => {
  it("continues a task item unchecked on Enter", () => {
    const view = mount("- [x] a", 7);
    press(view, "Enter");
    expect(text(view)).toBe("- [x] a\n- [ ] ");
    view.destroy();
  });

  it("renumbers the next ordered item", () => {
    const view = mount("1. first", 8);
    press(view, "Enter");
    expect(text(view)).toBe("1. first\n2. ");
    view.destroy();
  });

  it("ends the list when Enter lands on an empty item", () => {
    const view = mount("- one\n- two\n- ", 14);
    press(view, "Enter");
    expect(text(view)).toBe("- one\n- two\n");
    view.destroy();
  });

  it("eats the marker on Backspace at the start of an item's body", () => {
    const view = mount("- item", 2);
    press(view, "Backspace");
    expect(text(view)).toBe("item");
    view.destroy();
  });
});

describe("Tab / Shift-Tab", () => {
  it("indents a list item by the indent unit", () => {
    const view = mount("- item", 6);
    press(view, "Tab");
    expect(text(view)).toBe("  - item");
    press(view, "Tab", { shift: true });
    expect(text(view)).toBe("- item");
    view.destroy();
  });

  it("inserts a soft indent on a plain line", () => {
    const view = mount("word", 4);
    press(view, "Tab");
    expect(text(view)).toBe("word  ");
    view.destroy();
  });
});

describe("inline formatting", () => {
  it("wraps the word under an empty selection", () => {
    const view = mount("make this bold", 12); // caret inside "bold"
    press(view, "b", { mod: true });
    expect(text(view)).toBe("make this **bold**");
    view.destroy();
  });

  it("trims whitespace the selection swept up", () => {
    const view = mount("one two three");
    // Select "two " — trailing space included, as a double-click often does.
    view.dispatch({ selection: EditorSelection.range(4, 8) });
    press(view, "b", { mod: true });
    expect(text(view)).toBe("one **two** three");
    view.destroy();
  });

  it("toggles a highlight on and off with Mod-Shift-h", () => {
    const view = mount("pick me");
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    press(view, "H", { mod: true, shift: true });
    expect(text(view)).toBe("==pick== me");
    press(view, "H", { mod: true, shift: true });
    expect(text(view)).toBe("pick me");
    view.destroy();
  });

  it("puts the caret in the label when the selection is a URL", () => {
    const view = mount("https://example.com/x");
    view.dispatch({ selection: EditorSelection.range(0, 21) });
    press(view, "k", { mod: true });
    expect(text(view)).toBe("[](https://example.com/x)");
    expect(view.state.selection.main.head).toBe(1);
    view.destroy();
  });

  it("puts the caret in the url when the selection is prose", () => {
    const view = mount("click here");
    view.dispatch({ selection: EditorSelection.range(0, 10) });
    press(view, "k", { mod: true });
    expect(text(view)).toBe("[click here]()");
    expect(view.state.selection.main.head).toBe(13);
    view.destroy();
  });

  it("inserts a hard break on Shift-Enter, not a new list item", () => {
    const view = mount("- line one", 10);
    press(view, "Enter", { shift: true });
    expect(text(view)).toBe("- line one  \n");
    view.destroy();
  });
});

describe("heading level", () => {
  it("sets and then clears a level with Mod-Alt-n", () => {
    const view = mount("Some title", 4);
    press(view, "2", { mod: true, alt: true });
    expect(text(view)).toBe("## Some title");
    press(view, "2", { mod: true, alt: true });
    expect(text(view)).toBe("Some title");
    view.destroy();
  });

  it("replaces an existing level rather than stacking hashes", () => {
    const view = mount("### deep", 5);
    press(view, "1", { mod: true, alt: true });
    expect(text(view)).toBe("# deep");
    view.destroy();
  });

  it("applies to every line a selection touches", () => {
    const view = mount("one\ntwo\nthree");
    view.dispatch({ selection: EditorSelection.range(0, 7) });
    press(view, "3", { mod: true, alt: true });
    expect(text(view)).toBe("### one\n### two\nthree");
    view.destroy();
  });
});

describe("task toggle (Mod-l)", () => {
  it("ticks an open task", () => {
    const view = mount("- [ ] wash up", 8);
    press(view, "l", { mod: true });
    expect(text(view)).toBe("- [x] wash up");
    press(view, "l", { mod: true });
    expect(text(view)).toBe("- [ ] wash up");
    view.destroy();
  });

  it("gives a plain bullet a box", () => {
    const view = mount("  - buy milk", 6);
    press(view, "l", { mod: true });
    expect(text(view)).toBe("  - [ ] buy milk");
    view.destroy();
  });

  it("turns a plain line into a task, keeping its indent", () => {
    const view = mount("  remember this", 6);
    press(view, "l", { mod: true });
    expect(text(view)).toBe("  - [ ] remember this");
    view.destroy();
  });

  it("changes every selected line in ONE transaction", () => {
    const view = mount("a\nb\nc");
    view.dispatch({ selection: EditorSelection.range(0, 3) });
    // One transaction is what makes ⌘Z take the whole gesture back, and what
    // keeps the Yjs binding from shipping three separate updates.
    let docChanges = 0;
    view.dispatch({
      effects: [],
      annotations: [],
    });
    const listener = (u: { docChanged: boolean }) => {
      if (u.docChanged) docChanges++;
    };
    view.update = ((orig) =>
      function (this: EditorView, trs: Parameters<EditorView["update"]>[0]) {
        for (const tr of trs) listener({ docChanged: tr.docChanged });
        return orig.call(this, trs);
      })(view.update) as EditorView["update"];
    press(view, "l", { mod: true });
    expect(text(view)).toBe("- [ ] a\n- [ ] b\nc");
    expect(docChanges).toBe(1);
    view.destroy();
  });
});
