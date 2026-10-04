// @vitest-environment jsdom
//
// A view-only note's header: the Properties panel and the inline title.
//
// Keyed on the SAME flag the body editor and the view-only banner use
// (Editor.tsx's `editable` Compartment → `EditorState.readOnly`), so every
// read-only reason (lock, Read-only posture, per-user view, a revoked grant, a
// server readOnly token) behaves identically. The load-bearing assertions:
//   1. a read-only panel has NOTHING to edit in it (no input, select, button);
//   2. a Properties-tagged transaction from a read-only state never lands, while
//      a plain one (a teammate's remote edit through yCollab) still does;
//   3. access revoked while the note is open flips the panel to static text on
//      the SAME host node, and a pending title rename is dropped, not sent.
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { addPropertyToNote } from "../../components/properties/PropertiesPanel";
import { createEditorState } from "./index";

const ro = (on: boolean) =>
  on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];

function mount(
  doc: string,
  readOnly: boolean,
  renameTo: (p: string) => Promise<string | null> = async () => null,
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const editable = new Compartment();
  let docChanges = 0;
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      header: {
        path: "Notes/My Note.md",
        mode: "visible",
        renameTo,
        noteExists: async () => false,
      },
      extraExtensions: [
        editable.of(ro(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) docChanges++;
        }),
      ],
    } as never),
    parent,
  });
  // Park the caret in the body: a caret inside the region yields to source.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const setReadOnly = (on: boolean) =>
    view.dispatch({ effects: editable.reconfigure(ro(on)) });
  return { view, setReadOnly, changes: () => docChanges };
}

const DOC = [
  "---",
  "status: draft",
  "tags: [youtube, ai]",
  "done: false",
  "---",
  "",
  "Body text.",
].join("\n");

const panel = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-note-properties");
const controls = (view: EditorView) =>
  panel(view)!.querySelectorAll("input, select, textarea, button, [contenteditable]");
const titleInput = (view: EditorView) =>
  view.dom.querySelector<HTMLInputElement>(".inline-title-input")!;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** What a keystroke looks like to React: native value setter + bubbling input. */
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
/** Click every element in the panel (SVG icons have no `.click()`). */
const clickAll = (view: EditorView) => {
  for (const el of panel(view)!.querySelectorAll("*")) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
};
const press = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("a read-only note's Properties panel", () => {
  it("renders every value as static text, with no control to edit", () => {
    const { view } = mount(DOC, true);
    expect(panel(view)).not.toBeNull();
    expect(controls(view)).toHaveLength(0);
    const text = panel(view)!.textContent ?? "";
    for (const s of ["status", "draft", "tags", "youtube", "ai", "done"]) {
      expect(text).toContain(s);
    }
    expect(view.dom.querySelectorAll(".prop-chip")).toHaveLength(2);
    expect(view.dom.querySelector(".prop-add")).toBeNull();
    view.destroy();
  });

  it("clicking anywhere in it changes nothing", () => {
    const { view, changes } = mount(DOC, true);
    const before = view.state.doc.toString();
    clickAll(view);
    press(panel(view)!, "Backspace");
    expect(view.state.doc.toString()).toBe(before);
    expect(changes()).toBe(0);
    view.destroy();
  });

  it("drops a Properties-tagged transaction before it reaches the document", () => {
    const { view, changes } = mount(DOC, true);
    const before = view.state.doc.toString();
    const at = before.indexOf("draft");
    view.dispatch({
      changes: { from: at, to: at + 5, insert: "final" },
      annotations: Transaction.userEvent.of("input.properties"),
    });
    expect(view.state.doc.toString()).toBe(before);
    expect(addPropertyToNote(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
    expect(changes()).toBe(0);
    view.destroy();
  });

  it("still applies a teammate's remote edit (untagged) to the panel", () => {
    const { view } = mount(DOC, true);
    const at = view.state.doc.toString().indexOf("draft");
    view.dispatch({ changes: { from: at, to: at + 5, insert: "final" } });
    expect(panel(view)!.textContent).toContain("final");
    view.destroy();
  });

  it("switches to static text when access is revoked while open, on the same node", () => {
    const { view, setReadOnly, changes } = mount(DOC, false);
    const host = panel(view);
    expect(controls(view).length).toBeGreaterThan(0);

    setReadOnly(true);
    expect(panel(view)).toBe(host);
    expect(controls(view)).toHaveLength(0);
    // The checkbox that used to toggle `done` is gone; nothing writes.
    clickAll(view);
    expect(changes()).toBe(0);

    setReadOnly(false);
    expect(panel(view)).toBe(host);
    expect(view.dom.querySelector(".prop-checkbox")).not.toBeNull();
    view.destroy();
  });
});

describe("an editable note's Properties panel (unchanged)", () => {
  it("keeps its inputs and commits a tagged edit", () => {
    const { view } = mount(DOC, false);
    expect(view.dom.querySelector(".prop-add")).not.toBeNull();
    expect(view.dom.querySelectorAll(".prop-input").length).toBeGreaterThan(0);
    view.dom.querySelector<HTMLInputElement>(".prop-checkbox")!.click();
    expect(view.state.doc.toString()).toBe(DOC.replace("done: false", "done: true"));
    view.destroy();
  });
});

describe("a read-only note's inline title", () => {
  it("renames on Enter when the note is editable (control)", async () => {
    const renameTo = vi.fn(async () => null);
    const { view } = mount("Body.", false, renameTo);
    typeInto(titleInput(view), "Renamed");
    await tick();
    press(titleInput(view), "Enter");
    await tick();
    await tick();
    expect(renameTo).toHaveBeenCalledWith("Notes/Renamed.md");
    view.destroy();
  });

  it("refuses a rename while read-only", async () => {
    const renameTo = vi.fn(async () => null);
    const { view } = mount("Body.", true, renameTo);
    expect(titleInput(view).readOnly).toBe(true);
    typeInto(titleInput(view), "Renamed");
    await tick();
    press(titleInput(view), "Enter");
    titleInput(view).dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await tick();
    await tick();
    expect(renameTo).not.toHaveBeenCalled();
    expect(titleInput(view).value).toBe("My Note");
    view.destroy();
  });

  it("drops a rename that was being typed when access is revoked", async () => {
    const renameTo = vi.fn(async () => null);
    const { view, setReadOnly } = mount("Body.", false, renameTo);
    const input = titleInput(view);
    typeInto(input, "Renamed");
    await tick();
    expect(input.value).toBe("Renamed");

    setReadOnly(true);
    await tick();
    expect(titleInput(view)).toBe(input);
    press(input, "Enter");
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await tick();
    await tick();
    expect(renameTo).not.toHaveBeenCalled();
    expect(input.value).toBe("My Note");
    expect(input.readOnly).toBe(true);
    view.destroy();
  });
});
