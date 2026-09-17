import { describe, expect, it, vi } from "vitest";
import {
  BinaryDeleteQueue,
  binaryDeleteCap,
  type BinaryDeleteDeps,
  type LocalBinary,
  type RemoteBlob,
} from "../binaryDeletes";

/**
 * The binary half of `#93`. Attachment identity is the content hash, so a file
 * deleted on disk and left on the server is indistinguishable from a file this
 * device is merely missing — the next pass downloads it back. These tests pin
 * the rails that make the delete stick without ever making it dangerous.
 */

interface Harness {
  queue: BinaryDeleteQueue;
  deps: BinaryDeleteDeps;
  deleted: string[];
  blobsDeleted: string[];
  moved: Array<{ id: string; relPath: string }>;
  forgotten: string[];
  movedIds: Array<[string, string]>;
  toasts: string[];
}

function harness(opts: {
  local?: LocalBinary[];
  server?: RemoteBlob[];
  /** Paths that still exist on disk when the window closes. */
  onDisk?: string[];
  fileIds?: Record<string, string>;
  live?: boolean;
  deleteFile?: (id: string) => Promise<void>;
  deleteBlob?: (id: string) => Promise<void>;
}): Harness {
  const deleted: string[] = [];
  const blobsDeleted: string[] = [];
  const moved: Array<{ id: string; relPath: string }> = [];
  const forgotten: string[] = [];
  const movedIds: Array<[string, string]> = [];
  const toasts: string[] = [];
  const onDisk = new Set(opts.onDisk ?? (opts.local ?? []).map((a) => a.relPath));
  const fileIds = { ...(opts.fileIds ?? {}) };
  const deps: BinaryDeleteDeps = {
    isCurrent: () => true,
    isLive: () => opts.live ?? true,
    exists: async (relPath) => onDisk.has(relPath),
    listLocal: async () => opts.local ?? [],
    listServer: async () => opts.server ?? [],
    fileId: (relPath) => fileIds[relPath] ?? null,
    forgetFileId: (relPath) => {
      forgotten.push(relPath);
      delete fileIds[relPath];
    },
    moveFileId: (from, to) => {
      movedIds.push([from, to]);
      fileIds[to] = fileIds[from];
      delete fileIds[from];
    },
    deleteFile:
      opts.deleteFile ??
      (async (id) => {
        deleted.push(id);
      }),
    deleteBlob:
      opts.deleteBlob ??
      (async (id) => {
        blobsDeleted.push(id);
      }),
    moveFile: async (input) => {
      moved.push(input);
    },
    notify: (text) => toasts.push(text),
    // The window never fires on its own here; every test drains explicitly.
    setTimeoutImpl: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeoutImpl: () => undefined,
  };
  return {
    queue: new BinaryDeleteQueue(deps),
    deps,
    deleted,
    blobsDeleted,
    moved,
    forgotten,
    movedIds,
    toasts,
  };
}

const blob = (id: string, relPath: string, sha256 = `sha-${id}`): RemoteBlob => ({
  id,
  relPath,
  sha256,
});

describe("binaryDeleteCap", () => {
  it("floors at five and scales with the vault", () => {
    expect(binaryDeleteCap(0)).toBe(5);
    expect(binaryDeleteCap(20)).toBe(5);
    expect(binaryDeleteCap(100)).toBe(20);
  });
});

