import { describe, expect, it } from "vitest";
import { AttachmentSync, HELD_FILES_RETRY_MS, planBinarySync, type AttachmentSyncDeps, type LocalAttachment, type ServerBlob } from "../attachments";

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

describe("planBinarySync — revoked files", () => {
  // A revocation removes files one by one; a pass in between saw a known file
  // the server no longer lists and uploaded it as new, a refused request each.
  const P = "Team/report.pdf";

  it("a known file the server named as revoked is neither uploaded nor held", () => {
    const plan = planBinarySync([L(P, "v1"), L("Team/new.pdf", "v2")], [], {
      docIdFor: (p) => (p === P ? "F1" : null),
      baseFor: () => null,
      isRevoked: (id) => id === "F1",
    });
    expect(plan.toUpload.map((u) => u.relPath)).toEqual(["Team/new.pdf"]);
    expect(plan.held).toEqual([]);
    expect(plan.toTrash).toEqual([]);
  });

  it("a known file NOT named revoked still uploads (a row minted before its bytes)", () => {
    const plan = planBinarySync([L(P, "v1")], [], {
      docIdFor: () => "F1",
      baseFor: () => null,
      isRevoked: () => false,
    });
    expect(plan.toUpload.map((u) => u.relPath)).toEqual([P]);
  });

  it("a revoked id the listing names again (access back) is an ordinary file", () => {
    const plan = planBinarySync([L(P, "v1")], [S("b1", P, "v1", "F1")], {
      docIdFor: () => "F1",
      baseFor: () => null,
      isRevoked: () => true,
    });
    expect(plan.agreed).toHaveLength(1);
    expect(plan.toUpload).toEqual([]);
  });
});

describe("planBinarySync — the deleted-files listing failed", () => {
  it("a known file the server no longer lists waits instead of uploading", () => {
    const P = "Team/report.pdf";
    const plan = planBinarySync([L(P, "v1"), L("Team/new.pdf", "v2")], [], {
      docIdFor: (p) => (p === P ? "F1" : null),
      baseFor: () => null,
      tombstonesUnknown: true,
    });
    expect(plan.toTrash).toEqual([]);
    expect(plan.toUpload.map((u) => u.relPath)).toEqual(["Team/new.pdf"]);
  });
});

describe("removing files a teammate deleted", () => {
  it("asks for a registry pass once it removed some, so the folders they emptied go too", async () => {
    const removed: string[] = [];
    let asked = 0;
    const deps = {
      listLocal: async () => [],
      readLocal: async () => new Uint8Array(),
      writeLocal: async () => {},
      listServer: async () => [],
      uploadServer: async () => {},
      downloadServer: async () => new Uint8Array(),
      removeLocal: async (p: string) => void removed.push(p),
      deletedFilesRemoved: () => void asked++,
    } as unknown as AttachmentSyncDeps;
    const sync = new AttachmentSync(deps) as unknown as {
      trashTombstoned(items: Array<{ local: LocalAttachment; docId: string }>): Promise<void>;
    };
    await sync.trashTombstoned([]);
    expect(asked).toBe(0);
    await sync.trashTombstoned([
      { local: L("Gone/a.png", "s1"), docId: "F1" },
      { local: L("Gone/b.png", "s2"), docId: "F2" },
    ]);
    expect(removed).toEqual(["Gone/a.png", "Gone/b.png"]);
    expect(asked).toBe(1);
  });
});

