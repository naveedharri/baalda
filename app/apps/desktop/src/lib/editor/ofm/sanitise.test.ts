// @vitest-environment jsdom
//
// Everything Stage 3a adds reads text OUT OF THE NOTE and puts it on screen: a
// callout's type and title, a fence's language word, a comment's body, a
// highlight's body. A note is untrusted input — it arrives from a teammate over
// the CRDT, from an AI through MCP, or from a file someone dropped in the vault.
//
// The rule is that none of those paths may ever produce an ELEMENT. Widgets use
// `createElement`/`createElementNS` and `textContent`; `renderEmbeddedHtml` (the
// deliberate exception, for HTML blocks) is the only `innerHTML` in the editor
// and does its own sanitising. These four cases are the ones an attacker would
// actually try.

import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "../index";
import { setFocused } from "../reveal";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
  view.dispatch({ effects: setFocused.of(true), selection: { anchor: 0 } });
  return view;
}

const text = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".cm-line"))
    .map((l) => l.textContent ?? "")
    .join("\n");

describe("OFM decorations never build elements from note text", () => {
  it("keeps a <script> in a callout title as literal text", () => {
    const view = mount('head\n\n> [!note] <script>alert(1)</script>\n> body');
    expect(view.contentDOM.querySelector("script")).toBeNull();
    expect(text(view)).toContain("<script>alert(1)</script>");
    view.destroy();
  });

  it("keeps an <img onerror> in a fence info string as literal text", () => {
    const view = mount('```<img src=x onerror=alert(1)>\ncode\n```');
    expect(view.contentDOM.querySelector("img")).toBeNull();
    expect(text(view)).toContain("onerror=alert(1)");
    view.destroy();
  });

  it("keeps an <iframe> inside a %%comment%% as literal text", () => {
    const view = mount("before %%<iframe src=evil></iframe>%% after");
    expect(view.contentDOM.querySelector("iframe")).toBeNull();
    expect(text(view)).toContain("<iframe src=evil></iframe>");
    view.destroy();
  });

  it("keeps a <script> inside ==highlight== as literal text", () => {
    const view = mount("a ==<script>alert(1)</script>== b");
    expect(view.contentDOM.querySelector("script")).toBeNull();
    expect(text(view)).toContain("<script>alert(1)</script>");
    view.destroy();
  });

  it("keeps a callout type that is markup from reaching an attribute verbatim", () => {
    // `data-callout` is set from the FAMILY map, never from the raw type, so a
    // crafted type cannot inject an attribute value of its own.
    const view = mount('head\n\n> [!x" onload="alert(1)] t');
    const line = view.contentDOM.querySelector(".cm-callout");
    // `"` and spaces are outside `[\w-]`, so this is not a callout at all.
    expect(line).toBeNull();
    view.destroy();
  });
});
