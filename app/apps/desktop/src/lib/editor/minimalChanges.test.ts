import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { minimalInputChanges, trimReplacement } from "./minimalChanges";

const FRONTMATTER = "---\ntags: [a, b]\nstatus: draft\n---\n";
const BODY = "# Heading\n\nSome body text.\n";

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [minimalInputChanges] });
}

function changesOf(tr: Transaction): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    out.push([fromA, toA, text.toString()]);
  });
  return out;
}

describe("minimalInputChanges", () => {
  it("select-all + '/' that read back the frontmatter only replaces the body", () => {
    const doc = FRONTMATTER + BODY;
    const state = stateOf(doc);
    // WebKit's read-back: the widget-covered frontmatter reappears as typed text.
    const tr = state.update({
      changes: { from: 0, to: doc.length, insert: FRONTMATTER + "/" },
      selection: EditorSelection.cursor(FRONTMATTER.length + 1),
      userEvent: "input.type",
    });
    expect(tr.state.doc.toString()).toBe(FRONTMATTER + "/");
    expect(changesOf(tr)).toEqual([[FRONTMATTER.length, doc.length, "/"]]);
    expect(tr.state.selection.main.head).toBe(FRONTMATTER.length + 1);
    expect(tr.isUserEvent("input.type")).toBe(true);
  });

  it("trims an unchanged tail too (a retyped closing marker)", () => {
    const doc = "a **bold** b";
    const state = stateOf(doc);
    const tr = state.update({
      changes: { from: 2, to: 10, insert: "**bolder**" },
      userEvent: "input.type",
    });
    expect(tr.state.doc.toString()).toBe("a **bolder** b");
    expect(changesOf(tr)).toEqual([[8, 8, "er"]]);
  });

  it("leaves a plain keystroke alone", () => {
    const state = stateOf("abc");
    const tr = state.update({ changes: { from: 1, insert: "x" }, userEvent: "input.type" });
    expect(tr.state.doc.toString()).toBe("axbc");
    expect(changesOf(tr)).toEqual([[1, 1, "x"]]);
  });

  it("still lets a user empty the note", () => {
    const doc = FRONTMATTER + BODY;
    const state = stateOf(doc);
    const tr = state.update({
      changes: { from: 0, to: doc.length, insert: "x" },
      userEvent: "input.type",
    });
    expect(tr.state.doc.toString()).toBe("x");
    expect(changesOf(tr)).toEqual([[0, doc.length, "x"]]);
  });

  it("does not touch non-typing transactions (remote, paste, programmatic)", () => {
    const doc = FRONTMATTER + BODY;
    for (const userEvent of [undefined, "input.paste", "delete", "input.type.compose"]) {
      const tr = stateOf(doc).update({
        changes: { from: 0, to: doc.length, insert: FRONTMATTER + "/" },
        ...(userEvent ? { userEvent } : {}),
      });
      expect(changesOf(tr)).toEqual([[0, doc.length, FRONTMATTER + "/"]]);
    }
  });

  it("trims every change of a multi-cursor transaction and keeps the document", () => {
    const doc = "one two three";
    const state = stateOf(doc);
    const tr = state.update({
      changes: [
        { from: 0, to: 3, insert: "onE" },
        { from: 8, to: 13, insert: "thrEe" },
      ],
      userEvent: "input.type",
    });
    expect(tr.state.doc.toString()).toBe("onE two thrEe");
    expect(changesOf(tr)).toEqual([
      [2, 3, "E"],
      [11, 12, "E"],
    ]);
  });

  it("never splits a surrogate pair", () => {
    // 😀 = 😀, 😁 = 😁: same high surrogate.
    expect(trimReplacement("a😀b", "a😁b")).toEqual({ head: 1, tail: 1 });
    const state = stateOf("a😀b");
    const tr = state.update({ changes: { from: 0, to: 4, insert: "a😁b" }, userEvent: "input.type" });
    expect(tr.state.doc.toString()).toBe("a😁b");
    expect(changesOf(tr)).toEqual([[1, 3, "😁"]]);
  });

  it("resulting documents always match an untrimmed apply", () => {
    const cases: Array<[string, number, number, string]> = [
      ["aaaa", 0, 4, "aa"],
      ["abab", 1, 3, "ba"],
      ["xyz", 0, 3, "xyz"],
      ["hello world", 0, 11, "hello there world"],
      ["", 0, 0, "new"],
    ];
    for (const [doc, from, to, insert] of cases) {
      const expected = doc.slice(0, from) + insert + doc.slice(to);
      const tr = stateOf(doc).update({ changes: { from, to, insert }, userEvent: "input.type" });
      expect(tr.state.doc.toString()).toBe(expected);
    }
  });
});
