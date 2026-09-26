import { describe, expect, it } from "vitest";
import { formatLineChanges, lineChanges } from "../lineChanges";

describe("lineChanges", () => {
  it("is zero for equal text", () => {
    expect(lineChanges("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
    expect(formatLineChanges({ added: 0, removed: 0 })).toBe("No differences");
  });

  it("counts whole added and removed lines", () => {
    expect(lineChanges("a\nb\nc\n", "a\nc\nd\ne\n")).toEqual({ added: 2, removed: 1 });
  });

  it("counts a changed line as one removed and one added", () => {
    expect(lineChanges("one\ntwo\n", "one\nTWO\n")).toEqual({ added: 1, removed: 1 });
  });

  it("handles an empty side and a missing final newline", () => {
    expect(lineChanges("", "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(lineChanges("a\nb", "")).toEqual({ added: 0, removed: 2 });
  });

  it("formats with a real minus sign", () => {
    expect(formatLineChanges({ added: 12, removed: 4 })).toBe("+12 \u22124 lines");
  });
});