describe("BinaryDeleteQueue", () => {
  it("deletes a tree file through its files row", async () => {
    const h = harness({
      local: [{ relPath: "Team/keep.docx", sha256: "sha-keep" }],
      server: [blob("b1", "Team/guide.pdf"), blob("b2", "Team/keep.docx", "sha-keep")],
      onDisk: ["Team/keep.docx"],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual(["file-1"]);
    expect(h.blobsDeleted).toEqual([]);
    // The registration goes with it, so a path re-used later starts clean.
    expect(h.forgotten).toEqual(["Team/guide.pdf"]);
  });

  it("deletes an attachments/ drop by blob id, never by a files row", async () => {
    const h = harness({
      server: [blob("b9", "attachments/abc.png")],
      onDisk: [],
    });
    h.queue.noteChanged("attachments/abc.png");
    await h.queue.drain();

    expect(h.blobsDeleted).toEqual(["b9"]);
    expect(h.deleted).toEqual([]);
  });

  it("leaves a blob a note still embeds (409) on the server", async () => {
    const h = harness({
      server: [blob("b9", "attachments/used.png")],
      onDisk: [],
      deleteBlob: async () => {
        throw Object.assign(new Error("still used"), { status: 409, code: "blob_referenced" });
      },
    });
    h.queue.noteChanged("attachments/used.png");
    await h.queue.drain();

    // Nothing thrown, nothing forgotten: the bytes stay, and the next pass is
    // free to bring them back down.
    expect(h.forgotten).toEqual([]);
  });

  it("cancels when the file is back by the time the window closes", async () => {
    const h = harness({
      local: [{ relPath: "Team/guide.pdf", sha256: "sha-b1" }],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: ["Team/guide.pdf"], // an unlink-and-rewrite save
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
  });

  it("pairs a rename by content and moves the files row instead", async () => {
    const h = harness({
      local: [{ relPath: "Team/guide-v2.pdf", sha256: "sha-b1" }],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: ["Team/guide-v2.pdf"],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.noteChanged("Team/guide.pdf");
    h.queue.noteChanged("Team/guide-v2.pdf");
    await h.queue.drain();

    expect(h.moved).toEqual([{ id: "file-1", relPath: "Team/guide-v2.pdf" }]);
    expect(h.movedIds).toEqual([["Team/guide.pdf", "Team/guide-v2.pdf"]]);
    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
  });

  it("refuses the whole batch when too much vanished at once", async () => {
    const gone = Array.from({ length: 6 }, (_, i) => `Team/f${i}.pdf`);
    const h = harness({
      local: [{ relPath: "Team/left.pdf", sha256: "sha-left" }],
      server: gone.map((p, i) => blob(`b${i}`, p)),
      onDisk: ["Team/left.pdf"],
      fileIds: Object.fromEntries(gone.map((p, i) => [p, `file-${i}`])),
    });
    for (const p of gone) h.queue.noteChanged(p);
    await h.queue.drain();

    // cap = max(5, ceil((1 + 6) * 0.2)) = 5, and 6 > 5.
    expect(h.deleted).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain("NOT removed from the server");
  });

  it("does nothing before the session is live", async () => {
    const h = harness({
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: [],
      fileIds: { "Team/guide.pdf": "file-1" },
      live: false,
    });
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.queue.isPending("Team/guide.pdf")).toBe(false);
  });

  it("propagates nothing for a file the server never held", async () => {
    const h = harness({ server: [], onDisk: [], fileIds: { "Team/local.pdf": "file-1" } });
    h.queue.noteChanged("Team/local.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
    expect(h.forgotten).toEqual(["Team/local.pdf"]);
  });

  it("holds the path against downloads until its window closes", async () => {
    const h = harness({ server: [blob("b1", "Team/guide.pdf")], onDisk: [] });
    h.queue.noteChanged("Team/guide.pdf");
    expect(h.queue.isPending("team/GUIDE.pdf")).toBe(true); // case-insensitive
    await h.queue.drain();
    expect(h.queue.isPending("Team/guide.pdf")).toBe(false);
  });

  it("leaves the server alone when the listings fail", async () => {
    const h = harness({ server: [blob("b1", "Team/guide.pdf")], onDisk: [] });
    const failing = vi.spyOn(h.deps, "listServer").mockRejectedValue(new Error("offline"));
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(failing).toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
  });
});

describe("suppressNext — the revocation's claim on its own echo", () => {
  it("ignores the watcher echo of a file the app removed itself", async () => {
    // The inbound plan removes a revoked binary from disk. To this queue that is
    // "gone from disk, still on the server" — the exact shape of a user delete —
    // and answering it would `DELETE /api/files/:id`, destroying the OWNER's copy
    // of a file they had only stopped sharing.
    const h = harness({
      local: [],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: [],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.suppressNext("Team/guide.pdf");
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
    expect(h.forgotten).toEqual([]);
  });

  it("spends the claim on one echo — a later delete of the same path is real", async () => {
    // Access restored, the file comes back down, the user deletes it themselves.
    // The claim was for the removal, not for the path.
    const h = harness({
      local: [],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: [],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.suppressNext("Team/guide.pdf");
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual(["file-1"]);
  });

  it("closes a window already open for the path", async () => {
    // The watcher can beat the plan: a `tree` event lands, then the revocation
    // removes the same file. The pending entry is ours now, not the user's.
    const h = harness({
      local: [],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: [],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.queue.noteChanged("Team/guide.pdf");
    expect(h.queue.isPending("Team/guide.pdf")).toBe(true);
    h.queue.suppressNext("Team/guide.pdf");
    expect(h.queue.isPending("Team/guide.pdf")).toBe(false);
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
  });

  it("matches case-insensitively, like every other path in this queue", async () => {
    const h = harness({
      local: [],
      server: [blob("b1", "Team/Guide.pdf")],
      onDisk: [],
      fileIds: { "Team/Guide.pdf": "file-1" },
    });
    h.queue.suppressNext("team/guide.pdf");
    h.queue.noteChanged("Team/Guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
  });
});
