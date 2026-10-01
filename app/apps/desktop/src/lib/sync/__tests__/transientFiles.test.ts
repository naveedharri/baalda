import { describe, expect, it } from "vitest";
import { isTransientFileName, isTransientPath } from "../../pathIdentity";
import { isSafeBlobRelPath, isSafeTreeBinaryRelPath, planBinarySync } from "../attachments";

// #265: Office's `~$Report.docx` owner file (and its `~WRL0001.tmp` save
// scratch) used to sync as a real file. Rust's walk and watcher now hide them;
// these are the sync layer's half of the same rule.

describe("transient lock files", () => {
  it("names Office and LibreOffice lock files, and nothing the user named", () => {
    expect(isTransientFileName("~$Report.docx")).toBe(true);
    expect(isTransientFileName("~WRL0001.tmp")).toBe(true);
    expect(isTransientFileName(".~lock.Report.docx#")).toBe(true);
    expect(isTransientFileName("~notes.pdf")).toBe(false);
    expect(isTransientFileName("Report~$.docx")).toBe(false);
    // Only the FILE name counts: a folder called `~$…` is not a lock file.
    expect(isTransientPath("~$Folder/Report.docx")).toBe(false);
    expect(isTransientPath("Team/~$Report.docx")).toBe(true);
  });

  it("never pulls another device's lock file onto this disk", () => {
    expect(isSafeTreeBinaryRelPath("Team/~$Report.docx")).toBe(false);
    expect(isSafeBlobRelPath("Team/~$Report.docx")).toBe(false);
    expect(isSafeTreeBinaryRelPath("Team/Report.docx")).toBe(true);
    const plan = planBinarySync(
      [],
      [{ id: "b1", relPath: "Team/~$Report.docx", sha256: "s1", docId: "f1" }],
      { docIdFor: () => null, baseFor: () => null },
    );
    expect(plan.toDownload).toEqual([]);
    // Declining the download is all it does: nothing is trashed or removed.
    expect(plan.toTrash).toEqual([]);
  });
});
