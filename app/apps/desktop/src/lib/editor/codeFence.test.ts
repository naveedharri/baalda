// @vitest-environment jsdom
//
// The code-fence copy button, and the curated language list behind fences.

import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { codeLanguages } from "./codeLanguages";
import { createEditorState } from "./index";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
}

describe("code fence flair", () => {
  it("puts one copy button on a fenced block", () => {
    const view = mount("```js\nconst a = 1;\n```");
    const buttons = view.contentDOM.querySelectorAll(".cm-fence-copy");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("Copy");
    view.destroy();
  });

  it("leaves the fence line itself readable", () => {
    // The language word stays on screen: you should always be able to see and
    // edit what a fence claims to be.
    const view = mount("```python\nx = 1\n```");
    const text = Array.from(view.contentDOM.querySelectorAll(".cm-line"))
      .map((l) => l.textContent ?? "")
      .join("\n");
    expect(text).toContain("```python");
    view.destroy();
  });

  it("skips an html fence, which live preview renders instead", () => {
    const view = mount("```html\n<h1>Hi</h1>\n```");
    expect(view.contentDOM.querySelector(".cm-fence-copy")).toBeNull();
    view.destroy();
  });

  it("skips an empty fence", () => {
    const view = mount("```js\n```");
    expect(view.contentDOM.querySelector(".cm-fence-copy")).toBeNull();
    view.destroy();
  });

  it("copies the code, not the fences", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) },
    });
    const view = mount("```js\nconst a = 1;\n```");
    const button = view.contentDOM.querySelector(".cm-fence-copy") as HTMLButtonElement;
    // `cancelable`, or `preventDefault()` is a no-op and CodeMirror's own
    // mousedown handler runs — which is precisely what the widget prevents in
    // the app (`eventBelongsToEditor` bails on a defaultPrevented event).
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    // `copyText` tries the native Tauri clipboard first and falls through to
    // the web API here, so give the dynamic import a turn of the event loop.
    await new Promise((r) => setTimeout(r, 50));
    // The code, without the fence lines.
    expect(copied).toEqual(["const a = 1;"]);
    expect(button.textContent).toBe("Copied");
    view.destroy();
  });
});

describe("curated code languages", () => {
  it("covers the fences people actually paste, without @codemirror/language-data", () => {
    const names = codeLanguages.map((l) => l.name);
    for (const lang of ["javascript", "typescript", "python", "rust", "json", "yaml", "sql", "shell"]) {
      expect(names).toContain(lang);
    }
  });

  it("resolves the common aliases", () => {
    const find = (alias: string) =>
      codeLanguages.find((l) => l.name === alias || l.alias.includes(alias))?.name;
    expect(find("ts")).toBe("typescript");
    expect(find("bash")).toBe("shell");
    expect(find("py")).toBe("python");
    expect(find("yml")).toBe("yaml");
  });

  it("loads a grammar lazily, so none of them is on the startup path", async () => {
    // A language no other test in this file mounts, so the assertion really is
    // "nothing loaded it until asked".
    const go = codeLanguages.find((l) => l.name === "go")!;
    expect(go.support).toBeUndefined();
    await go.load();
    expect(go.support).toBeDefined();
  });
});
