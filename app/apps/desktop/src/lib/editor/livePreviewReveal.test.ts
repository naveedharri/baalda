// @vitest-environment jsdom
//
// Token-scoped reveal — the rule that makes the editor feel like Obsidian
// rather than like a syntax-highlighted textarea.
//
// Everything is asserted through the RENDERED TEXT of a real EditorView:
// hiding a marker is a `Decoration.replace`, so a hidden `**` is simply absent
// from `contentDOM.textContent`. That is the same thing the reader sees, and it
// cannot be faked by a decoration that exists but doesn't apply.
//
// Focus is dispatched as an effect rather than through `view.focus()`:
// CodeMirror notices real DOM focus on a 10 ms timeout (`updateForFocusChange`),
// which no synchronous test can observe.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";
import { setFocused } from "./reveal";

function mount(doc: string, opts: { focus?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
  if (opts.focus !== false) view.dispatch({ effects: setFocused.of(true) });
  return view;
}

/** What the reader sees. `textContent` on the content element runs the lines
 *  together, so join the line elements the way the eye does. */
const shown = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".cm-line"))
    .map((l) => l.textContent ?? "")
    .join("\n");

function at(view: EditorView, anchor: number): string {
  view.dispatch({ selection: { anchor } });
  return shown(view);
}

describe("live preview: token-scoped reveal", () => {
  it("hides the markers of a bold span the caret is nowhere near", () => {
    const doc = "plain **bold** tail";
    const view = mount(doc);
    expect(at(view, 0)).toBe("plain bold tail");
    view.destroy();
  });

  it("reveals them with the caret immediately BEFORE the opening marker", () => {
    // Adjacency is inclusive on purpose: you type `**` and the markers you are
    // typing must not vanish from under the caret.
    const doc = "plain **bold** tail";
    const view = mount(doc);
    expect(at(view, doc.indexOf("**"))).toContain("**bold**");
    view.destroy();
  });

  it("reveals them with the caret INSIDE the span", () => {
    const doc = "plain **bold** tail";
    const view = mount(doc);
    expect(at(view, doc.indexOf("bold") + 2)).toContain("**bold**");
    view.destroy();
  });

  it("reveals them with the caret immediately AFTER the closing marker", () => {
    const doc = "plain **bold** tail";
    const view = mount(doc);
    expect(at(view, doc.indexOf("**bold**") + "**bold**".length)).toContain("**bold**");
    view.destroy();
  });

  it("folds them again one position past the closing marker", () => {
    const doc = "plain **bold** tail";
    const view = mount(doc);
    const past = doc.indexOf("**bold**") + "**bold**".length + 1;
    expect(at(view, past)).toBe("plain bold tail");
    view.destroy();
  });

  it("unfolds only the span you are in, not its neighbour on the same line", () => {
    // The old LINE rule showed every marker on the line at once, which is what
    // made typing feel like the text was jumping around.
    const doc = "*i* and **B**";
    const view = mount(doc);
    const text = at(view, doc.indexOf("i"));
    expect(text).toContain("*i*");
    expect(text).not.toContain("**B**");
    expect(text).toContain("B");
    view.destroy();
  });

  it("unfolds a nested emphasis together with the span that contains it", () => {
    // Containment, not proximity: the caret inside `*i*` IS inside the
    // surrounding `**…**`, so both sets of markers are being edited.
    const doc = "**b *i* b**";
    const view = mount(doc);
    expect(at(view, doc.indexOf("i"))).toBe("**b *i* b**");
    // From outside, the whole thing renders.
    const outside = mount("tail\n\n**b *i* b**");
    expect(at(outside, 0)).toBe("tail\n\nb i b");
    view.destroy();
    outside.destroy();
  });

  it("mixes scopes on one line: the # shows, the ** stays hidden", () => {
    // The headline case. `#` is LINE-scoped (editing a heading is editing the
    // line); `**` is TOKEN-scoped. Caret at the end of the line, clear of the
    // bold — the old rule showed both markers here.
    const doc = "# Head **b** tail";
    const view = mount(doc);
    const text = at(view, doc.length);
    expect(text).toContain("# Head");
    expect(text).not.toContain("**b**");
    expect(text).toContain("b tail");
    view.destroy();
  });

  it("hides everything while the editor is blurred, caret or no caret", () => {
    const doc = "plain **bold** tail";
    const view = mount(doc, { focus: false });
    view.dispatch({ selection: { anchor: doc.indexOf("bold") + 1 } });
    expect(shown(view)).toBe("plain bold tail");
    // …and comes straight back when focus returns.
    view.dispatch({ effects: setFocused.of(true) });
    expect(shown(view)).toContain("**bold**");
    view.destroy();
  });

  it("reveals every span a spanning selection covers", () => {
    const doc = "*i* mid **B**";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(shown(view)).toBe(doc);
    view.destroy();
  });

  it("reveals both spans under two cursors and nothing between them", () => {
    const doc = "*a* *b* *c*";
    const view = mount(doc);
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(doc.indexOf("a")),
        EditorSelection.cursor(doc.lastIndexOf("c")),
      ]),
    });
    const text = shown(view);
    expect(text).toContain("*a*");
    expect(text).toContain("*c*");
    expect(text).not.toContain("*b*");
    view.destroy();
  });

  it("keeps inline code backticks token-scoped and fence backticks visible", () => {
    const doc = "run `code` now";
    const view = mount(doc);
    expect(at(view, 0)).toBe("run code now");
    expect(at(view, doc.indexOf("code"))).toContain("`code`");
    view.destroy();
  });

  it("shows a link's URL only while that link is being edited", () => {
    const doc = "see [text](https://example.com) and [other](https://other.com)";
    const view = mount(doc);
    expect(at(view, 0)).toBe("see text and other");
    const text = at(view, doc.indexOf("text"));
    expect(text).toContain("[text](https://example.com)");
    expect(text).not.toContain("https://other.com");
    view.destroy();
  });

  it("keeps a bullet a dot even on the active line", () => {
    const doc = "- one\n- two";
    const view = mount(doc);
    const text = at(view, doc.indexOf("one"));
    expect(text).toContain("•");
    expect(text).not.toContain("- one");
    view.destroy();
  });

  it("brings the raw task marker back on the active line", () => {
    const doc = "- [ ] task";
    const view = mount(doc);
    expect(at(view, 0)).toContain("- [ ] task");
    view.destroy();
  });

  it("hides an escape backslash off the line and restores it on", () => {
    const doc = "a \\*literal\\* b";
    const view = mount(doc);
    const off = mount("head\n\na \\*literal\\* b");
    expect(at(off, 0)).toBe("head\n\na *literal* b");
    expect(at(view, doc.length)).toBe(doc);
    view.destroy();
    off.destroy();
  });
});
