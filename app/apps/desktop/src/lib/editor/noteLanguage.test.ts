// @vitest-environment jsdom
//
// WHICH grammar a note gets, exercised through the real extension stack.
//
// The CRDT editor family grew from `.md` to md/markdown/mdx **and txt**, and a
// `.txt` is the one note format a person picks precisely BECAUSE it has no
// syntax. Handing it the markdown language turns every syntax-tree-driven
// extension loose on prose: `# eggs` in a shopping list becomes a heading,
// `*star*` folds into italics, `| a | b |` becomes a table widget the caret
// cannot enter. Nothing about that is recoverable by the user — the file looks
// wrong and there is no switch.
//
// The other half of the contract matters just as much: `.md` must be BYTE
// -identical to what it was, so both directions are pinned here.

import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";

const MARKDOWNISH = [
  "# A heading",
  "",
  "Some *emphasis* and **strong** text.",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "- [ ] a task",
].join("\n");

/** `header` is how the factory learns which file it is; omit it for "no note". */
function mount(doc: string, path?: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      ...(path
        ? {
            header: {
              path,
              renameTo: async () => null,
              noteExists: async () => false,
            },
          }
        : {}),
    } as never),
    parent,
  });
}

describe("note language", () => {
  it("renders a .md note's markdown, as it always has", () => {
    const view = mount(MARKDOWNISH, "Notes/Idea.md");
    // The table is the loudest tell: it is ALWAYS its widget (never source),
    // so its presence proves the grammar is live.
    expect(view.contentDOM.querySelector(".cm-md-table")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-task-checkbox")).not.toBeNull();
    view.destroy();
  });

  it("leaves a .txt note as plain text — no markdown decorations at all", () => {
    const view = mount(MARKDOWNISH, "Notes/Groceries.txt");
    expect(view.contentDOM.querySelector(".cm-md-table")).toBeNull();
    // `checkboxes` matches `- [ ]` with a REGEX, not the syntax tree, so it is
    // the one decoration that survives dropping the grammar — and so the one
    // that needs its own gate. Everything else falls out for free.
    expect(view.contentDOM.querySelector(".cm-task-checkbox")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-bullet")).toBeNull();
    // Every character the user typed is still there, untouched.
    expect(view.state.doc.toString()).toBe(MARKDOWNISH);
    // …and it is visible as itself: the `#` is not hidden by a heading rule.
    expect(view.contentDOM.textContent).toContain("# A heading");
    expect(view.contentDOM.textContent).toContain("**strong**");
    expect(view.contentDOM.textContent).toContain("- [ ] a task");
    view.destroy();
  });

  it("treats .markdown and .mdx as markdown too", () => {
    for (const path of ["Notes/Idea.markdown", "Notes/Idea.mdx", "Notes/Idea.MD"]) {
      const view = mount(MARKDOWNISH, path);
      expect(view.contentDOM.querySelector(".cm-md-table"), path).not.toBeNull();
      view.destroy();
    }
  });

  it("still gives a .txt its inline title — the header is not a markdown thing", () => {
    // The title above the body is the note's FILENAME (`noteHeader.ts`), so a
    // plain-text note keeps it; only the grammar goes away.
    const view = mount("plain prose", "Notes/Groceries.txt");
    expect(view.contentDOM.querySelector(".cm-note-title")).not.toBeNull();
    view.destroy();
  });

  it("keeps markdown when there is no note behind the editor", () => {
    // The version-preview view and most editor tests pass no `header`; they
    // preview markdown, and changing their default would be a silent
    // regression in a surface with no path to consult.
    const view = mount(MARKDOWNISH);
    expect(view.contentDOM.querySelector(".cm-md-table")).not.toBeNull();
    view.destroy();
  });
});
