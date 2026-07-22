// @vitest-environment jsdom
//
// Regression: block-level live-preview widgets (raw HTML blocks, ```html
// fences, GFM tables) must come from a StateField — CodeMirror rejects
// block/multi-line replace decorations provided by a view plugin with
// `RangeError: Block decorations may not be specified via plugins`, which used
// to kill the whole HTML-preview feature at runtime. This exercises the real
// editor extension stack, not just the parser.
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";

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

describe("livePreview block widgets (real EditorView)", () => {
  it("renders a ```html fence as a sanitized HTML preview", () => {
    const view = mount(
      [
        "Intro paragraph.",
        "",
        "```html",
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '    <meta charset="UTF-8">',
        "    <title>My Web Page</title>",
        "</head>",
        "<body>",
        "",
        "    <h1>Hello, World!</h1>",
        "",
        "</body>",
        "</html>",
        "```",
        "",
        "## Start here",
      ].join("\n")
    );
    const widget = view.dom.querySelector(".cm-md-html");
    expect(widget).not.toBeNull();
    expect(widget!.querySelector("h1")?.textContent).toBe("Hello, World!");
    view.destroy();
  });

  it("renders a bare HTML block as a preview", () => {
    const view = mount(["Before.", "", '<div class="card"><h2>Boxed</h2></div>', "", "After."].join("\n"));
    const widget = view.dom.querySelector(".cm-md-html");
    expect(widget).not.toBeNull();
    expect(widget!.querySelector("h2")?.textContent).toBe("Boxed");
    view.destroy();
  });

  it("renders a GFM table as a real <table>", () => {
    const view = mount(["Intro.", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "tail"].join("\n"));
    const table = view.dom.querySelector(".cm-md-table table");
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll("th")).toHaveLength(2);
    view.destroy();
  });

  it("shows raw fence source while the cursor is inside it", () => {
    const doc = ["```html", "<h1>Hi</h1>", "```"].join("\n");
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("<h1>") } });
    expect(view.dom.querySelector(".cm-md-html")).toBeNull();
    view.destroy();
  });
});
