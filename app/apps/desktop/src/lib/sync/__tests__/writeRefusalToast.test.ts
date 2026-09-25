// A `no_write_access` create refusal has to reach the user once, like
// `root_frozen` does — it used to be recorded silently, leaving the item
// local-only with nothing on screen saying why (#217).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../toast", () => ({ toast: vi.fn() }));

import type { ApiClient } from "../../api";
import { toast } from "../../toast";
import { VaultRegistry, resetWriteRefusalNotice } from "../registry";

beforeEach(() => {
  vi.mocked(toast).mockClear();
  resetWriteRefusalNotice();
});

describe("VaultRegistry.recordFailure — no_write_access", () => {
  it("toasts once per session, however many items the server refused", () => {
    const reg = new VaultRegistry({} as ApiClient);
    for (const path of ["Team/a.md", "Team/b.md", "Team"]) {
      reg.recordFailure({ kind: "note", path, docId: null, reason: "403", code: "no_write_access" });
    }
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toContain("Team/a.md");
    expect(vi.mocked(toast).mock.calls[0][0]).toContain("Health");
    expect(reg.failures()).toHaveLength(3);
  });

  it("stays quiet for failures without that code", () => {
    const reg = new VaultRegistry({} as ApiClient);
    reg.recordFailure({ kind: "note", path: "a.md", docId: null, reason: "500", code: null });
    expect(toast).not.toHaveBeenCalled();
  });
});
