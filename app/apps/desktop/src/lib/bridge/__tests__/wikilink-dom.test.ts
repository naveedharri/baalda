// Regression test: clicking the INNER text span of a [[wikilink]] (where real
// clicks land, since the highlighter nests spans inside the cm-wikilink mark)
// must navigate. Only a RESOLVED link navigates — one whose target no note
// answers to is greyed out and inert — so each case names its target note.
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions } from "../../editor/index";

beforeAll(() => {
  // An inert (unresolved) link lets CM6's own mouse selection run, which needs
  // Range#getClientRects — jsdom has no layout engine.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

const TITLES = ["F-01__THE_PACT_METHOD_v2_1", "create a link", "Real Note"].map((n, i) => ({
  id: String(i),
  path: `${n}.md`,
  title: n,
}));

function mount(doc: string, onNavigate: (t: string) => void) {
  const state = EditorState.create({
    doc,
    extensions: baseExtensions({ doc, getTitles: () => TITLES, onNavigate, collab: true }),
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

function clickInnerTextSpan(view: EditorView, needle: string): boolean {
  let clicked = false;
  view.contentDOM.querySelectorAll("span").forEach((el) => {
    if (clicked) return;
    // leaf span holding the link text, WITHOUT the cm-wikilink class —
    // exactly where a user's click lands.
    if (
      el.children.length === 0 &&
      el.textContent?.includes(needle) &&
      !el.classList.contains("cm-wikilink")
    ) {
      clicked = true;
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      } catch { /* jsdom layout noise from CM6 default selection */ }
    }
  });
  return clicked;
}

describe("wikilink click on nested highlighter span", () => {
  it("underscored vault-style name navigates", () => {
    let navigated: string | null = null;
    const view = mount("[[F-01__THE_PACT_METHOD_v2_1]]", (t) => (navigated = t));
    expect(clickInnerTextSpan(view, "F-01")).toBe(true);
    expect(navigated).toBe("F-01__THE_PACT_METHOD_v2_1");
  });
  it("plain name navigates", () => {
    let navigated: string | null = null;
    const view = mount("See [[create a link]] here", (t) => (navigated = t));
    expect(clickInnerTextSpan(view, "create a link")).toBe(true);
    expect(navigated).toBe("create a link");
  });
  it("alias + heading resolve to bare target", () => {
    let navigated: string | null = null;
    const view = mount("[[Real Note#Section|shown text]]", (t) => (navigated = t));
    expect(clickInnerTextSpan(view, "shown text")).toBe(true);
    expect(navigated).toBe("Real Note");
  });
  it("a link to a note that does not exist does not navigate", () => {
    let navigated: string | null = null;
    const view = mount("See [[No such note]] here", (t) => (navigated = t));
    expect(clickInnerTextSpan(view, "No such note")).toBe(true);
    expect(navigated).toBeNull();
  });
});
