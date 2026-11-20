import { describe, expect, it } from "vitest";
import { bulkResultLine, chunkIds, headerCheckState, pruneSelection, splitBulkTargets, toggleShown } from "../membersAccess";

describe("member selection", () => {
  it("reads the header box from the shown selectable rows", () => {
    expect(headerCheckState(["a", "b"], new Set())).toBe("none");
    expect(headerCheckState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(headerCheckState(["a", "b"], new Set(["a", "b", "z"]))).toBe("all");
  });
  it("header click ticks the shown rows, or clears them when all are on, leaving hidden ticks alone", () => {
    expect([...toggleShown(["a", "b"], new Set(["z"]))].sort()).toEqual(["a", "b", "z"]);
    expect([...toggleShown(["a", "b"], new Set(["a", "b", "z"]))]).toEqual(["z"]);
  });
  it("drops people who left and keeps the same set when nobody did", () => {
    const s = new Set(["a", "b"]);
    expect(pruneSelection(s, ["a", "b", "c"])).toBe(s);
    expect([...pruneSelection(s, ["b"])]).toEqual(["b"]);
  });
  it("splits a selection into apply / already / not allowed", () => {
    const people = [{ id: "owner", role: "owner", lvl: "edit" }, { id: "a", role: "member", lvl: "view" }, { id: "b", role: "member", lvl: "edit" }];
    const split = splitBulkTargets(people, (p) => p.role !== "owner", (p) => p.lvl === "edit");
    expect(split.apply.map((p) => p.id)).toEqual(["a"]);
    expect(split.unchanged.map((p) => p.id)).toEqual(["b"]);
    expect(split.notAllowed.map((p) => p.id)).toEqual(["owner"]);
    expect(bulkResultLine("1 person can now edit everything.", split)).toBe(
      "1 person can now edit everything. 1 person already had it. 1 person skipped: you can't change them.",
    );
  });
  it("chunks ids to the server cap", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 100)).toEqual([]);
  });
});
