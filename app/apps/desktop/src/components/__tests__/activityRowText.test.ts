import { describe, expect, it } from "vitest";
import { ACTIVITY_HINT, type ActivityRow } from "../activityRows";
import { activityRowText } from "../activityRowText";
import { clockDate } from "../../lib/health/format";

const AT = new Date(2026, 9, 8, 19, 34).getTime();
const NOW = AT + 13 * 60_000;

describe("activityRowText", () => {
  it("puts the short message on line 1, the full path on line 2 and the hint in the detail", () => {
    const row: ActivityRow = {
      type: "access",
      key: "a1",
      at: AT,
      label: "Access",
      path: "Concepts/Wikilinks and backlinks.md",
      event: { kind: "removed", at: AT, vaultId: "v", docId: "d", path: "Concepts/Wikilinks and backlinks.md", self: true },
      text: "You removed your access",
    };
    const t = activityRowText(row, NOW);
    expect(t.label).toBe("Access");
    expect(t.message).toBe("You removed your access");
    expect(t.when).toBe("13 min ago");
    expect(t.path).toBe("Concepts/Wikilinks and backlinks.md");
    expect(t.detail).toBe(ACTIVITY_HINT.access);
    expect(t.absoluteTime).toBe("19:34, 8 Oct 2026");
    // The body shows the full path once (the head hides line 2 when open).
    expect(t.bodyPaths).toEqual(["Concepts/Wikilinks and backlinks.md"]);
    expect(t.facts).toEqual([]);
  });

  it("lists a grant's paths and the remainder in the detail", () => {
    const row: ActivityRow = {
      type: "access",
      key: "g1",
      at: AT,
      label: "Access",
      path: "",
      event: { kind: "granted", at: AT, vaultId: "v", count: 21, paths: ["a.md", "b/c.md"] },
      text: "21 notes became available to you",
    };
    const t = activityRowText(row, NOW);
    expect(t.message).toBe("21 notes became available to you");
    expect(t.path).toBe("");
    expect(t.bodyPaths).toEqual(["a.md", "b/c.md"]);
    expect(t.morePaths).toBe(19);
  });

  it("names the note when a row has no sentence of its own, and capitalizes lower-case text", () => {
    const reconcile: ActivityRow = {
      type: "reconcile",
      key: "r1",
      at: AT,
      label: "Renamed",
      path: "Projects/plan.md",
      item: { kind: "renamedConflict", docId: "d", path: "Projects/plan.md", newPath: "Projects/plan (conflict 2026-10-08).md", at: AT },
    };
    const r = activityRowText(reconcile, NOW);
    expect(r.message).toBe("plan");
    expect(r.bodyPaths).toEqual([]);
    expect(r.facts).toEqual(["In Projects", "Renamed to Projects/plan (conflict 2026-10-08).md"]);

    const shrunk = {
      type: "shrunk",
      key: "s1",
      at: AT,
      label: "Shrunk",
      path: "x.md",
      event: { deleted: true },
      text: "went from 1,000 to 10 characters",
    } as unknown as ActivityRow;
    const s = activityRowText(shrunk, NOW);
    expect(s.message).toBe("Went from 1,000 to 10 characters");
    expect(s.facts).toEqual(["The note is deleted now."]);
  });

  it("moves trash facts into the detail", () => {
    const row: ActivityRow = {
      type: "trash",
      key: "t1",
      at: AT,
      label: "Deleted",
      path: "gone.md",
      item: {
        docId: "d",
        relPath: "gone.md",
        deletedAt: new Date(AT).toISOString(),
        deletedBy: { id: "u", name: "Sam" },
        purgeAfter: new Date(AT + 30 * 86_400_000).toISOString(),
        sizeBytes: 1,
        hasUnsyncedContributions: true,
      },
    } as ActivityRow;
    const t = activityRowText(row, NOW);
    expect(t.message).toBe("gone");
    expect(t.bodyPaths).toEqual([]);
    expect(t.facts[0]).toBe("Deleted by Sam");
    expect(t.facts[1]).toMatch(/^Purges on /);
    expect(t.facts[2]).toMatch(/arrived after/);
  });

  it("never repeats a named note in the body: no path, folder only, copy location without the name", () => {
    const restored: ActivityRow = {
      type: "reconcile",
      key: "r2",
      at: AT,
      label: "Restored",
      path: "AGENTS.md",
      item: { kind: "restoredFromServer", docId: "d", path: "AGENTS.md", at: AT },
    };
    const r = activityRowText(restored, NOW);
    expect(r.message).toBe("AGENTS");
    expect(r.bodyPaths).toEqual([]);
    expect(r.facts).toEqual([]);

    const kept: ActivityRow = {
      type: "reconcile",
      key: "r3",
      at: AT,
      label: "Kept on this device",
      path: "Notes/a.md",
      item: { kind: "deletedByTeammate", docId: "d", path: "Notes/a.md", detail: ".context/trash/S/Notes/a.md", at: AT },
    };
    const k = activityRowText(kept, NOW);
    expect(k.facts).toEqual(["In Notes", "Copy saved in .context/trash/S/Notes/"]);

    const copy: ActivityRow = {
      type: "copy",
      key: "c1",
      at: AT,
      label: "Copy",
      path: "old.md",
      copy: { stamp: "S", relPath: "old.md", bytes: 3, modified: 0 },
    };
    const c = activityRowText(copy, NOW);
    expect(c.message).toBe("old");
    expect(c.bodyPaths).toEqual([]);
    expect(c.facts.some((f) => f.includes("old.md"))).toBe(false);
  });

  it("drops a grant path equal to the head path and duplicates", () => {
    const row = {
      type: "access",
      key: "g2",
      at: AT,
      label: "Access",
      path: "a.md",
      event: { kind: "granted", at: AT, vaultId: "v", count: 3, paths: ["a.md", "b.md", "b.md"] },
      text: "3 notes became available to you",
    } as ActivityRow;
    expect(activityRowText(row, NOW).bodyPaths).toEqual(["b.md"]);
  });
});

describe("clockDate", () => {
  it("formats an invalid time as a dash", () => {
    expect(clockDate(Number.NaN)).toBe("—");
  });
});
