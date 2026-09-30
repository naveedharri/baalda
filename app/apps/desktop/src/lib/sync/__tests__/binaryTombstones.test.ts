import { describe, expect, it } from "vitest";
import { planBinarySync, type LocalAttachment, type ServerBlob } from "../attachments";

// #215: a teammate's stale copy of a DELETED tree file used to be uploaded
// back (its sha is missing from the listing), undoing the delete for everyone.
// The server now names the deleted `files` ids; a local file this device knows
// by one of them is set aside, never uploaded.

const L = (relPath: string, sha256: string): LocalAttachment => ({ relPath, sha256 });
const S = (id: string, relPath: string, sha256: string, docId: string | null): ServerBlob => ({
  id,
  relPath,
  sha256,
  docId,
});

describe("planBinarySync — file tombstones", () => {
  const P = "Team/report.pdf";

  it("a local file known by a tombstoned id goes to trash, not upload", () => {
    const plan = planBinarySync([L(P, "v1")], [], {
      docIdFor: (p) => (p === P ? "F1" : null),
      baseFor: () => null,
      isTombstoned: (id) => id === "F1",
    });
    expect(plan.toUpload).toEqual([]);
    expect(plan.toTrash).toEqual([{ local: L(P, "v1"), docId: "F1" }]);
  });

  it("an unmapped file at a tombstoned path is a new file and uploads", () => {
    const plan = planBinarySync([L(P, "v2")], [], {
      docIdFor: () => null,
      baseFor: () => null,
      isTombstoned: () => true,
    });
    expect(plan.toTrash).toEqual([]);
    expect(plan.toUpload.map((u) => u.relPath)).toEqual([P]);
  });

  it("a live server row wins over a tombstone claim", () => {
    const plan = planBinarySync([L(P, "v1")], [S("b1", P, "v1", "F1")], {
      docIdFor: () => "F1",
      baseFor: () => null,
      isTombstoned: () => true,
    });
    expect(plan.toTrash).toEqual([]);
    expect(plan.agreed).toHaveLength(1);
  });

  it("without tombstone info the old upload behaviour holds", () => {
    const plan = planBinarySync([L(P, "v1")], [], {
      docIdFor: () => "F1",
      baseFor: () => null,
    });
    expect(plan.toTrash).toEqual([]);
    expect(plan.toUpload.map((u) => u.relPath)).toEqual([P]);
  });
});
