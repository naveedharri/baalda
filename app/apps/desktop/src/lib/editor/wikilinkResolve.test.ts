// @vitest-environment jsdom
//
// Unresolved wiki-links: greyed out, and a click creates nothing.
//
// The classifier must give the SAME answer as Rust `index.rs resolve_wikilink`
// (full path → basename → title, case-insensitive, `|alias` / `#heading` /
// trailing `.md` stripped), or a link would look dead but open, or look live
// and do nothing.

import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import type { NoteTitle } from "../ipc";
import { createEditorState } from "./index";
import { wikilinkTitlesChanged } from "./wikilinks";
import {
  isWikilinkResolved,
  wikilinkClickAction,
  wikilinkTarget,
} from "./wikilinkResolve";

beforeAll(() => {
  // jsdom has no layout engine; CodeMirror's mouse selection and measure pass
  // call Range#getClientRects (same stub as commands.test.ts).
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

const TITLES: NoteTitle[] = [
  { id: "a", path: "Projects/Baalda.md", title: "Baalda roadmap" },
  { id: "b", path: "Inbox.md", title: "Inbox" },
  { id: "c", path: "Journal/2026-09-25.md", title: "Friday" },
];

describe("wikilinkTarget", () => {
  it("strips alias, heading, whitespace and a trailing .md", () => {
    expect(wikilinkTarget("Note|label")).toBe("Note");
    expect(wikilinkTarget("Note#Heading")).toBe("Note");
    expect(wikilinkTarget(" Note#H|label ")).toBe("Note");
    expect(wikilinkTarget("Folder/Note.md")).toBe("Folder/Note");
  });
});

describe("isWikilinkResolved", () => {
  const ok = (inner: string) => isWikilinkResolved(inner, TITLES);

  it("resolves a note's full relative path", () => {
    expect(ok("Projects/Baalda")).toBe(true);
    expect(ok("Journal/2026-09-25")).toBe(true);
  });

  it("resolves a note's basename anywhere in the tree", () => {
    expect(ok("Baalda")).toBe(true);
    expect(ok("2026-09-25")).toBe(true);
    // Rust's basename rule ignores the folder part of the target.
    expect(ok("Elsewhere/Baalda")).toBe(true);
  });

  it("resolves a note's title", () => {
    expect(ok("Baalda roadmap")).toBe(true);
    expect(ok("Friday")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(ok("projects/BAALDA")).toBe(true);
    expect(ok("inbox")).toBe(true);
    expect(ok("baalda ROADMAP")).toBe(true);
  });

  it("strips alias and heading before resolving", () => {
    expect(ok("Inbox|my inbox")).toBe(true);
    expect(ok("Inbox#Today")).toBe(true);
    expect(ok("Nope|Inbox")).toBe(false);
  });

  it("accepts a .md suffix", () => {
    expect(ok("Inbox.md")).toBe(true);
    expect(ok("Projects/Baalda.md")).toBe(true);
  });

  it("does not resolve a target no note answers to", () => {
    expect(ok("Does not exist")).toBe(false);
    expect(ok("Projects/Nope")).toBe(false);
    expect(ok("")).toBe(false);
    expect(isWikilinkResolved("Inbox", [])).toBe(false);
  });

  it("never greys a link to a file Rust's binary fallback may open", () => {
    expect(ok("Q3 report.xlsx")).toBe(true);
    expect(ok("Reports/diagram.png")).toBe(true);
  });
});

describe("wikilinkClickAction", () => {
  it("opens a resolved link and does nothing for an unresolved one", () => {
    expect(wikilinkClickAction({ path: "Inbox.md" })).toEqual({ kind: "open", path: "Inbox.md" });
    expect(wikilinkClickAction(null)).toEqual({ kind: "none" });
    expect(wikilinkClickAction(undefined)).toEqual({ kind: "none" });
  });
});

describe("wiki-link decorations", () => {
  function mount(doc: string, titles: () => NoteTitle[], onNavigate = (_t: string) => {}) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: createEditorState({ doc, getTitles: titles, onNavigate } as never),
      parent,
    });
  }
  const linkFor = (view: EditorView, text: string) =>
    Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-wikilink")).find((el) =>
      el.textContent?.includes(text),
    );

  it("marks an unknown target unresolved and leaves a known one a plain link", () => {
    const view = mount("See [[Inbox]] and [[Ghost note]].", () => TITLES);
    const known = linkFor(view, "Inbox")!;
    const unknown = linkFor(view, "Ghost note")!;
    expect(known.className.split(/\s+/)).toContain("cm-wikilink");
    expect(known.classList.contains("cm-wikilink-unresolved")).toBe(false);
    expect(unknown.classList.contains("cm-wikilink")).toBe(true);
    expect(unknown.classList.contains("cm-wikilink-unresolved")).toBe(true);
    view.destroy();
  });

  it("repaints when the title list changes", () => {
    let titles: NoteTitle[] = [];
    const view = mount("[[Later]]", () => titles);
    expect(linkFor(view, "Later")!.classList.contains("cm-wikilink-unresolved")).toBe(true);
    titles = [{ id: "z", path: "Later.md", title: "Later" }];
    view.dispatch({ effects: wikilinkTitlesChanged.of(null) });
    expect(linkFor(view, "Later")!.classList.contains("cm-wikilink-unresolved")).toBe(false);
    view.destroy();
  });

  it("a mousedown on an unresolved link never navigates", () => {
    const calls: string[] = [];
    const view = mount("[[Ghost]] [[Inbox]]", () => TITLES, (t) => calls.push(t));
    const fire = (el: HTMLElement) =>
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    fire(linkFor(view, "Ghost")!);
    expect(calls).toEqual([]);
    fire(linkFor(view, "Inbox")!);
    expect(calls).toEqual(["Inbox"]);
    view.destroy();
  });
});
