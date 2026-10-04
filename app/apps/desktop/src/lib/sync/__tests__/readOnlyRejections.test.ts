import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_DETAIL,
  READ_ONLY_TOAST,
  ReadOnlyRejections,
  REJECTION_WINDOW_MS,
  isReadOnlyRejection,
  resetReadOnlyAnnouncements,
} from "../readOnlyRejections";
import { reconcileReport } from "../reconcileReport";
import { markLocalEdit, resetLocalEdits } from "../../bridge/localEdits";
import { getToasts, clearToasts } from "../../toast";

function setup(text: string | null = "my edit", edited = true) {
  let clock = 1_000_000;
  const writeTrashCopy = vi.fn(async (path: string, stamp: string) => `.context/trash/${stamp}/${path}`);
  const notify = vi.fn();
  const h = new ReadOnlyRejections({
    pathOf: (docId) => (docId === "d1" ? "n.md" : null),
    localText: async () => text,
    writeTrashCopy,
    userEdited: () => edited,
    notify,
    now: () => clock,
  });
  return { h, writeTrashCopy, notify, advance: (ms: number) => (clock += ms) };
}

describe("read-only rejections", () => {
  beforeEach(() => {
    reconcileReport.clear();
    resetReadOnlyAnnouncements();
    resetLocalEdits();
    clearToasts();
  });

  it("a real edit: saves the local text, records one entry and toasts once", async () => {
    const { h, writeTrashCopy, notify } = setup();
    expect(await h.handle("d1")).toBe(true);
    expect(writeTrashCopy).toHaveBeenCalledWith("n.md", expect.any(String), "my edit");
    expect(reconcileReport.items()).toEqual([
      expect.objectContaining({ kind: "keptLocally", docId: "d1", path: "n.md", detail: READ_ONLY_DETAIL }),
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(READ_ONLY_TOAST);
  });

  it("plain open with no edit: keeps a quiet copy, no entry, no toast", async () => {
    const { h, writeTrashCopy, notify } = setup("server text plus stale ops", false);
    expect(await h.handle("d1")).toBe(true);
    expect(writeTrashCopy).toHaveBeenCalledTimes(1);
    expect(reconcileReport.items()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a second rejected keystroke never adds a second entry or toast", async () => {
    const { h, writeTrashCopy, notify, advance } = setup();
    await h.handle("d1");
    advance(5_000);
    expect(await h.handle("d1")).toBe(false);
    advance(REJECTION_WINDOW_MS);
    expect(await h.handle("d1")).toBe(true);
    expect(writeTrashCopy).toHaveBeenCalledTimes(2);
    expect(reconcileReport.items()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a rebuilt handler (reconnect, vault switch) does not re-announce", async () => {
    await setup().h.handle("d1");
    const again = setup();
    await again.h.handle("d1");
    expect(reconcileReport.items()).toHaveLength(1);
    expect(again.notify).not.toHaveBeenCalled();
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

  it("routes to the standard auto-fading toast by default", async () => {
    markLocalEdit("d1");
    const h = new ReadOnlyRejections({
      pathOf: () => "n.md",
      localText: async () => "typed",
      writeTrashCopy: async () => ".context/trash/x",
    });
    await h.handle("d1");
    const t = getToasts();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ text: READ_ONLY_TOAST, tone: "neutral" });
    expect(t[0].ttl).toBeGreaterThan(0); // fades on its own
    expect(isReadOnlyRejection(reconcileReport.items()[0])).toBe(true);
  });
});

