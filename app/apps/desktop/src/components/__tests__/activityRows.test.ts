import { describe, expect, it } from "vitest";
import type { ReconcileItem } from "../../lib/sync/reconcileReport";
import { buildActivity } from "../activityRows";

const S = "2026-09-26T10-00-00-000Z";
const T = Date.parse("2026-09-26T10:00:00.000Z");

const reconcile: ReconcileItem[] = [
  { kind: "deletedByTeammate", docId: "d1", path: "a.md", detail: `.context/trash/${S}/a.md`, at: T + 5000 },
  { kind: "restoredFromServer", docId: "d2", path: "b.md", at: T + 1000 },
  // retried record of the same outcome
  { kind: "restoredFromServer", docId: "d2", path: "b.md", at: T + 2000 },
];
const trash = [
  {
    docId: "d9",
    relPath: "gone.md",
    deletedAt: new Date(T + 3000).toISOString(),
    deletedBy: null,
    purgeAfter: new Date(T + 86_400_000).toISOString(),
    sizeBytes: 1,
    hasUnsyncedContributions: false,
  },
];
const copies = [
  { stamp: S, relPath: "a.md", bytes: 3, modified: T }, // claimed by the reconcile row
  { stamp: "2026-09-25T09-00-00-000Z", relPath: "old.md", bytes: 3, modified: 0 },
];

describe("activity feed", () => {
  it("merges the three sources newest first", () => {
    const rows = buildActivity({ reconcile, trash, copies });
    expect(rows.map((r) => `${r.type}:${r.path}`)).toEqual([
      "reconcile:a.md",
      "trash:gone.md",
      "reconcile:b.md",
      "copy:old.md",
    ]);
  });

  it("labels rows by source and kind", () => {
    const rows = buildActivity({ reconcile, trash, copies });
    expect(rows.map((r) => r.label)).toEqual(["Deleted by a teammate", "Deleted", "Restored", "Copy"]);
  });

  it("never lists a copy twice when a reconcile row already carries it", () => {
    const rows = buildActivity({ reconcile, trash: [], copies });
    expect(rows.filter((r) => r.type === "copy").map((r) => r.path)).toEqual(["old.md"]);
  });

  it("dedupes retried reconcile records, keeping the latest", () => {
    const rows = buildActivity({ reconcile, trash: [], copies: [] });
    const b = rows.filter((r) => r.path === "b.md");
    expect(b).toHaveLength(1);
    expect(b[0].at).toBe(T + 2000);
  });

  it("is empty with no sources", () => {
    expect(buildActivity({ reconcile: [], trash: [], copies: [] })).toEqual([]);
  });
});
