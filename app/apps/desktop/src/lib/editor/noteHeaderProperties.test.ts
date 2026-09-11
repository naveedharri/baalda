// @vitest-environment jsdom
//
// The Properties panel through a real EditorView and a real React root.
//
// Two assertions here are the feature's gate:
//   1. the panel's host node survives an edit (`updateDOM` returns true) — if
//      it ever returns false, a teammate's keystroke destroys the field under
//      your cursor and collaboration is unusable;
//   2. an unparseable block gets a banner and NO replace decoration, so the
//      YAML stays visible and is never rewritten.
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { propertiesMode, type PropertiesMode } from "./frontmatter";
import { createEditorState } from "./index";

/** The Compartment Editor.tsx owns, exposed so a test can reconfigure it. */
const modeCompartments = new WeakMap<EditorView, Compartment>();

function mount(doc: string, mode: PropertiesMode = "visible", readOnly = false) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const modeCompartment = new Compartment();
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      header: {
        path: "Notes/My Note.md",
        mode,
        modeCompartment,
        renameTo: async () => null,
        noteExists: async () => false,
      },
      extraExtensions: readOnly
        ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [],
    } as never),
    parent,
  });
  modeCompartments.set(view, modeCompartment);
  // Park the caret in the body: a caret inside the region yields to source.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

const panel = (view: EditorView) => view.dom.querySelector(".cm-note-properties");
const names = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLInputElement>(".prop-name")].map((i) => i.value);
const lineTexts = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);

const DOC = [
  "---",
  "status: draft",
  "tags: [youtube, ai]",
  "done: false",
  "---",
  "",
  "Body text.",
].join("\n");

describe("the Properties panel", () => {
  it("renders one row per key, with the right control", () => {
    const view = mount(DOC);
    expect(panel(view)).not.toBeNull();
    expect(names(view)).toEqual(["status", "tags", "done"]);
    expect(view.dom.querySelectorAll(".prop-chip")).toHaveLength(2);
    expect(view.dom.querySelector<HTMLInputElement>(".prop-checkbox")?.checked).toBe(false);
    // The YAML lines are replaced, not merely hidden by CSS.
    expect(lineTexts(view)).not.toContain("status: draft");
    view.destroy();
  });

  it("yields to raw source while the caret is inside the region", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: DOC.indexOf("status") } });
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    // …and comes back when the caret leaves.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(panel(view)).not.toBeNull();
    view.destroy();
  });

  it("shows a banner over YAML it refuses to rewrite, with the text intact", () => {
    const bad = "---\nmeta:\n  author: me\n---\n\nBody.";
    const view = mount(bad);
    expect(panel(view)).toBeNull();
    expect(view.dom.querySelector(".cm-fm-banner")).not.toBeNull();
    expect(lineTexts(view)).toContain("  author: me");
    expect(view.contentDOM.querySelectorAll(".cm-fm-invalid").length).toBe(4);
    // Nothing was written: the document is byte-identical.
    expect(view.state.doc.toString()).toBe(bad);
    view.destroy();
  });

  it("hidden mode shows neither the panel nor the source", () => {
    const view = mount(DOC, "hidden");
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).not.toContain("status: draft");
    expect(lineTexts(view)).not.toContain("---");
    view.destroy();
  });

  it("source mode keeps Stage 1's dimmed block", () => {
    const view = mount(DOC, "source");
    expect(panel(view)).toBeNull();
    expect(view.contentDOM.querySelector(".cm-frontmatter")).not.toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    view.destroy();
  });

  it("follows a display-mode change without rebuilding the view", () => {
    const view = mount(DOC, "visible");
    expect(panel(view)).not.toBeNull();
    // Exactly what Settings -> Appearance dispatches.
    view.dispatch({
      effects: modeCompartments
        .get(view)!
        .reconfigure(propertiesMode.of("source")),
    });
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    view.destroy();
  });

  it("renders read-only without the add/remove affordances", () => {
    const view = mount(DOC, "visible", true);
    expect(panel(view)).not.toBeNull();
    expect(view.dom.querySelector(".prop-add")).toBeNull();
    expect(view.dom.querySelector(".prop-remove")).toBeNull();
    view.destroy();
  });

  it("renders a frontmatter-only note (the block is the whole document)", () => {
    const view = mount("---\nstatus: draft\n---");
    expect(names(view)).toEqual(["status"]);
    view.destroy();
  });

  // ---- The remount regression (see the module note) -------------------------

  it("keeps the SAME host node through a body edit and a property edit", () => {
    const view = mount(DOC);
    const host = panel(view);
    expect(host).not.toBeNull();

    view.dispatch({ changes: { from: view.state.doc.length, insert: " More." } });
    expect(panel(view)).toBe(host);

    // A different property changing — what a teammate's edit looks like.
    const at = view.state.doc.toString().indexOf("draft");
    view.dispatch({ changes: { from: at, to: at + 5, insert: "final" } });
    expect(panel(view)).toBe(host);
    expect(
      view.dom.querySelectorAll<HTMLInputElement>(".prop-input")[0]?.value,
    ).toBe("final");
    view.destroy();
  });

  it("changes only the edited bytes when a value is committed", () => {
    const src = [
      "---",
      "# a comment",
      "title: 'Old name'",
      "tags: [a, b]",
      "done: false",
      "---",
      "",
      "Body.",
    ].join("\n");
    const view = mount(src);
    // A real click, not a synthesized `change`: React routes a checkbox's
    // onChange off the click event.
    view.dom.querySelector<HTMLInputElement>(".prop-checkbox")!.click();
    expect(view.state.doc.toString()).toBe(src.replace("done: false", "done: true"));
    view.destroy();
  });
});
