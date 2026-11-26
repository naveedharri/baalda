import { describe, expect, it } from "vitest";
import { dedupeReconcileItems, summarizeReconcile } from "../reconcileSummary";
import { SELF_REVOKED_DETAIL, type ReconcileItem } from "../sync/reconcileReport";

const at = 1_700_000_000_000;
const item = (i: Partial<ReconcileItem> & Pick<ReconcileItem, "kind" | "path">): ReconcileItem => ({
  at,
  ...i,
});

describe("summarizeReconcile", () => {
  it("returns nothing for no items", () => {
    expect(summarizeReconcile([])).toEqual([]);
  });

  it("writes one line per kind, with counts and plurals", () => {
    const lines = summarizeReconcile([
      item({ kind: "deletedByTeammate", path: "a.md", docId: "1" }),
      item({ kind: "deletedByTeammate", path: "b.md", docId: "2" }),
      item({ kind: "restoredFromServer", path: "c.md", docId: "3" }),
      item({ kind: "renamedConflict", path: "Notes/plan.md", newPath: "Notes/plan (2).md", docId: "4" }),
      item({ kind: "keptLocally", path: "d.md", docId: "5" }),
      item({ kind: "folderKept", path: "Projects/Q3" }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "2 notes you edited offline were deleted by a teammate. Your versions are in Trash.",
      "1 note is kept on this device only: you no longer have access.",
      "1 note you deleted didn't reach the server, so it was put back. Delete it again to remove it for everyone.",
      "1 note was renamed to avoid a clash: plan.md → plan (2).md.",
      "Folder Q3 was kept because you added notes to it.",
    ]);
    expect(lines.map((l) => l.count)).toEqual([2, 1, 1, 1, 1]);
  });

  it("uses singular wording for one and plural for many", () => {
    const one = summarizeReconcile([item({ kind: "deletedByTeammate", path: "a.md", docId: "1" })]);
    expect(one[0].text).toBe(
      "1 note you edited offline was deleted by a teammate. Your version is in Trash.",
    );
    const many = summarizeReconcile([
      item({ kind: "restoredFromServer", path: "a.md", docId: "1" }),
      item({ kind: "restoredFromServer", path: "b.md", docId: "2" }),
      item({ kind: "renamedConflict", path: "x.md", newPath: "x 2.md", docId: "3" }),
      item({ kind: "renamedConflict", path: "y.md", newPath: "y 2.md", docId: "4" }),
      item({ kind: "folderKept", path: "A" }),
      item({ kind: "folderKept", path: "B" }),
    ]);
    expect(many.map((l) => l.text)).toEqual([
      "2 notes you deleted didn't reach the server, so they were put back. Delete them again to remove them for everyone.",
      "2 notes were renamed to avoid a clash with a teammate's note.",
      "2 folders were kept because you added notes to them.",
    ]);
  });

  it("counts a repeated record of the same outcome once", () => {
    const lines = summarizeReconcile([
      item({ kind: "restoredFromServer", path: "a.md", docId: "1" }),
      item({ kind: "restoredFromServer", path: "a.md", docId: "1", at: at + 5 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].count).toBe(1);
  });
});

describe("keptLocally, read-only", () => {
  it("counts revoked attachments removed from this device", () => {
    const [line] = summarizeReconcile([
      item({ kind: "keptLocally", path: "report.pdf", detail: ".context/trash/s/report.pdf" }),
      item({ kind: "keptLocally", path: "image.png", detail: ".context/trash/s/image.png" }),
    ]);
    expect(line.count).toBe(2);
    expect(line.text).toBe("2 files were removed from this device because access was removed.");
  });
  const RO = "read-only: your edit was not accepted";
  it("does not claim lost access for a read-only rejection", () => {
    const [line] = summarizeReconcile([item({ kind: "keptLocally", path: "a.md", docId: "1", detail: RO })]);
    expect(line.text).toBe(
      "1 note is read-only for you, so your edit was not accepted.",
    );
  });
  it("keeps the access wording when nothing was read-only, and blends a mixed group", () => {
    const [plain] = summarizeReconcile([item({ kind: "keptLocally", path: "a.md", docId: "1" })]);
    expect(plain.text).toBe("1 note is kept on this device only: you no longer have access.");
    const [mixed] = summarizeReconcile([
      item({ kind: "keptLocally", path: "a.md", docId: "1" }),
      item({ kind: "keptLocally", path: "b.md", docId: "2", detail: RO }),
    ]);
    expect(mixed.text).toBe(
      "2 notes are kept on this device only: you no longer have access, or can only read them.",
    );
  });
  it("describes notes and binaries separately when one group mixes them", () => {
    const [line] = summarizeReconcile([
      item({ kind: "keptLocally", path: "a.md", docId: "1", detail: RO }),
      item({ kind: "keptLocally", path: "report.pdf", detail: ".context/trash/s/report.pdf" }),
    ]);
    expect(line.count).toBe(2);
    expect(line.text).toBe(
      "1 note is read-only for you, so your edit was not accepted. " +
        "1 file was removed from this device because access was removed.",
    );
  });
});

describe("externalEditSaved", () => {
  it("says the synced version replaced the other app's", () => {
    const one = summarizeReconcile([
      item({ kind: "externalEditSaved", path: "a.md", detail: ".context/trash/x/a.md" }),
    ]);
    expect(one.map((l) => l.text)).toEqual([
      "1 note changed by another app while you were offline could not be merged. The synced version replaced it.",
    ]);
    const two = summarizeReconcile([
      item({ kind: "externalEditSaved", path: "a.md" }),
      item({ kind: "externalEditSaved", path: "b.md" }),
    ]);
    expect(two[0].text).toBe(
      "2 notes changed by another app while you were offline could not be merged. The synced versions replaced them.",
    );
  });

  it("sorts right after the kept-on-this-device line", () => {
    const kinds = summarizeReconcile([
      item({ kind: "restoredFromServer", path: "r.md", docId: "r" }),
      item({ kind: "externalEditSaved", path: "e.md" }),
      item({ kind: "keptLocally", path: "k.md", docId: "k" }),
    ]).map((l) => l.kind);
    expect(kinds).toEqual(["keptLocally", "externalEditSaved", "restoredFromServer"]);
  });
});

describe("dedupeReconcileItems", () => {
  it("keeps the latest record per kind and doc", () => {
    const out = dedupeReconcileItems([
      item({ kind: "keptLocally", path: "a.md", docId: "1" }),
      item({ kind: "restoredFromServer", path: "a.md", docId: "1" }),
      item({ kind: "keptLocally", path: "a.md", docId: "1", at: at + 9 }),
    ]);
    expect(out.map((i) => [i.kind, i.at])).toEqual([
      ["restoredFromServer", at],
      ["keptLocally", at + 9],
    ]);
  });
});

describe("unsent changes removed with a note whose access was removed", () => {
  it("names one note, and says why", () => {
    const [line] = summarizeReconcile([{ kind: "unsentRemoved", docId: "d1", path: "Team/Plan.md", at }]);
    expect(line.text).toBe(
      "Your unsent changes to Plan.md were removed: your access to it was removed before they reached the team.",
    );
  });
  it("counts several, and leads the summary", () => {
    const lines = summarizeReconcile([
      { kind: "restoredFromServer", path: "a.md", at },
      { kind: "unsentRemoved", docId: "d1", path: "Team/A.md", at },
      { kind: "unsentRemoved", docId: "d2", path: "Team/B.md", at },
    ]);
    expect(lines[0].text).toBe(
      "Your unsent changes to 2 notes were removed: your access to them was removed before they reached the team.",
    );
  });
  it("says so plainly when the person removed their own access", () => {
    const [line] = summarizeReconcile([
      { kind: "unsentRemoved", docId: "d1", path: "Team/Plan.md", detail: SELF_REVOKED_DETAIL, at },
    ]);
    expect(line.text).toBe(
      "Your unsent changes to Plan.md were removed: you removed your own access before they reached the team.",
    );
  });
});
