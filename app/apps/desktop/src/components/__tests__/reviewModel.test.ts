import { beforeEach, describe, expect, it } from "vitest";
import type { ReconcileItem } from "../../lib/sync/reconcileReport";
import {
  nextPendingKey,
  pendingItems,
  planResolveAll,
  reviewItems,
  reviewState,
  withResolution,
} from "../reviewModel";

const S = "2026-09-26T10-00-00-000Z";
const items: ReconcileItem[] = [
  { kind: "deletedByTeammate", docId: "d1", path: "a.md", detail: `.context/trash/${S}/a.md`, at: 1 },
  { kind: "keptLocally", docId: "d2", path: "b.md", detail: "read-only: your edit was not accepted; a copy is in .context/trash", at: 2 },
  { kind: "renamedConflict", docId: "d3", path: "c.md", newPath: "c (2).md", at: 3 },
  { kind: "restoredFromServer", docId: "d4", path: "d.md", at: 4 },
  { kind: "folderKept", path: "F", at: 5 },
  { kind: "externalEditSaved", path: "e.md", detail: `.context/trash/${S}/e.md`, at: 6 },
  // A retried record of the first item.
  { kind: "deletedByTeammate", docId: "d1", path: "a.md", detail: `.context/trash/${S}/a.md`, at: 7 },
];

describe("review model", () => {
  beforeEach(() => reviewState.reset());

  it("lists copies and clash renames, newest first, deduped; notices are left out", () => {
    const list = reviewItems(items);
    expect(list.map((i) => i.path)).toEqual(["a.md", "e.md", "c.md"]);
    expect(list.find((i) => i.path === "c.md")?.otherPath).toBe("c (2).md");
    expect(list.find((i) => i.path === "a.md")?.copy).toEqual({ stamp: S, relPath: "a.md" });
    // Restored notes and kept folders are notices, never review items.
    expect(list.some((i) => i.kind === "restoredFromServer" || i.kind === "folderKept")).toBe(false);
  });

  it("a launch with only notices has nothing to review", () => {
    const notices: ReconcileItem[] = [
      { kind: "restoredFromServer", docId: "d4", path: "d.md", at: 1 },
      { kind: "folderKept", path: "F", at: 2 },
    ];
    expect(reviewItems(notices)).toEqual([]);
    expect(pendingItems(reviewItems(notices), new Map())).toHaveLength(0);
  });

  it("moves items from pending to resolved", () => {
    const list = reviewItems(items);
    let resolved = withResolution(new Map(), list[0].key, "skipped");
    expect(pendingItems(list, resolved)).toHaveLength(2);
    resolved = withResolution(resolved, list[1].key, "restored");
    expect(pendingItems(list, resolved).map((i) => i.path)).toEqual(["c.md"]);
  });

  it("resolve all keeps current for every pending item and counts only their copies", () => {
    const list = reviewItems(items);
    const start = withResolution(new Map(), list[0].key, "skipped"); // a.md skipped: copy kept
    const { copiesToDelete, next } = planResolveAll(list, start);
    expect(copiesToDelete).toEqual([{ stamp: S, relPath: "e.md" }]);
    expect(pendingItems(list, next)).toHaveLength(0);
    expect(next.get(list[0].key)).toBe("skipped");
    expect(next.get(list[1].key)).toBe("kept");
  });

  it("finds the next pending item, wrapping", () => {
    const list = reviewItems(items);
    const resolved = withResolution(new Map(), list[1].key, "kept");
    expect(nextPendingKey(list, resolved, list[0].key)).toBe(list[2].key);
    expect(nextPendingKey(list, resolved, list[2].key)).toBe(list[0].key);
    expect(nextPendingKey(list, planResolveAll(list, resolved).next, list[0].key)).toBeNull();
  });

  it("the session store notifies subscribers", () => {
    const seen: number[] = [];
    const off = reviewState.subscribe((m) => seen.push(m.size));
    reviewState.resolve("k", "kept");
    off();
    reviewState.resolve("k2", "kept");
    expect(seen).toEqual([1]);
    expect(reviewState.get().size).toBe(2);
  });
});
