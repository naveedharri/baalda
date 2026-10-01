import { describe, expect, it } from "vitest";
import { summarizeReconcile } from "../../reconcileSummary";
import { planBinarySync, type LocalAttachment, type ServerBlob } from "../attachments";

// #215: a tree binary renamed while the app was closed kept its server row at
// the OLD name forever (its bytes are on the server, so nothing uploaded; its
// sha is local, so nothing downloaded). It is paired back by content — but only
// when certain; any doubt keeps today's behaviour (no move).

const L = (relPath: string, sha256: string): LocalAttachment => ({ relPath, sha256 });
const S = (id: string, relPath: string, sha256: string, docId: string | null): ServerBlob => ({
  id,
  relPath,
  sha256,
  docId,
});
const ctx = (bases: Record<string, string>, opts: { tomb?: string[]; ids?: Record<string, string> } = {}) => ({
  docIdFor: (p: string) => opts.ids?.[p] ?? null,
  baseFor: (d: string) => bases[d] ?? null,
  isTombstoned: (d: string) => (opts.tomb ?? []).includes(d),
});

describe("planBinarySync — renames made while the app was closed", () => {
  it("moves the row when this device had exactly those bytes for it", () => {
    const plan = planBinarySync(
      [L("New/report.pdf", "s1")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }),
    );
    expect(plan.toMove).toEqual([
      { docId: "f1", from: "Old/report.pdf", to: "New/report.pdf", sha256: "s1" },
    ]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.toDownload).toEqual([]);
    expect(plan.toReplace).toEqual([]);
  });

  it("does nothing without proof this device had the file (no base)", () => {
    const plan = planBinarySync(
      [L("Mine/report.pdf", "s1")],
      [S("b1", "Theirs/report.pdf", "s1", "f1")],
      ctx({}),
    );
    expect(plan.toMove).toEqual([]);
  });

  it("does nothing when the old path is still here (a copy, not a rename)", () => {
    const plan = planBinarySync(
      [L("Old/report.pdf", "s1"), L("Copy/report.pdf", "s1")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }),
    );
    expect(plan.toMove).toEqual([]);
  });

  it("does nothing when the pairing is ambiguous", () => {
    const twoArrivals = planBinarySync(
      [L("A/report.pdf", "s1"), L("B/report.pdf", "s1")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }),
    );
    expect(twoArrivals.toMove).toEqual([]);
    const twoRows = planBinarySync(
      [L("New/report.pdf", "s1")],
      [S("b1", "Old/a.pdf", "s1", "f1"), S("b2", "Old/b.pdf", "s1", "f2")],
      ctx({ f1: "s1", f2: "s1" }),
    );
    expect(twoRows.toMove).toEqual([]);
  });

  it("does nothing when the bytes changed, or the row was deleted", () => {
    const edited = planBinarySync(
      [L("New/report.pdf", "s2")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }),
    );
    expect(edited.toMove).toEqual([]);
    const tombstoned = planBinarySync(
      [L("New/report.pdf", "s1")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }, { tomb: ["f1"] }),
    );
    expect(tombstoned.toMove).toEqual([]);
  });

  it("does nothing when another local path already claims the row's id", () => {
    const plan = planBinarySync(
      [L("New/report.pdf", "s1"), L("Elsewhere/x.pdf", "s9")],
      [S("b1", "Old/report.pdf", "s1", "f1")],
      ctx({ f1: "s1" }, { ids: { "Elsewhere/x.pdf": "f1" } }),
    );
    expect(plan.toMove).toEqual([]);
  });
});

describe("restored-file notice wording", () => {
  it("calls restored binaries files, and notes notes", () => {
    const at = 1;
    const files = summarizeReconcile([
      { kind: "restoredFromServer", path: "Team/report.pdf", docId: "f1", at },
    ]);
    expect(files[0].text).toMatch(/^1 file you removed while offline was restored\./);
    const notes = summarizeReconcile([{ kind: "restoredFromServer", path: "a.md", docId: "n1", at }]);
    expect(notes[0].text).toMatch(/^1 note you removed/);
  });
});
