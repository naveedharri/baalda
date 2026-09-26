import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { readOnlyEditorExtensions } from "./index";

describe("readOnlyEditorExtensions", () => {
  it("is read-only and parses markdown like the editor", () => {
    const state = EditorState.create({ doc: "# Title\n\n**bold**", extensions: readOnlyEditorExtensions({ path: "a.md" }) });
    expect(state.readOnly).toBe(true);
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (n) => void names.push(n.name) });
    expect(names).toContain("ATXHeading1");
    expect(names).toContain("StrongEmphasis");
  });

  it("gives a .txt no grammar", () => {
    const state = EditorState.create({ doc: "# not a heading", extensions: readOnlyEditorExtensions({ path: "a.txt" }) });
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (n) => void names.push(n.name) });
    expect(names).not.toContain("ATXHeading1");
  });
});
