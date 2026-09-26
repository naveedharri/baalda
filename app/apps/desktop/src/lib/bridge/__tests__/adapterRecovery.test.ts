// The production recovery-copy hook: a copy that lands is reported once as
// `externalEditSaved`; a failed copy reports nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ writeTrashCopy: vi.fn() }));

import * as ipc from "../../ipc";
import { createTauriBridgeIO } from "../adapter";
import { reconcileReport } from "../../sync/reconcileReport";

describe("adapter saveRecoveryCopy", () => {
  beforeEach(() => reconcileReport.clear());

  it("records externalEditSaved with the trash path", async () => {
    vi.mocked(ipc.writeTrashCopy).mockResolvedValue(".context/trash/s/note.md" as never);
    const dest = await createTauriBridgeIO().saveRecoveryCopy!("note.md", "text");
    expect(dest).toBe(".context/trash/s/note.md");
    expect(reconcileReport.items()).toEqual([
      expect.objectContaining({ kind: "externalEditSaved", path: "note.md", detail: dest }),
    ]);
  });

  it("records nothing when the copy fails", async () => {
    vi.mocked(ipc.writeTrashCopy).mockRejectedValue(new Error("disk full") as never);
    await expect(createTauriBridgeIO().saveRecoveryCopy!("note.md", "text")).rejects.toThrow();
    expect(reconcileReport.items()).toEqual([]);
  });
});
