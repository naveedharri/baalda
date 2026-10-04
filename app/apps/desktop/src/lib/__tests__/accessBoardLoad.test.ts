// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_BOARD, decodeBoardModes, forgetAccessBoardSupport, loadAccessMap } from "../accessBoardLoad";
import { forgetServerFeatures } from "../serverFeatures";

const tree = {
  folders: [{ id: "f1", path: "Specs", color: null }, { id: "f2", path: "Specs/Old", color: null }],
  notes: [{ id: "n1", relPath: "Specs/API.md" }, { id: "n2", relPath: "Welcome.md" }],
  files: [{ id: "x1", path: "Specs/logo.png" }],
};

describe("decodeBoardModes", () => {
  it("maps one char per item in folders, notes, files order", () => {
    const m = decodeBoardModes({ ...tree, modes: "mevnv" });
    expect([...m]).toEqual([
      ["folder:f1", "mixed"],
      ["folder:f2", "open"],
      ["note:n1", "readonly"],
      ["note:n2", "private"],
      ["file:x1", "readonly"],
    ]);
  });
  it("leaves a short or unknown char unanswered instead of guessing", () => {
    const m = decodeBoardModes({ ...tree, modes: "e?v" });
    expect(m.get("folder:f1")).toBe("open");
    expect(m.has("folder:f2")).toBe(false);
    expect(m.get("note:n1")).toBe("readonly");
    expect(m.has("note:n2")).toBe(false);
    expect(m.has("file:x1")).toBe(false);
  });
});

describe("loadAccessMap", () => {
  const api = {
    getBaseUrl: vi.fn(() => "http://test.invalid"),
    getHealth: vi.fn(),
    getAccessBoard: vi.fn(),
    listAccessTree: vi.fn(async () => tree),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    forgetServerFeatures();
    forgetAccessBoardSupport();
  });

  it("uses one access-board request when the server advertises it", async () => {
    api.getHealth.mockResolvedValue({ ok: true, features: [ACCESS_BOARD] });
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "eevnn", complete: true });
    const r = await loadAccessMap(api as never, "v1", "u2");
    expect(api.getAccessBoard).toHaveBeenCalledWith("v1", "u2");
    expect(api.listAccessTree).not.toHaveBeenCalled();
    expect(r.tree).toEqual(tree);
    expect(r.modes?.get("note:n2")).toBe("private");
  });

  it("keeps today's path when the feature is absent or health is unknown", async () => {
    api.getHealth.mockResolvedValue({ ok: true, features: ["notes-with-state"] });
    expect((await loadAccessMap(api as never, "v1", "u2")).modes).toBeNull();
    forgetServerFeatures();
    api.getHealth.mockRejectedValue(new TypeError("offline"));
    expect((await loadAccessMap(api as never, "v1", "u2")).modes).toBeNull();
    expect(api.getAccessBoard).not.toHaveBeenCalled();
    expect(api.listAccessTree).toHaveBeenCalledTimes(2);
  });

  it("a 404 falls back once, then stays on the old path", async () => {
    api.getHealth.mockResolvedValue({ ok: true, features: [ACCESS_BOARD] });
    api.getAccessBoard.mockResolvedValue(null);
    expect((await loadAccessMap(api as never, "v1", "u2")).modes).toBeNull();
    expect((await loadAccessMap(api as never, "v1", "u2")).modes).toBeNull();
    expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
    expect(api.listAccessTree).toHaveBeenCalledTimes(2);
  });
});
