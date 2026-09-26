import { describe, expect, it } from "vitest";
import type { ReconcileItem } from "../../lib/sync/reconcileReport";
import { buildActivity, failureEntries, heldText, shrinkText } from "../activityRows";

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

describe("activity feed: held, shrunk, access, failed", () => {
  const shrink = {
    versionId: 7,
    docId: "d5",
    relPath: "big.md",
    capturedAt: new Date(T + 4000).toISOString(),
    beforeChars: 12400,
    afterChars: 310,
    deleted: false,
  };

  it("merges every kind newest first", () => {
    const rows = buildActivity({
      reconcile: [],
      trash,
      copies: [],
      held: { count: 40, at: T + 9000 },
      shrinks: [shrink],
      access: [{ kind: "removed", at: T + 6000, vaultId: "v", docId: "d6", path: "secret.md" }],
      failures: [{ key: "fc:d7", docId: "d7", path: "x.md", reason: "boom", retryable: true, at: T + 2000 }],
    });
    expect(rows.map((r) => `${r.type}:${r.label}`)).toEqual([
      "held:Held",
      "access:Access",
      "shrunk:Shrunk",
      "trash:Deleted",
      "failed:Failed",
    ]);
  });

  it("omits an empty or absent held batch", () => {
    expect(buildActivity({ reconcile: [], trash: [], copies: [], held: { count: 0, at: T } })).toEqual([]);
    expect(buildActivity({ reconcile: [], trash: [], copies: [], held: null })).toEqual([]);
  });

  it("words the texts", () => {
    expect(shrinkText(shrink)).toBe("went from 12,400 to 310 characters");
    expect(heldText(1)).toBe("1 note vanished from disk at once");
    expect(heldText(1200)).toBe("1,200 notes vanished from disk at once");
  });

  it("flattens failures, dropping held-delete entries and marking retry", () => {
    const entries = failureEntries({
      content: [
        { docId: "c1", relPath: "c1.md", reason: "net" },
        { docId: "c2", relPath: "c2.md", reason: "too big", permanent: true },
      ],
      registry: [
        { kind: "inbound-blocked", path: "h.md", docId: "h1", reason: "held", code: "delete_decision" },
        { kind: "folder", path: "f", docId: null, reason: "nope", code: null },
      ],
      limitCode: null,
    });
    expect(entries.map((e) => [e.path, e.retryable])).toEqual([
      ["c1.md", true],
      ["c2.md", false],
      ["f", false],
    ]);
    expect(failureEntries(null)).toEqual([]);
  });
});
