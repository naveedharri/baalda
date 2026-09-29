import { beforeEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_DETAIL, ReadOnlyRejections, REJECTION_WINDOW_MS } from "../readOnlyRejections";
import { reconcileReport } from "../reconcileReport";

function setup(text: string | null = "my edit") {
  let clock = 1_000_000;
  const writeTrashCopy = vi.fn(async (path: string, stamp: string) => `.context/trash/${stamp}/${path}`);
  const h = new ReadOnlyRejections({
    pathOf: (docId) => (docId === "d1" ? "n.md" : null),
    localText: async () => text,
    writeTrashCopy,
    now: () => clock,
  });
  return { h, writeTrashCopy, advance: (ms: number) => (clock += ms) };
}

describe("read-only rejections", () => {
  beforeEach(() => reconcileReport.clear());

  it("saves the local text once and records keptLocally", async () => {
    const { h, writeTrashCopy } = setup();
    expect(await h.handle("d1")).toBe(true);
    expect(writeTrashCopy).toHaveBeenCalledWith("n.md", expect.any(String), "my edit");
    expect(reconcileReport.items()).toEqual([
      expect.objectContaining({ kind: "keptLocally", docId: "d1", path: "n.md", detail: READ_ONLY_DETAIL }),
    ]);
  });

  it("throttles repeats for the same doc within 60 s, then allows one more", async () => {
    const { h, writeTrashCopy, advance } = setup();
    await h.handle("d1");
    advance(5_000);
    expect(await h.handle("d1")).toBe(false);
    advance(REJECTION_WINDOW_MS);
    expect(await h.handle("d1")).toBe(true);
    expect(writeTrashCopy).toHaveBeenCalledTimes(2);
    expect(reconcileReport.items()).toHaveLength(2);
  });

  it("does nothing for an unmapped doc or empty local text", async () => {
    const a = setup();
    expect(await a.h.handle("unknown")).toBe(false);
    const b = setup("");
    expect(await b.h.handle("d1")).toBe(false);
    expect(reconcileReport.items()).toEqual([]);
  });

  it("a failed copy records nothing and lets the next frame retry", async () => {
    const { h, writeTrashCopy } = setup();
    writeTrashCopy.mockRejectedValueOnce(new Error("disk full"));
    expect(await h.handle("d1")).toBe(false);
    expect(reconcileReport.items()).toEqual([]);
    expect(await h.handle("d1")).toBe(true);
  });
});