describe("a pass whose deleted-files listing fails", () => {
  function pass(listingStatus: number) {
    const uploads: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const local = [
      { relPath: "Team/known.pdf", sha256: "k1", size: 1 },
      { relPath: "Team/new.pdf", sha256: "n1", size: 1 },
    ];
    const deps = {
      listLocal: async () => local,
      readLocal: async () => new Uint8Array([1]),
      writeLocal: async () => {},
      listServer: async () => [],
      uploadServer: async (relPath: string) => void uploads.push(relPath),
      downloadServer: async () => new Uint8Array(),
      knownFileId: (p: string) => (p === "Team/known.pdf" ? "F1" : null),
      listFileTombstones: async () => {
        throw Object.assign(new Error("listing failed"), { status: listingStatus });
      },
    } as unknown as AttachmentSyncDeps;
    const sync = new AttachmentSync(
      deps,
      400,
      (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      () => {},
    );
    return { sync, uploads, timers };
  }

  it("holds a known file the server no longer lists, uploads a new one, and asks again later", async () => {
    const h = pass(500);
    await h.sync.reconcile();
    expect(h.uploads).toEqual(["Team/new.pdf"]);
    expect(h.timers.some((t) => t.ms === HELD_FILES_RETRY_MS)).toBe(true);
  });

  it("keeps the older behaviour on a server with no listing (404)", async () => {
    const h = pass(404);
    await h.sync.reconcile();
    expect([...h.uploads].sort()).toEqual(["Team/known.pdf", "Team/new.pdf"]);
    expect(h.timers.some((t) => t.ms === HELD_FILES_RETRY_MS)).toBe(false);
  });
});

describe("a known file the server stopped listing: ask before uploading", () => {
  // Access taken away reaches the blob listing before the revocation frame:
  // the pass used to upload every file the person had just lost, one refused
  // request each (37 in one test). The server's access check settles it.
  const P = "Team/report.pdf";
  function pass(noAccessFileIds?: AttachmentSyncDeps["noAccessFileIds"]) {
    const uploads: string[] = [];
    const asked: string[][] = [];
    const deps = {
      listLocal: async () => [L(P, "v1"), L("Team/new.pdf", "v2")],
      readLocal: async () => new Uint8Array([1, 2, 3]),
      writeLocal: async () => {},
      listServer: async () => [],
      listFileTombstones: async () => [],
      knownFileId: (p: string) => (p === P ? "F1" : null),
      uploadServer: async (relPath: string) => {
        uploads.push(relPath);
      },
      downloadServer: async () => new Uint8Array(),
      ...(noAccessFileIds
        ? {
            noAccessFileIds: async (ids: string[]) => {
              asked.push(ids);
              return noAccessFileIds(ids);
            },
          }
        : {}),
    } as unknown as AttachmentSyncDeps;
    return { sync: new AttachmentSync(deps), uploads, asked };
  }

  it("a file the server answers No access for is not uploaded", async () => {
    const t = pass(async () => new Set(["F1"]));
    await t.sync.reconcile();
    expect(t.asked).toEqual([["F1"]]);
    expect(t.uploads).toEqual(["Team/new.pdf"]);
  });

  it("no answer: the file waits for a later pass", async () => {
    const t = pass(async () => {
      throw new Error("offline");
    });
    await t.sync.reconcile();
    expect(t.uploads).toEqual(["Team/new.pdf"]);
  });

  it("still readable (a row waiting for its bytes): it uploads", async () => {
    const t = pass(async () => new Set());
    await t.sync.reconcile();
    expect([...t.uploads].sort()).toEqual(["Team/new.pdf", P]);
  });
});

describe("a file the app is removing itself never uploads", () => {
  // A revocation deletes the file, then forgets its id. A pass that listed the
  // disk a moment earlier found a file with no id and uploaded it as new: one
  // refused request each (11 in one access-loss test).
  it("skips a path marked as the app's own removal, uploads the rest", async () => {
    const uploads: string[] = [];
    const deps = {
      listLocal: async () => [L("Team/going.pdf", "v1"), L("Team/new.pdf", "v2")],
      readLocal: async () => new Uint8Array([1, 2, 3]),
      writeLocal: async () => {},
      listServer: async () => [],
      uploadServer: async (relPath: string) => void uploads.push(relPath),
      downloadServer: async () => new Uint8Array(),
      isOwnRemoval: (p: string) => p === "Team/going.pdf",
    } as unknown as AttachmentSyncDeps;
    await new AttachmentSync(deps).reconcile();
    expect(uploads).toEqual(["Team/new.pdf"]);
  });
});

describe("the access check on a server without it", () => {
  it("a 404 from the access check uploads as before instead of holding", async () => {
    const P = "Team/known.pdf";
    const uploads: string[] = [];
    const deps = {
      listLocal: async () => [L(P, "v2")],
      readLocal: async () => new Uint8Array([1, 2, 3]),
      writeLocal: async () => {},
      listServer: async () => [],
      uploadServer: async (relPath: string) => void uploads.push(relPath),
      downloadServer: async () => new Uint8Array(),
      knownFileId: (p: string) => (p === P ? "f1" : null),
      listFileTombstones: async () => [],
      noAccessFileIds: async () => {
        throw Object.assign(new Error("Not found"), { status: 404 });
      },
    } as unknown as AttachmentSyncDeps;
    await new AttachmentSync(deps).reconcile();
    expect(uploads).toEqual([P]);
  });
});
