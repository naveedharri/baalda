// A binary whose access came BACK — the file half of `ready.revoked`/`reauth`.
//
// A note that is re-shared reappears in seconds: the ACL frame asks for a
// registry pull and `planInbound` materializes the file. A `.docx` or `.pdf`
// has no such route — the blob mirror is the only thing that can pull it down,
// and the ONLY things that ever scheduled a pass were a local watcher event,
// the delete queue and the one fire-and-forget reconcile inside `enable`. So a
// re-granted binary sat missing until some unrelated file changed on disk or
// the app was restarted.
//
// Two halves are pinned here:
//
//   1. the TRIGGER — every server-side signal that can change which binaries
//      this device should hold (`reauth`, `ready.revoked`, a registry pull that
//      changed something) schedules a mirror pass;
//   2. the PROGRESS — that pass announces its downloads, so the header's
//      "Syncing n/m" counts bytes as well as documents, and badges the file's
//      path `queued` → `syncing` → `synced` even though the sidebar has no row
//      for it until it lands.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Part 1 — the mirror itself (hand-wired deps; no module mocks reach it).
// ---------------------------------------------------------------------------

import {
  AttachmentSync,
  type AttachmentSyncDeps,
  type ServerBlob,
} from "../attachments";
import type { DocSyncState } from "../vaultScope";

const REPORT = "Team/report.docx";

/** A vault with nothing on disk and whatever the server says it holds. */
function mirror(server: ServerBlob[], extra: Partial<AttachmentSyncDeps> = {}) {
  const log = {
    /** Every whole-map emission, in order. */
    states: [] as Array<Record<string, DocSyncState>>,
    /** Each `onDownloadsQueued` count. */
    announced: [] as number[],
    settled: [] as Array<"ok" | "failed">,
    written: [] as string[],
  };
  const deps: AttachmentSyncDeps = {
    listLocal: async () => [],
    readLocal: async () => new Uint8Array(),
    writeLocal: async () => {},
    writeTreeLocal: async (relPath) => {
      log.written.push(relPath);
    },
    listServer: async () => server,
    uploadServer: async () => {},
    downloadServer: async () => new Uint8Array([1, 2, 3]),
    onFileStates: (states) => {
      log.states.push({ ...states });
    },
    onDownloadsQueued: (n) => {
      log.announced.push(n);
    },
    onDownloadSettled: (outcome) => {
      log.settled.push(outcome);
    },
    ...extra,
  };
  return { sync: new AttachmentSync(deps), log };
}

describe("AttachmentSync — a download the user can see", () => {
  it("announces the wave, counts it, and badges the path before the bytes land", async () => {
    const { sync, log } = mirror([{ id: "b1", relPath: REPORT, sha256: "sha-docx" }]);

    const result = await sync.reconcile();

    expect(result.downloaded).toBe(1);
    expect(log.written).toEqual([REPORT]);
    // One announcement for the whole wave, before the first byte.
    expect(log.announced).toEqual([1]);
    expect(log.settled).toEqual(["ok"]);
    // The path is badged while it is still only on the server — there is no
    // sidebar row yet, but the roll-up credits its FOLDER, which is what makes
    // a 50 MB file arriving into `Team/` visible at all.
    const seen = log.states.map((s) => s[REPORT]);
    expect(seen).toContain("queued");
    expect(seen).toContain("syncing");
    const last = log.states[log.states.length - 1];
    expect(last?.[REPORT]).toBe("synced");
  });

  it("settles every announced file, so a failure cannot hang the counter", async () => {
    const { sync, log } = mirror([{ id: "b1", relPath: REPORT, sha256: "sha-docx" }], {
      downloadServer: async () => {
        throw new Error("offline");
      },
    });

    await sync.reconcile();

    expect(log.announced).toEqual([1]);
    expect(log.settled).toEqual(["failed"]);
  });

  it("neither counts nor badges a file whose delete window is still open", async () => {
    // A file this device just deleted is not a file it is missing — announcing
    // it would count work the pass never does.
    const { sync, log } = mirror([{ id: "b1", relPath: REPORT, sha256: "sha-docx" }], {
      isDeletePending: (relPath) => relPath === REPORT,
    });

    const result = await sync.reconcile();

    expect(result.downloaded).toBe(0);
    expect(log.announced).toEqual([]);
    expect(log.settled).toEqual([]);
    expect(log.states[log.states.length - 1]?.[REPORT]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the trigger. A SyncManager with a reconciled vault, so the mirror
// exists; the registry, ipc, api and the engine are faked exactly as far as
// `enable` reaches.
// ---------------------------------------------------------------------------

const COLLECTION = "collection-1";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    primeLocal: vi.fn(async (_orgId: string) => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn(() => null),
    pathForDocId: vi.fn(() => null),
    allDocIds: vi.fn((): string[] => []),
    isNoteEmptyOnDisk: vi.fn(async () => false),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    setInboundHost: vi.fn(),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn(() => false),
    markPushed: vi.fn(),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
    consumeMaterialized: vi.fn(() => false),
    getFileId: vi.fn((): string | null => null),
    forgetFileId: vi.fn(),
    moveFileId: vi.fn(),
    markMaterialized: vi.fn(),
    deletePath: vi.fn(async () => {}),
    renamePath: vi.fn(async () => {}),
    recordFailure: vi.fn(),
  };
  return reg;
});

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async () => true),
  readNote: vi.fn(async () => ""),
  getNoteMeta: vi.fn(async () => null),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  listBinaries: vi.fn(async () => []),
  listFileRows: vi.fn(async () => []),
  fileStat: vi.fn(async () => ({ size: 0 })),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  writeTreeBinary: vi.fn(async () => {}),
  downloadAttachment: vi.fn(async () => ({ status: 200, bytes: 0 })),
  uploadAttachment: vi.fn(async () => ({ status: 200 })),
  getFileText: vi.fn(async () => null),
  writeTrashCopy: vi.fn(async () => "trash"),
  rebindNoteId: vi.fn(async () => true),
}));

vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    blobDownloadUrl: vi.fn(async () => ({ url: "https://blob", direct: true })),
    authHeaders: () => ({}),
    registerFile: vi.fn(async () => ({ id: "f1", docId: "f1" })),
    deleteFile: vi.fn(async () => {}),
    deleteBlob: vi.fn(async () => {}),
    resetNoteHistory: vi.fn(async () => {}),
  },
}));

vi.mock("../vaultSyncEngine", () => ({
  VaultSyncEngine: class {
    start() {}
    stop() {}
    setPresence() {}
    sendVoice() {
      return false;
    }
    refresh() {}
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return true;
    }
  },
}));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    async promote() {
      return null;
    }
    async demote() {}
    async release() {}
    peekResident() {
      return null;
    }
    suppressedDoc() {
      return null;
    }
    setSuppressedDoc() {}
    async flushStateVectors() {}
    async destroyAll() {}
  },
}));

import type { SessionInfo } from "../../api";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

/** An enabled manager whose vault has a server collection (so the mirror
 *  exists), with the pass `enable` kicked off already drained. */
async function liveManager() {
  const sm = new SyncManager();
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  const scope = vaultScopes.current()!;
  return { sm, scope };
}

beforeEach(() => {
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.vaultId = COLLECTION;
  fakeRegistry.pull.mockClear().mockImplementation(async () => true);
  fakeRegistry.reconcile.mockClear().mockImplementation(async () => ({ seeded: false }));
  fakeRegistry.mappedNotes.mockReturnValue([]);
});

describe("SyncManager — an ACL signal reaches the blob mirror", () => {
  it("schedules a pass on `reauth`, the live 'access moved' frame", async () => {
    const { sm, scope } = await liveManager();
    expect(sm.hasPendingAttachmentReconcile()).toBe(false);

    sm.handleServerReauth(scope);

    // The note half of this frame is the registry pull; the file half is this.
    expect(sm.hasPendingRegistryPull()).toBe(true);
    expect(sm.hasPendingAttachmentReconcile()).toBe(true);
    sm.disable();
  });

  it("schedules a pass on `ready.revoked`, the cold-start ACL signal", async () => {
    const { sm, scope } = await liveManager();

    sm.handleServerRevoked(["d1"], false, scope);

    expect(sm.hasPendingAttachmentReconcile()).toBe(true);
    sm.disable();
  });

  it("schedules a pass when a registry pull actually changed something", async () => {
    // A teammate's newly added `.docx` arrives as a structure change and nothing
    // else: without this the file waited for an unrelated local watcher event.
    vi.useFakeTimers();
    const { sm } = await liveManager();

    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);

    expect(fakeRegistry.pull).toHaveBeenCalled();
    expect(sm.hasPendingAttachmentReconcile()).toBe(true);
    sm.disable();
    vi.useRealTimers();
  });

  it("leaves the mirror alone when the pull changed nothing", async () => {
    vi.useFakeTimers();
    fakeRegistry.pull.mockImplementation(async () => false);
    const { sm } = await liveManager();

    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);

    expect(sm.hasPendingAttachmentReconcile()).toBe(false);
    sm.disable();
    vi.useRealTimers();
  });

  it("counts the re-granted file in the header's own progress", async () => {
    // The end-to-end shape of the fix: an ACL frame lands, the mirror runs, and
    // the ONE counter the header reads ("Syncing n/m") reports the file — the
    // same reporter a note backfill drives, not a second one beside it.
    const { api } = await import("../../auth/authManager");
    const ipc = await import("../../ipc");
    const { sm, scope } = await liveManager();
    await flush();

    const progress: Array<{ phase: string; done: number; total: number } | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p && { ...p }));
    vi.mocked(api.listVaultBlobs).mockImplementation(async () => [
      { id: "b1", relPath: REPORT, sha256: "sha-docx", size: 3, mime: "application/octet-stream" },
    ]);

    sm.handleServerReauth(scope);
    await vi.waitUntil(() => progress.some((p) => p?.phase === "downloading"), { timeout: 2000 });
    await vi.waitUntil(() => progress.some((p) => p?.done === 1), { timeout: 2000 });

    expect(vi.mocked(ipc.downloadAttachment)).toHaveBeenCalled();
    const wave = progress.find((p) => p?.phase === "downloading");
    expect(wave?.total).toBe(1);
    expect(progress[progress.length - 1]?.done).toBe(1);
    // …and the wave hands the terminal phase back when its last file lands, so
    // the vault is never badged settled while bytes are still moving.
    await vi.waitUntil(() => progress[progress.length - 1]?.phase === "done", {
      timeout: 2000,
    });
    sm.disable();
  });

  it("drops the armed pass on teardown, so it cannot fire at the next vault", async () => {
    const { sm, scope } = await liveManager();
    sm.handleServerReauth(scope);
    expect(sm.hasPendingAttachmentReconcile()).toBe(true);

    sm.disable();

    expect(sm.hasPendingAttachmentReconcile()).toBe(false);
  });
});
