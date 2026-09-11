// @vitest-environment jsdom
//
// The inline title, through a real EditorView and a real React root.
//
// The load-bearing assertion is the node-identity one: `TitleWidget.eq()`
// compares only {path, readOnly, hasFrontmatter, mode}, never document content,
// so typing in the body must reuse the SAME DOM node. If that ever regresses,
// every keystroke — yours or a teammate's — destroys the input under the caret.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";
import type { NoteHeaderOptions } from "./noteHeader";

function mount(doc: string, header?: Partial<NoteHeaderOptions>, readOnly = false) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      header: {
        path: "Notes/My Note.md",
        renameTo: async () => null,
        noteExists: async () => false,
        ...header,
      },
      extraExtensions: readOnly
        ? // Exactly what Editor.tsx's `editable` Compartment supplies.
          [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [],
    } as never),
    parent,
  });
  return view;
}

const titleInput = (view: EditorView) =>
  view.dom.querySelector<HTMLInputElement>(".inline-title-input");

describe("the inline title widget", () => {
  it("renders the note's filename stem as an input", () => {
    const view = mount("Body text.");
    expect(titleInput(view)?.value).toBe("My Note");
    view.destroy();
  });

  it("sits above the body, inset to the prose column", () => {
    const view = mount("Body text.");
    const host = view.contentDOM.querySelector(".cm-note-title");
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(view.contentDOM);
    // The shared inset class — otherwise the title's left edge is not the
    // body's left edge, which is the most visible way to get this wrong.
    expect(host!.classList.contains("cm-block-inset")).toBe(true);
    expect(host!.compareDocumentPosition(view.contentDOM.querySelector(".cm-line")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    view.destroy();
  });

  it("keeps the SAME DOM node when the body is edited", () => {
    const view = mount("Body text.");
    const before = titleInput(view);
    expect(before).not.toBeNull();
    view.dispatch({ changes: { from: view.state.doc.length, insert: " More." } });
    expect(titleInput(view)).toBe(before);
    // …and again after a selection move, which rebuilds the field's set too.
    view.dispatch({ selection: { anchor: 2 } });
    expect(titleInput(view)).toBe(before);
    view.destroy();
  });

  it("renders read-only when the state is", () => {
    const view = mount("Body text.", {}, true);
    expect(titleInput(view)?.readOnly).toBe(true);
    view.destroy();
  });

  it("renders on an empty note too — the title is always there", () => {
    // The naming affordance for a note created blank: ⌘N opens this, focused
    // and selected, and typing replaces "Untitled".
    const view = mount("");
    expect(titleInput(view)?.value).toBe("My Note");
    expect(view.contentDOM.querySelector(".cm-note-title")).not.toBeNull();
    view.destroy();
  });

  it("shows the properties affordance only when there is no frontmatter", () => {
    const plain = mount("Body text.");
    expect(plain.dom.querySelector(".inline-title-add")).not.toBeNull();
    plain.destroy();
    const withFm = mount("---\ntags: [a]\n---\nBody.");
    expect(withFm.dom.querySelector(".inline-title-add")).toBeNull();
    withFm.destroy();
  });
});
