import { describe, expect, it } from "vitest";
import { planBinarySync, type LocalAttachment, type ServerBlob } from "../attachments";

// A PDF that sits in a folder as a standalone file, and the same PDF dropped
// into a note (`attachments/<hash>.pdf`): the drop must still go up. Teammates
// get embeds only from `attachments/` rows, so counting the folder copy as
// "already uploaded" left the embed missing on every other device.

const L = (relPath: string, sha256: string): LocalAttachment => ({ relPath, sha256 });
const S = (id: string, relPath: string | null, sha256: string, docId: string | null): ServerBlob => ({
  id,
  relPath,
  sha256,
  docId,
});
const ctx = { docIdFor: () => null, baseFor: () => null };

describe("planBinarySync: attachments/ drops", () => {
  it("uploads a drop whose bytes the server holds only as a standalone file", () => {
    const plan = planBinarySync(
      [L("attachments/1903.pdf", "s1"), L("Team/guide.pdf", "s1")],
      [S("b1", "Team/guide.pdf", "s1", "F1")],
      { ...ctx, docIdFor: (p) => (p === "Team/guide.pdf" ? "F1" : null) },
    );
    expect(plan.toUpload.map((u) => u.relPath)).toEqual(["attachments/1903.pdf"]);
  });

  it("does not re-upload a drop the server already holds as an attachments/ row", () => {
    const plan = planBinarySync([L("attachments/1903.pdf", "s1")], [S("b2", "attachments/1903.pdf", "s1", null)], ctx);
    expect(plan.toUpload).toEqual([]);
  });

  it("treats a legacy attachment row with no path as an attachments/ copy", () => {
    const plan = planBinarySync([L("attachments/1903.pdf", "s1")], [S("b3", null, "s1", null)], ctx);
    expect(plan.toUpload).toEqual([]);
  });
});
