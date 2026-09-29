import { describe, expect, it } from "vitest";
import {
  caseInsensitiveSet,
  copyActions,
  groupCopies,
  originalPathOf,
  parseTrashPath,
  reconcileCopyRef,
  siblingRecoveredPath,
  stampTime,
} from "../recoveryCopies";

const STAMP = "2026-09-26T10-00-00-000Z";

describe("parseTrashPath", () => {
  it("splits a vault-relative trash path into stamp and path", () => {
    expect(parseTrashPath(`.context/trash/${STAMP}/Team/plan.md`)).toEqual({
      stamp: STAMP,
      relPath: "Team/plan.md",
    });
  });

  it("refuses prose, traversal and malformed paths", () => {
    for (const p of [
      null,
      undefined,
      "",
      "read-only: your edit was not accepted; a copy is in .context/trash",
      ".context/trash/",
      `.context/trash/${STAMP}`,
      `.context/trash/${STAMP}/`,
      `.context/trash/${STAMP}/../secret.md`,
      `.context/trash/../x/a.md`,
      `.context/trash/.hidden/a.md`,
      `.context/trash/${STAMP}/a//b.md`,
      `Team/plan.md`,
    ]) {
      expect(parseTrashPath(p)).toBeNull();
    }
  });
});

describe("reconcileCopyRef", () => {
  const detail = `.context/trash/${STAMP}/a.md`;
  it("offers a copy only for the kinds that write one", () => {
    expect(reconcileCopyRef({ kind: "deletedByTeammate", detail })).not.toBeNull();
    expect(reconcileCopyRef({ kind: "keptLocally", detail })).not.toBeNull();
    expect(reconcileCopyRef({ kind: "externalEditSaved", detail })).not.toBeNull();
    expect(reconcileCopyRef({ kind: "restoredFromServer", detail })).toBeNull();
    expect(reconcileCopyRef({ kind: "renamedConflict", detail })).toBeNull();
    expect(reconcileCopyRef({ kind: "folderKept", detail })).toBeNull();
  });

  it("offers nothing for the read-only rejection's prose detail", () => {
    expect(
      reconcileCopyRef({ kind: "keptLocally", detail: "read-only: a copy is in .context/trash" }),
    ).toBeNull();
  });
});

describe("copyActions", () => {
  it("needs a live note for compare and replace, write access for restore", () => {
    expect(copyActions({ hasCopy: true, liveNoteExists: true, canWrite: true })).toEqual({
      open: true, compare: true, restoreReplace: true, restoreSibling: true, delete: true,
    });
    expect(copyActions({ hasCopy: true, liveNoteExists: false, canWrite: true })).toEqual({
      open: true, compare: false, restoreReplace: false, restoreSibling: true, delete: true,
    });
    expect(copyActions({ hasCopy: true, liveNoteExists: true, canWrite: false })).toEqual({
      open: true, compare: true, restoreReplace: false, restoreSibling: false, delete: true,
    });
    expect(Object.values(copyActions({ hasCopy: false, liveNoteExists: true, canWrite: true }))
      .every((v) => v === false)).toBe(true);
  });
});

describe("siblingRecoveredPath", () => {
  it("names the sibling and dedupes case-insensitively", () => {
    expect(siblingRecoveredPath("Team/plan.md", () => false)).toBe("Team/plan (recovered).md");
    const taken = caseInsensitiveSet(["team/PLAN (recovered).md", "Team/plan (recovered 2).md"]);
    expect(siblingRecoveredPath("Team/plan.md", taken)).toBe("Team/plan (recovered 3).md");
  });

  it("handles root notes, dotted stems and no extension", () => {
    expect(siblingRecoveredPath("a.b.md", () => false)).toBe("a.b (recovered).md");
    expect(siblingRecoveredPath("README", () => false)).toBe("README (recovered)");
    expect(siblingRecoveredPath("x/.hidden", () => false)).toBe("x/.hidden (recovered)");
  });
});

describe("originalPathOf", () => {
  it("strips a trash collision suffix only", () => {
    expect(originalPathOf("Team/plan (2).md")).toBe("Team/plan.md");
    expect(originalPathOf("Team/plan.md")).toBe("Team/plan.md");
    expect(originalPathOf("Team/v (final).md")).toBe("Team/v (final).md");
  });
});

describe("groupCopies", () => {
  it("groups by stamp, newest first, paths sorted", () => {
    const groups = groupCopies([
      { stamp: "s1", relPath: "b.md", bytes: 1, modified: 100 },
      { stamp: "s2", relPath: "z.md", bytes: 1, modified: 300 },
      { stamp: "s1", relPath: "a.md", bytes: 1, modified: 200 },
    ]);
    expect(groups.map((g) => g.stamp)).toEqual(["s2", "s1"]);
    expect(groups[1].copies.map((c) => c.relPath)).toEqual(["a.md", "b.md"]);
    expect(groups[1].at).toBe(200);
  });
});

describe("stampTime", () => {
  it("reads the ISO stamp the app writes", () => {
    expect(stampTime(STAMP)).toBe(Date.parse("2026-09-26T10:00:00.000Z"));
    expect(stampTime("manual")).toBeNull();
  });
});
