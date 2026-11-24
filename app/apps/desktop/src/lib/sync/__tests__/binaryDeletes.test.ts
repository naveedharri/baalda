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

  it("never deletes a file the disk listing still names, whatever its stat said", async () => {
    // 2026-09-22: 88 binaries that never left the disk lost their `files` rows
    // because a failed stat read as "deleted". The listing is the second witness.
    const shots = ["ts-shots/s-000.png", "ts-shots/s-001.png"];
    const h = harness({
      local: shots.map((relPath, i) => ({ relPath, sha256: `sha-${i}` })),
      server: shots.map((p, i) => blob(`b${i}`, p, `sha-${i}`)),
      onDisk: [], // the per-path check answered "not there" for both
      fileIds: { [shots[0]]: "file-0", [shots[1]]: "file-1" },
    });
    for (const p of shots) h.queue.noteChanged(p);
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
    expect(h.forgotten).toEqual([]);
  });

  it("reads a stat that throws as couldn't-ask, not as a delete", async () => {
    const h = harness({
      server: [blob("b1", "Team/guide.pdf")],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    h.deps.exists = async () => {
      throw new Error("IPC custom protocol failed");
    };
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.forgotten).toEqual([]);
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

  it("puts back a file someone else created (403 delete_not_creator)", async () => {
    // A member deleted the owner's file on their disk. The server refuses, so
    // the file must come back here: the mirror runs and reports it once.
    const refused: Array<[string, string | null]> = [];
    let mirrorRuns = 0;
    const h = harness({
      server: [blob("b7", "Team/owners.pdf")],
      onDisk: [],
      fileIds: { "Team/owners.pdf": "file-7" },
      deleteFile: async () => {
        throw Object.assign(new Error("not yours"), {
          status: 403,
          body: { error: "Only the creator", code: "delete_not_creator" },
        });
      },
    });
    h.deps.onNotCreator = (relPath, id) => refused.push([relPath, id]);
    h.deps.onServerChanged = () => mirrorRuns++;
    h.queue.noteChanged("Team/owners.pdf");
    await h.queue.drain();

    expect(refused).toEqual([["Team/owners.pdf", "file-7"]]);
    expect(h.forgotten).toEqual([]);
    expect(mirrorRuns).toBe(1);
  });

  it("runs the mirror after a 409 so an embedded file comes back down", async () => {
    let mirrorRuns = 0;
    const h = harness({
      server: [blob("b9", "attachments/used.png")],
      onDisk: [],
      deleteBlob: async () => {
        throw Object.assign(new Error("still used"), { status: 409, code: "blob_referenced" });
      },
    });
    h.deps.onServerChanged = () => mirrorRuns++;
    h.queue.noteChanged("attachments/used.png");
    await h.queue.drain();
    expect(mirrorRuns).toBe(1);
  });

  it("does not run the mirror after an unrelated failure", async () => {
    let mirrorRuns = 0;
    const refused: string[] = [];
    const h = harness({
      server: [blob("b8", "Team/x.pdf")],
      onDisk: [],
      fileIds: { "Team/x.pdf": "file-8" },
      deleteFile: async () => {
        throw Object.assign(new Error("offline"), { status: 503 });
      },
    });
    h.deps.onNotCreator = (p) => refused.push(p);
    h.deps.onServerChanged = () => mirrorRuns++;
    h.queue.noteChanged("Team/x.pdf");
    await h.queue.drain();
    expect(refused).toEqual([]);
    expect(mirrorRuns).toBe(0);
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

  it("keeps a file the notes beside it were held for, and waits while they are decided", async () => {
    // A folder deleted in Finder: its notes went over the cap and come back, so
    // its one file must not be deleted for everyone in the same breath.
    const h = harness({
      server: [blob("b1", "Docs/names.yml"), blob("b2", "Other/x.pdf")],
      onDisk: [],
      fileIds: { "Docs/names.yml": "file-1", "Other/x.pdf": "file-2" },
    });
    let verdict: "wait" | "held" | null = "wait";
    h.deps.noteDeleteVerdict = (p) => (p.startsWith("Docs/") ? verdict : null);
    h.queue.noteChanged("Docs/names.yml");
    h.queue.noteChanged("Other/x.pdf");
    await h.queue.drain();
    // Undecided: nothing sent, and both stay pending (never downloaded back yet).
    expect(h.deleted).toEqual([]);
    expect(h.queue.isPending("Docs/names.yml")).toBe(true);
    expect(h.queue.isPending("Other/x.pdf")).toBe(true);

    verdict = "held";
    await h.queue.drain();
    // Held beside the notes: left on the server; the unrelated file goes.
    expect(h.deleted).toEqual(["file-2"]);
    expect(h.queue.isPending("Docs/names.yml")).toBe(false);
  });

  it("deletes a file once the notes beside it were decided below the cap", async () => {
    const h = harness({
      server: [blob("b1", "Docs/names.yml")],
      onDisk: [],
      fileIds: { "Docs/names.yml": "file-1" },
    });
    let verdict: "wait" | "held" | null = "wait";
    h.deps.noteDeleteVerdict = () => verdict;
    h.queue.noteChanged("Docs/names.yml");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);
    verdict = null;
    await h.queue.drain();
    expect(h.deleted).toEqual(["file-1"]);
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

  it("propagates nothing for an unregistered file the server never held", async () => {
    const h = harness({ server: [], onDisk: [] });
    h.queue.noteChanged("Team/local.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
    expect(h.forgotten).toEqual(["Team/local.pdf"]);
  });

  it("removes the byte-less files row of a file that vanished before its upload", async () => {
    // Registered (the row is minted before the bytes), then gone from disk
    // before the upload ran: the row used to outlive it forever, with nothing
    // behind it for any device to download.
    const h = harness({ server: [], onDisk: [], fileIds: { "Team/local.pdf": "file-1" } });
    h.queue.noteChanged("Team/local.pdf");
    await h.queue.drain();

    expect(h.deleted).toEqual(["file-1"]);
    expect(h.blobsDeleted).toEqual([]);
    expect(h.forgotten).toEqual(["Team/local.pdf"]);
  });

  it("holds byte-less rows to the same blast-radius cap", async () => {
    const fileIds: Record<string, string> = {};
    for (let i = 0; i < 6; i++) fileIds[`scratch/t${i}.jpg`] = `file-${i}`;
    const h = harness({ server: [], onDisk: [], fileIds });
    for (const p of Object.keys(fileIds)) h.queue.noteChanged(p);
    await h.queue.drain();

    expect(h.deleted).toEqual([]);
    expect(h.toasts).toHaveLength(1);
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

  it("keeps a candidate whose listing failed, and pairs the rename on the next window", async () => {
    // The fork this rail exists for: the server was restarting when the window
    // closed, so the rename could not be paired. Dropping the candidate leaves
    // the new path unregistered, and the blob mirror gives it a SECOND `files`
    // row — one file, two doc_ids, the ACL on whichever the blob bound to.
    const h = harness({
      local: [{ relPath: "Team/guide-v2.pdf", sha256: "sha-b1" }],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: ["Team/guide-v2.pdf"],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    const listing = vi
      .spyOn(h.deps, "listServer")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    h.queue.noteChanged("Team/guide.pdf");
    h.queue.noteChanged("Team/guide-v2.pdf");
    await h.queue.drain();

    expect(listing).toHaveBeenCalled();
    expect(h.moved).toEqual([]);
    // Still undecided — and the upload side must not register the new path
    // while it is.
    expect(h.queue.isPending("Team/guide.pdf")).toBe(true);
    expect(h.queue.hasUnsettled()).toBe(true);

    await h.queue.drain();
    expect(h.moved).toEqual([{ id: "file-1", relPath: "Team/guide-v2.pdf" }]);
    expect(h.deleted).toEqual([]);
    expect(h.queue.hasUnsettled()).toBe(false);
  });

  it("gives up after three failed windows rather than pinning the path forever", async () => {
    const h = harness({ server: [blob("b1", "Team/guide.pdf")], onDisk: [] });
    vi.spyOn(h.deps, "listServer").mockRejectedValue(new Error("offline"));
    h.queue.noteChanged("Team/guide.pdf");
    await h.queue.drain();
    await h.queue.drain();
    expect(h.queue.isPending("Team/guide.pdf")).toBe(true);
    await h.queue.drain();

    expect(h.queue.isPending("Team/guide.pdf")).toBe(false);
    expect(h.queue.hasUnsettled()).toBe(false);
    expect(h.deleted).toEqual([]);
  });

  it("holds a delete made offline, uncounted, and sends it once the server is back", async () => {
    // Three failed listings while offline used to give up, and the deleted file
    // was downloaded back on reconnect.
    const h = harness({ server: [blob("b1", "Team/guide.pdf")], onDisk: [], fileIds: { "Team/guide.pdf": "file-1" } });
    let offline = true;
    h.deps.isOffline = () => offline;
    const queue = new BinaryDeleteQueue(h.deps);
    queue.noteChanged("Team/guide.pdf");
    for (let i = 0; i < 5; i++) await queue.drain();
    expect(queue.isPending("Team/guide.pdf")).toBe(true);
    expect(h.deleted).toEqual([]);

    offline = false;
    queue.resume();
    await queue.drain();
    expect(h.deleted).toEqual(["file-1"]);
    expect(queue.isPending("Team/guide.pdf")).toBe(false);
  });

  it("keeps the candidate when the server refuses the rename's move", async () => {
    // Same fork, one step later: the pairing was right and the move failed. The
    // new path is unregistered either way, so the candidate waits.
    const h = harness({
      local: [{ relPath: "Team/guide-v2.pdf", sha256: "sha-b1" }],
      server: [blob("b1", "Team/guide.pdf")],
      onDisk: ["Team/guide-v2.pdf"],
      fileIds: { "Team/guide.pdf": "file-1" },
    });
    const move = vi.spyOn(h.deps, "moveFile").mockRejectedValueOnce(new Error("503"));
    h.queue.noteChanged("Team/guide.pdf");
    h.queue.noteChanged("Team/guide-v2.pdf");
    await h.queue.drain();

    expect(move).toHaveBeenCalled();
    expect(h.movedIds).toEqual([]);
    expect(h.queue.hasUnsettled()).toBe(true);

    await h.queue.drain();
    expect(h.movedIds).toEqual([["Team/guide.pdf", "Team/guide-v2.pdf"]]);
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

  it("a second report of a removal the app made itself is not a delete either (#420)", async () => {
    // The claim above is spent by the FIRST event for the path. A watcher that
    // reports the same removal twice used to turn the second report into
    // `DELETE /api/files/:id`. The registry's own-removal mark is not spent.
    const owned = new Set(["Examples/Trekking Routes.pdf"]);
    const h = harness({
      local: [],
      server: [blob("b1", "Examples/Trekking Routes.pdf")],
      onDisk: [],
      fileIds: { "Examples/Trekking Routes.pdf": "file-1" },
    });
    h.deps.isOwnRemoval = (relPath) => owned.has(relPath);
    h.queue.suppressNext("Examples/Trekking Routes.pdf");
    h.queue.noteChanged("Examples/Trekking Routes.pdf");
    h.queue.noteChanged("Examples/Trekking Routes.pdf");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);

    // A window opened BEFORE the mark is judged at the drain too.
    owned.clear();
    h.queue.noteChanged("Examples/Trekking Routes.pdf");
    owned.add("Examples/Trekking Routes.pdf");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);

    // Once the file is the user's again, their delete goes through.
    owned.clear();
    h.queue.noteChanged("Examples/Trekking Routes.pdf");
    await h.queue.drain();
    expect(h.deleted).toEqual(["file-1"]);
  });

  it("the old name of a file the app moved itself is never a delete", async () => {
    // A teammate moved a folder; this device followed the move. A blob pass
    // whose listings were read mid-move mapped the old name to the file's id
    // again, so the old name vanishing looked like this user deleting it, and
    // `DELETE /api/files/:id` removed the moved file for everyone.
    const moved = new Set(["Old/small-12.csv"]);
    const h = harness({
      local: [],
      server: [blob("b1", "Old/small-12.csv")],
      onDisk: [],
      fileIds: { "Old/small-12.csv": "file-1" },
    });
    h.deps.isOwnMoveSource = (relPath) => moved.has(relPath);
    h.queue.noteChanged("Old/small-12.csv");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);

    // A window opened before the mark is judged at the drain too.
    moved.clear();
    h.queue.noteChanged("Old/small-12.csv");
    moved.add("Old/small-12.csv");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);

    // Once the mark has aged out, deleting a file there is a real delete.
    moved.clear();
    h.queue.noteChanged("Old/small-12.csv");
    await h.queue.drain();
    expect(h.deleted).toEqual(["file-1"]);
  });

  it("a name whose id the server holds at another path is a stale mapping, not a delete", async () => {
    // The own-move mark can be gone (aged out, another device's pass). The
    // server listing is the evidence that does not age: the id moved.
    const stale: string[] = [];
    const h = harness({
      local: [],
      server: [{ ...blob("b1", "New/small-12.csv"), docId: "file-1" }],
      onDisk: [],
      fileIds: { "Old/small-12.csv": "file-1", "New/small-12.csv": "file-1" },
    });
    h.deps.forgetStalePath = (relPath) => stale.push(relPath);
    h.queue.noteChanged("Old/small-12.csv");
    await h.queue.drain();
    expect(h.deleted).toEqual([]);
    expect(h.blobsDeleted).toEqual([]);
    expect(stale).toEqual(["Old/small-12.csv"]);

    // The same id at THIS path on the server is an ordinary delete.
    const h2 = harness({
      local: [],
      server: [{ ...blob("b1", "Old/small-12.csv"), docId: "file-1" }],
      onDisk: [],
      fileIds: { "Old/small-12.csv": "file-1" },
    });
    h2.queue.noteChanged("Old/small-12.csv");
    await h2.queue.drain();
    expect(h2.deleted).toEqual(["file-1"]);
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
