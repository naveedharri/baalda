import { beforeEach, describe, expect, it } from "vitest";
import { reconcileReport, type ReconcileItem } from "../../lib/sync/reconcileReport";
import { afterClear, parseClearedAt } from "../activityUnread";
import { pendingItems, planSkipAll, reviewItems, reviewKey } from "../reviewModel";

/** The three fixes behind "99+ forever and a banner on every launch". */

const clash = (path: string, at: number): ReconcileItem => ({
  kind: "renamedConflict",
  path,
  newPath: path.replace(".md", " (conflict 2026-09-30).md"),
  at,
});

describe("seeded review items", () => {
  beforeEach(() => reconcileReport.clear());

  it("keep the time they happened and are flagged seeded", () => {
    reconcileReport.record({ kind: "renamedConflict", path: "a.md", newPath: "a (conflict).md" }, { at: 1234, seeded: true });
    const [it0] = reconcileReport.items();
    expect(it0.at).toBe(1234);
    expect(it0.seeded).toBe(true);
  });

  it("a live record is stamped now and is not seeded", () => {
    const before = Date.now();
    reconcileReport.record({ kind: "folderKept", path: "F" });
    const [it0] = reconcileReport.items();
    expect(it0.at).toBeGreaterThanOrEqual(before);
    expect(it0.seeded).toBeUndefined();
  });

  it("an unusable seeded time falls back to now", () => {
    reconcileReport.record({ kind: "folderKept", path: "F" }, { at: 0, seeded: true });
    expect(reconcileReport.items()[0].at).toBeGreaterThan(0);
  });
});

describe("Activity → Clear", () => {
  it("hides rows up to the clear and keeps later ones", () => {
    const rows = [{ key: "a", at: 10 }, { key: "b", at: 20 }, { key: "c", at: 30 }];
    expect(afterClear(rows, 0).map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(afterClear(rows, 20).map((r) => r.key)).toEqual(["c"]);
  });

  it("parses the stored watermark defensively", () => {
    expect(parseClearedAt(null)).toBe(0);
    expect(parseClearedAt("nope")).toBe(0);
    expect(parseClearedAt("-5")).toBe(0);
    expect(parseClearedAt("1790800000000")).toBe(1790800000000);
  });

  it("marks every pending review skipped and leaves resolved ones alone", () => {
    const items = reviewItems([clash("a.md", 1), clash("b.md", 2), clash("c.md", 3)]);
    const kept = new Map([[reviewKey({ kind: "renamedConflict", path: "a.md" }), "kept" as const]]);
    const next = planSkipAll(items, kept);
    expect(pendingItems(items, next)).toEqual([]);
    expect(next.get(reviewKey({ kind: "renamedConflict", path: "a.md" }))).toBe("kept");
    expect(next.get(reviewKey({ kind: "renamedConflict", path: "b.md" }))).toBe("skipped");
  });
});
