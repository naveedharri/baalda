// @vitest-environment jsdom
//
// Selection geometry: WHERE the editor's horizontal inset lives.
//
// CodeMirror's drawSelection() derives every selection rect from the FIRST
// `.cm-line`'s computed padding (`content.querySelector(".cm-line")`, then that
// one element's paddingLeft/paddingRight applied to every rect) — it cannot see
// padding on `.cm-content`. A centring pad there therefore made full-line and
// multi-line rects start ~58px left of the text and overrun its right edge.
//
// jsdom does no layout, so `getComputedStyle(line).paddingLeft` cannot resolve
// `max()`, `calc()`, `100%` or `ch`, and `EditorView.theme` rules arrive through
// a StyleModule whose cascade jsdom only partly implements: a PIXEL assertion is
// not achievable here. What is testable is the placement of the declarations and
// the widget/DOM contract the CSS depends on. The visual half is manual (Stage 1
// plan §9 step 1).
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";
import { editorThemeSpec } from "./theme";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
    } as never),
    parent,
  });
}

describe("editor theme geometry", () => {
  it("keeps the horizontal inset on .cm-line, where drawSelection can see it", () => {
    expect(editorThemeSpec[".cm-line"].paddingInline).toBe("var(--editor-pad-x)");
    // Vertical only. A horizontal pad here is invisible to drawSelection, and
    // `.cm-content` must stay full width so a margin click still places a caret.
    expect(editorThemeSpec[".cm-content"].padding).toBe("var(--sp-8) 0 40vh");
  });

  it("drops the CSS drawSelection overrides with !important anyway", () => {
    expect(editorThemeSpec[".cm-content"].caretColor).toBeUndefined();
    expect(Object.keys(editorThemeSpec).some((k) => k.includes("::selection"))).toBe(false);
  });

  it("keeps the selection layer lifted over opaque line backgrounds", () => {
    // The code-block well is opaque; a layer painted behind it swallows the wash.
    expect(editorThemeSpec[".cm-selectionLayer"].zIndex).toBe("1");
  });

  it("hands the table's selection to CodeMirror's layer, not the browser's", () => {
    // A native `::selection` inside the cells paints blue on top of the accent
    // wash — two highlights in two colours over one block.
    expect(editorThemeSpec[".cm-md-table-wrap"].userSelect).toBe("none");
    // …and the table must not raise itself over the `z-index: 1` wash.
    expect(editorThemeSpec[".cm-md-table-wrap"].zIndex).toBeUndefined();
    expect(editorThemeSpec[".cm-md-table"].zIndex).toBeUndefined();
    // The text you are editing is still selectable.
    expect(editorThemeSpec[".cm-md-table .cm-md-cell-input"].userSelect).toBe("text");
  });

  it("gives an empty table cell a full line box", () => {
    // A just-added row is all empty cells; with no box it renders as a hairline.
    expect(editorThemeSpec[".cm-md-table .cm-md-cell"].display).toBe("block");
    expect(editorThemeSpec[".cm-md-table .cm-md-cell"].minHeight).toBe("1.6em");
    expect(editorThemeSpec[".cm-md-table .cm-md-cell-content:empty::before"].content).toBe(
      '"\\200B"',
    );
  });

  it("sizes the add bars to the table, and spaces them with padding", () => {
    // The row bar spans the table, not the editor: the wrap is max-content wide
    // and the column bar is the 22px that `calc` takes back off it.
    expect(editorThemeSpec[".cm-md-table-wrap"].width).toBe("max-content");
    expect(editorThemeSpec[".cm-md-table .cm-md-add-row"].width).toBe("calc(100% - 22px)");
    expect(editorThemeSpec[".cm-md-table .cm-md-add-col"].width).toBe("22px");
    // `align-items: stretch` is what makes the column bar the table's height.
    expect(editorThemeSpec[".cm-md-table-row"].alignItems).toBe("stretch");
    // Padding, never margin: CM6 measures a block widget's height with
    // getBoundingClientRect, which does not see margins.
    expect(editorThemeSpec[".cm-md-table"].paddingBlock).toBe("var(--sp-3)");
    expect(editorThemeSpec[".cm-md-table"].margin).toBeUndefined();
  });

  it("paints full-width line decorations inside the prose column", () => {
    // A border/background on a now-full-width line box would reach the window.
    expect(editorThemeSpec[".cm-blockquote::before"].left).toBe("var(--editor-pad-x)");
    expect(editorThemeSpec[".cm-codeblock"].backgroundClip).toBe("content-box");
    expect(editorThemeSpec[".cm-codeblock"].borderLeft).toBeUndefined();
    expect(editorThemeSpec[".cm-hr::after"].left).toBe("var(--editor-pad-x)");
    expect(editorThemeSpec[".cm-block-inset"].marginInline).toBe("var(--editor-pad-x)");
  });

  it("dims the • bullet to the faint marker tier, not the accent", () => {
    expect(editorThemeSpec[".cm-bullet"].color).toBe("var(--text-tertiary)");
  });

  it("sets no horizontal padding on the frontmatter line class", () => {
    // drawSelection reads the FIRST line's padding, so a line class that changes
    // it shifts the whole document's selection geometry.
    const fm = editorThemeSpec[".cm-frontmatter"];
    for (const key of Object.keys(fm)) {
      expect(key).not.toMatch(/padding(Inline|Left|Right)?$/);
    }
  });
});

describe("block replace widgets and the shared inset class", () => {
  it("gives a rendered table the inset class, as a direct child of .cm-content", () => {
    const view = mount(["Intro.", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
    const table = view.contentDOM.querySelector(".cm-md-table")!;
    expect(table).not.toBeNull();
    expect(table.classList.contains("cm-block-inset")).toBe(true);
    // The `100%` inside --editor-pad-x resolves against this parent's content box.
    expect(table.parentElement).toBe(view.contentDOM);
    view.destroy();
  });

  it("gives an embedded HTML block the inset class too", () => {
    const view = mount(["Before.", "", '<div class="card"><h2>Boxed</h2></div>', "", "After."].join("\n"));
    const html = view.contentDOM.querySelector(".cm-md-html")!;
    expect(html).not.toBeNull();
    expect(html.classList.contains("cm-block-inset")).toBe(true);
    expect(html.parentElement).toBe(view.contentDOM);
    view.destroy();
  });

  it("does NOT give an inline PDF embed the inset class — it sits inside a padded line", () => {
    const view = mount("Before.\n\n![spec](files/spec.pdf)\n");
    const pdf = view.contentDOM.querySelector(".cm-md-pdf")!;
    expect(pdf).not.toBeNull();
    expect(pdf.classList.contains("cm-block-inset")).toBe(false);
    view.destroy();
  });
});
