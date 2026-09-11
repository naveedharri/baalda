// @vitest-environment jsdom
//
// The frontmatter region as the editor sees it. The first half is a parity table
// with Rust's `src-tauri/src/parse.rs split_frontmatter` — the index, the search
// body and `notes.frontmatter` all come from that function, so a disagreement
// here dims text the index treats as body (or leaves real YAML rendered as a
// giant Setext heading). The second half exercises the decorations through a real
// EditorView, including the guards that keep every other decoration source out of
// the region.
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { findFrontmatter } from "./frontmatter";
import { createEditorState } from "./index";

const at = (doc: string) => findFrontmatter(Text.of(doc.split("\n")));

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

const lineTexts = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);

describe("findFrontmatter (Rust parity)", () => {
  it("finds a normal block", () => {
    const fm = at("---\ntitle: X\n---\nbody")!;
    expect(fm).toMatchObject({ from: 0, openLine: 1, closeLine: 3 });
    expect(fm.to).toBe("---\ntitle: X\n---".length);
  });

  it("finds a CRLF block", () => {
    // Rust's `strip_prefix("---\n")` runs after the CR, and our fence test drops
    // a trailing \r for the same reason.
    expect(at("---\r\ntitle: X\r\n---\r\nbody")).toMatchObject({ openLine: 1, closeLine: 3 });
  });

  it("finds a frontmatter-only file", () => {
    expect(at("---\nk: v\n---")).toMatchObject({ openLine: 1, closeLine: 3 });
  });

  it("finds an empty block (both fences, no content)", () => {
    expect(at("---\n---\nbody")).toMatchObject({ openLine: 1, closeLine: 2 });
  });

  it("refuses a block with no closing fence", () => {
    expect(at("---\ntitle: X\nbody")).toBeNull();
  });

  it("refuses a block that is not the first thing in the file", () => {
    expect(at("text\n---\nk: v\n---")).toBeNull();
  });

  it("refuses a fence with anything else on its line", () => {
    expect(at("--- \nk: v\n---")).toBeNull();
    expect(at("----\nk: v\n---")).toBeNull();
  });

  it("refuses a one-line document", () => {
    expect(at("---")).toBeNull();
  });
});

describe("frontmatter decorations (real EditorView)", () => {
  it("hides the fences off the region and shows them when the caret is inside", () => {
    const doc = "---\ntags: youtube\n---\n\nBody.";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("Body.") } });
    expect(lineTexts(view)).not.toContain("---");
    expect(view.contentDOM.querySelector(".cm-frontmatter")).not.toBeNull();

    view.dispatch({ selection: { anchor: doc.indexOf("tags") } });
    expect(lineTexts(view)).toContain("---");
    view.destroy();
  });

  it("leaves an empty frontmatter block reachable", () => {
    // Both fences hidden would make it invisible AND unreachable by caret.
    const doc = "---\n---\nBody.";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("Body.") } });
    expect(lineTexts(view).filter((t) => t === "---")).toHaveLength(2);
    view.destroy();
  });

  it("does not draw an hr hairline through the region's lines", () => {
    // Without the blocks.ts guard, lezer's reading of `---` as a HorizontalRule
    // puts a hairline through a fence line we are collapsing.
    const doc = "---\ntags: youtube\n---\n\nBody.";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: 1 } });
    const fmLines = [...view.contentDOM.querySelectorAll(".cm-frontmatter")];
    expect(fmLines).toHaveLength(3);
    for (const line of fmLines) {
      expect(line.classList.contains("cm-hr")).toBe(false);
    }
    view.destroy();
  });

  it("hides nothing inside the region — the YAML stays literal", () => {
    // Without the livePreview guard, `key: v\n---` parses as a SetextHeading2
    // whose HeaderMark gets hidden and whose text is drawn heading-sized (the
    // giant bold "tags: youtube" from the bug report). The region's own theme
    // rule (`.cm-frontmatter span`) is what dims it instead.
    const doc = "---\ntags: youtube\ndate: 2026-09-11\n---\n\nBody.";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("Body.") } });
    const fmLines = [...view.contentDOM.querySelectorAll(".cm-frontmatter")].map(
      (l) => l.textContent,
    );
    expect(fmLines).toEqual(["tags: youtube", "date: 2026-09-11"]);
    view.destroy();
  });

  it("leaves a `- item` inside the region as raw text (no • bullet)", () => {
    const doc = "---\ntags:\n- youtube\n---\n\nBody.";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("Body.") } });
    expect(view.contentDOM.querySelector(".cm-frontmatter .cm-bullet")).toBeNull();
    view.destroy();
  });

  it("un-dims when the block stops being valid frontmatter", () => {
    // Backspace at the start of the body joins into the (hidden) closing fence.
    const doc = "---\ntags: youtube\n---\nBody.";
    const view = mount(doc);
    expect(view.contentDOM.querySelector(".cm-frontmatter")).not.toBeNull();
    view.dispatch({ changes: { from: 0, to: 3, insert: "x" } });
    expect(view.contentDOM.querySelector(".cm-frontmatter")).toBeNull();
    view.destroy();
  });

  it("leaves a document with no frontmatter alone", () => {
    const view = mount("# Heading\n\n---\n\nBody.");
    expect(view.contentDOM.querySelector(".cm-frontmatter")).toBeNull();
    // The standalone rule further down still gets its hairline class.
    expect(view.contentDOM.querySelector(".cm-hr")).not.toBeNull();
    view.destroy();
  });
});
