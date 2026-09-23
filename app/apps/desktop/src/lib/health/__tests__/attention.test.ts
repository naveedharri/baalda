import { describe, expect, it, vi } from "vitest";
import { actionNeededCount, localFilesBytes, runEach } from "../attention";
import type { HealthFailures } from "../model";
import type { VaultStats } from "../types";

const failures = (over: Partial<HealthFailures> = {}): HealthFailures => ({
  registry: [],
  content: [],
  limitCode: null,
  ...over,
});

describe("actionNeededCount (Health nav badge)", () => {
  it("is zero with nothing reported", () => {
    expect(actionNeededCount(failures())).toBe(0);
    expect(actionNeededCount(null)).toBe(0);
  });

  it("counts only failures a person has to resolve", () => {
    expect(
      actionNeededCount(
        failures({
          content: [
            { docId: "a", relPath: "a.md", reason: "too big", permanent: true, kind: "too-large" },
            { docId: "b", relPath: "b.md", reason: "read-only", permanent: true, kind: "no-write-access" },
            // Transient: a timeout or failed push retries by itself.
            { docId: "c", relPath: "c.md", reason: "timeout" },
            { docId: "d", relPath: "d.md", reason: "push failed", permanent: false },
          ],
          registry: [
            { kind: "orphan", path: "e.md", docId: "e", reason: "left on disk", code: null },
            { kind: "note", path: "f.md", docId: null, reason: "HTTP 500", code: null },
            { kind: "folder", path: "g", docId: null, reason: "timeout", code: null },
            { kind: "inbound-blocked", path: "h.md", docId: "h", reason: "cap", code: null },
          ],
        }),
      ),
    ).toBe(3);
  });

  it("hides the badge when only retrying failures remain", () => {
    expect(
      actionNeededCount(
        failures({
          content: [{ docId: "c", relPath: "c.md", reason: "timeout" }],
          registry: [{ kind: "materialize", path: "x.md", docId: "x", reason: "EACCES", code: null }],
        }),
      ),
    ).toBe(0);
  });
});

describe("localFilesBytes", () => {
  it("adds attachments and standalone files, never note text", () => {
    const stats = {
      notes: { count: 3, bytes: 9_000_000, empty: 0 },
      attachments: { count: 2, bytes: 1024 },
      otherFiles: { count: 4, bytes: 2048 },
      index: { bytes: 70_000 },
      history: { bytes: 50_000 },
    } as unknown as VaultStats;
    expect(localFilesBytes(stats)).toBe(3072);
    expect(localFilesBytes(null)).toBeNull();
  });
});

describe("runEach", () => {
  it("runs every item in order, keeps going past failures and reports progress", async () => {
    const seen: string[] = [];
    const progress = vi.fn();
    const out = await runEach(
      ["a.md", "b.md", "c.md"],
      async (p) => {
        seen.push(p);
        if (p === "b.md") throw new Error("refused");
      },
      progress,
    );
    expect(seen).toEqual(["a.md", "b.md", "c.md"]);
    expect(out).toEqual({ done: 3, total: 3, failed: [{ path: "b.md", reason: "refused" }] });
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
});

import { dedupeDifferences, issueGroupTitle, issueRowSentence } from "../attention";
import type { HealthInventory } from "../types";

describe("dedupeDifferences", () => {
  const inv: HealthInventory = {
    local: { notes: 3, folders: 2, files: 1, total: 6 },
    localReady: true,
    server: { notes: 1, folders: 1, files: 0, total: 2 },
    serverState: "current",
    deviceOnlyNotes: ["A.md", "b.md", "c.md"],
    serverOnlyNotes: ["Remote.md"],
    deviceOnlyFolders: ["Projects/Launch", "Keep"],
    serverOnlyFolders: [],
    deviceOnlyFiles: ["x.pdf"],
    serverOnlyFiles: [],
  };

  it("drops every path an issue already lists, case-insensitively, folders too", () => {
    const out = dedupeDifferences(inv, [
      { path: "a.md" }, { path: "C.md" }, { path: "projects/launch" }, { path: "x.pdf" }, { path: null },
    ]);
    expect(out.deviceOnlyNotes).toEqual(["b.md"]);
    expect(out.deviceOnlyFolders).toEqual(["Keep"]);
    expect(out.deviceOnlyFiles).toEqual([]);
    expect(out.serverOnlyNotes).toEqual(["Remote.md"]);
    // Counts on the cards are the real census, not the deduped lists.
    expect(out.local).toBe(inv.local);
  });

  it("returns the inventory untouched when no issue has a path", () => {
    expect(dedupeDifferences(inv, [{ path: null }])).toBe(inv);
  });
});

describe("issue group wording", () => {
  it("reads as a sentence with the right plural", () => {
    expect(issueGroupTitle("upload-failed", 2)).toBe("2 notes couldn't upload");
    expect(issueGroupTitle("left-behind", 3)).toBe("3 notes left on disk");
    expect(issueGroupTitle("too-large", 1)).toBe("1 note too large to sync");
    expect(issueGroupTitle("unregistered", 2)).toBe("2 notes aren't registered");
    expect(issueGroupTitle("unregistered", 1)).toBe("1 note isn't registered");
    expect(issueGroupTitle("inbound-blocked", 1)).toBe("1 local change held for safety");
  });

  it("gives path-less rows one short sentence", () => {
    expect(issueRowSentence({ kind: "no-access", title: "x" })).toBe("You don't have access to this vault");
    expect(issueRowSentence({ kind: "limit", title: "x" })).toMatch(/plan/);
  });
});
