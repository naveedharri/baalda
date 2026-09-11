// @vitest-environment jsdom
//
// Callouts, tag pills, highlights, comments and wiki-link display, through a
// real EditorView — the decoration layers, not the parser (that is parse.test.ts).

import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "../index";
import { setFocused } from "../reveal";

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

const shown = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".cm-line"))
    .map((l) => l.textContent ?? "")
    .join("\n");

describe("callouts", () => {
  it("tints every line of the block and titles the first", () => {
    const view = mount("> [!tip] Do this\n> and then this");
    const lines = view.contentDOM.querySelectorAll(".cm-callout");
    expect(lines).toHaveLength(2);
    expect(lines[0].classList.contains("cm-callout-title")).toBe(true);
    expect(lines[0].getAttribute("data-callout")).toBe("tip");
    // A callout is still a blockquote — it inherits the bar and the indent.
    expect(lines[0].classList.contains("cm-blockquote")).toBe(true);
    view.destroy();
  });

  it("folds the 14 types onto five semantic families", () => {
    const view = mount(
      ["> [!bug] a", "", "> [!faq] b", "", "> [!done] c", "", "> [!cite] d", "", "> [!wat] e"].join("\n"),
    );
    const families = Array.from(view.contentDOM.querySelectorAll(".cm-callout-title")).map((l) =>
      l.getAttribute("data-callout"),
    );
    // Unknown types fall back to `note` rather than rendering unstyled.
    expect(families).toEqual(["danger", "warning", "tip", "quote", "note"]);
    view.destroy();
  });

  it("replaces the marker with an icon off the line and restores it on", () => {
    const doc = "> [!warning] Careful";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(shown(view)).toContain("[!warning]");
    // Move the caret away: the marker becomes an icon, the title stays text.
    const away = mount("tail\n\n> [!warning] Careful");
    away.dispatch({ selection: { anchor: 0 } });
    expect(away.contentDOM.querySelector(".cm-callout-icon svg")).not.toBeNull();
    expect(shown(away)).toContain("Careful");
    expect(shown(away)).not.toContain("[!warning]");
    view.destroy();
    away.destroy();
  });

  it("names the callout when the author wrote no title", () => {
    const view = mount("head\n\n> [!tip]\n> body");
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.contentDOM.querySelector(".cm-callout-label")?.textContent).toBe("Tip");
    view.destroy();
  });
});

describe("tags and inline OFM marks", () => {
  it("draws a tag as a pill, hash and all, even under the caret", () => {
    const doc = "planning #2026goals today";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("2026") } });
    const pill = view.contentDOM.querySelector(".cm-hashtag");
    expect(pill?.textContent).toBe("#2026goals");
    view.destroy();
  });

  it("hides == markers off the token and shows them on it", () => {
    const doc = "a ==marked== b";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: 0 } });
    expect(shown(view)).toBe("a marked b");
    view.dispatch({ selection: { anchor: doc.indexOf("marked") } });
    expect(shown(view)).toBe(doc);
    view.destroy();
  });

  it("keeps comment TEXT visible while folding its %% markers", () => {
    // A comment you cannot see is a comment you publish by mistake.
    const doc = "note %%private aside%% end";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: 0 } });
    expect(shown(view)).toBe("note private aside end");
    view.destroy();
  });
});

describe("wiki-link display", () => {
  const at = (view: EditorView, anchor: number) => {
    view.dispatch({ selection: { anchor } });
    return shown(view);
  };

  it("hides the brackets off the caret", () => {
    const doc = "see [[Target Note]] here";
    const view = mount(doc);
    expect(at(view, 0)).toBe("see Target Note here");
    expect(at(view, doc.indexOf("Target"))).toBe(doc);
    view.destroy();
  });

  it("shows only the alias of [[A|B]]", () => {
    const doc = "see [[Target Note|the target]] here";
    const view = mount(doc);
    expect(at(view, 0)).toBe("see the target here");
    view.destroy();
  });

  it("shows [[A#H]] as A › H", () => {
    const doc = "see [[Target#Heading]] here";
    const view = mount(doc);
    // The gap around the `›` is CSS padding on the widget, not text.
    expect(at(view, 0)).toBe("see Target\u203aHeading here");
    view.destroy();
  });

  it("shows only the alias of [[A#H|B]]", () => {
    const doc = "see [[Target#Heading|label]] here";
    const view = mount(doc);
    expect(at(view, 0)).toBe("see label here");
    view.destroy();
  });
});
