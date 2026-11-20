// The production recovery hook: a server win over another app's bytes is
// reported once as `externalEditSaved`, and no copy is written (decided
// 2026-11-19: nothing goes to .context/trash).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ writeTrashCopy: vi.fn() }));

import * as ipc from "../../ipc";
import { createTauriBridgeIO } from "../adapter";
import { reconcileReport } from "../../sync/reconcileReport";

describe("adapter saveRecoveryCopy", () => {
  beforeEach(() => reconcileReport.clear());

  it("records externalEditSaved and writes no copy", async () => {
    const dest = await createTauriBridgeIO().saveRecoveryCopy!("note.md", "text");
    expect(dest).toBeNull();
    expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
    expect(reconcileReport.items()).toEqual([
      expect.objectContaining({ kind: "externalEditSaved", path: "note.md" }),
    ]);
  });
});
