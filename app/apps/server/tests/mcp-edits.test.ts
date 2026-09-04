import { describe, expect, it } from "vitest";
import { EditError, planEdits, replacementOp } from "../src/mcp/service.js";
import { revisionOf } from "../src/mcp/doc-writer.js";

/**
 * The pure half of #78: how `edit_note` turns anchors into ops, and how
 * `update_note` shrinks a whole-body replacement to the part that changed. No
 * database — these are the rules an agent's edit lives or dies by.
 */

function apply(text: string, ops: ReturnType<typeof planEdits>): string {
  for (const op of ops) {
    text = text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteLength);
  }
  return text;
}

describe("planEdits", () => {
  const note = "# Title\n\n- one\n- two\n- three\n";

  it("replaces, inserts before/after and deletes at unique anchors, in order", () => {
    const ops = planEdits(note, [
      { type: "replace", find: "- two", replace: "- 2" },
      { type: "insert_after", anchor: "- 2", text: "\n- 2.5" },
      { type: "insert_before", anchor: "- one", text: "- zero\n" },
      { type: "delete", find: "- three\n" },
    ]);
    expect(apply(note, ops)).toBe("# Title\n\n- zero\n- one\n- 2\n- 2.5\n");
  });

  it("refuses a missing anchor with nothing planned", () => {
    expect(() => planEdits(note, [{ type: "replace", find: "- four", replace: "x" }])).toThrow(
      EditError,
    );
    expect(() => planEdits(note, [{ type: "replace", find: "- four", replace: "x" }])).toThrow(
      /not found/,
    );
  });

  it("refuses an ambiguous anchor unless the edit says all", () => {
    expect(() => planEdits(note, [{ type: "delete", find: "- " }])).toThrow(/matches 3 times/);
    expect(() => planEdits(note, [{ type: "insert_after", anchor: "- ", text: "x" }])).toThrow(
      /matches 3 times/,
    );
    const ops = planEdits(note, [{ type: "replace", find: "- ", replace: "* ", all: true }]);
    expect(apply(note, ops)).toBe("# Title\n\n* one\n* two\n* three\n");
  });

  it("a later edit sees the text as left by an earlier one", () => {
    // "- two" only exists after the first replace; without in-order semantics
    // the second edit would be refused.
    const ops = planEdits("- 2\n", [
      { type: "replace", find: "- 2", replace: "- two" },
      { type: "insert_after", anchor: "- two", text: "!" },
    ]);
    expect(apply("- 2\n", ops)).toBe("- two!\n");
  });

  it("rejects an empty anchor and an empty edit list", () => {
    expect(() => planEdits(note, [])).toThrow(EditError);
    expect(() => planEdits(note, [{ type: "delete", find: "" }])).toThrow(/non-empty/);
  });
});

describe("replacementOp", () => {
  it("touches only the changed span of a whole-body replacement", () => {
    const before = "intro\n\npara one\n\noutro\n";
    const after = "intro\n\npara ONE, edited\n\noutro\n";
    const ops = replacementOp(before, after);
    expect(ops).toEqual([
      { index: "intro\n\npara ".length, deleteLength: 3, insert: "ONE, edited" },
    ]);
    expect(apply(before, ops)).toBe(after);
  });

  it("is empty for identical text and handles pure insertions/deletions at either end", () => {
    expect(replacementOp("same", "same")).toEqual([]);
    expect(apply("abc", replacementOp("abc", "abcXYZ"))).toBe("abcXYZ");
    expect(apply("abc", replacementOp("abc", "XYZabc"))).toBe("XYZabc");
    expect(apply("abcdef", replacementOp("abcdef", "abef"))).toBe("abef");
    expect(apply("aaa", replacementOp("aaa", "aa"))).toBe("aa");
    expect(apply("", replacementOp("", "new"))).toBe("new");
    expect(apply("gone", replacementOp("gone", ""))).toBe("");
  });
});

describe("revisionOf", () => {
  it("is a stable content hash", () => {
    expect(revisionOf("x")).toBe(revisionOf("x"));
    expect(revisionOf("x")).not.toBe(revisionOf("y"));
    expect(revisionOf("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
