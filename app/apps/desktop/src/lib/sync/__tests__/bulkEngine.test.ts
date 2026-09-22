// `enable()` with the BULK engine in it: what runs, in what order, and what is
// left exactly as it was below the threshold.
//
// The sequence under test (design §5):
//
//   reconcile (structure) → channel in LIVE-ONLY mode → bootstrap download →
//   batched push → per-doc `DocSync` for conflicts/oversized only →
//   reconnect the channel normally (full manifest ⇒ ≈0 backfill)
//
// Two things make it safe to run the two engines in one session, and both are
// asserted here: the per-doc content run must NOT start while the bulk phase
// owns the vault (the live-only channel's `ready` lands with a settled backfill
// and would otherwise start one), and a server without the bulk routes must
// fail LOUDLY rather than fall back to the per-note path in silence.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as ipc from "../../ipc";
import type { VaultDocStoreOptions } from "../vaultDocStore";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";

const COLLECTION = "collection-1";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    notes: [] as Array<{ docId: string; relPath: string }>,
    pushedSet: new Set<string>(),
    resume: null as unknown,
    materialized: [] as string[],
    primeLocal: vi.fn(async () => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => false),
    reset: vi.fn(),
    getMapping: vi.fn(() => null as { vaultId: string; docId: string } | null),
    pathForDocId: vi.fn(
      (docId: string) => reg.notes.find((n) => n.docId === docId)?.relPath ?? null,
    ),
    allDocIds: vi.fn(() => reg.notes.map((n) => n.docId)),
    mappedNotes: vi.fn(() => reg.notes),
    isNoteEmptyOnDisk: vi.fn(async () => false),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    setInboundHost: vi.fn(),
    isPushed: vi.fn((docId: string) => reg.pushedSet.has(docId)),
    markPushed: vi.fn((docId: string) => reg.pushedSet.add(docId)),
    markMaterialized: vi.fn((relPath: string) => reg.materialized.push(relPath)),
    bootstrapResume: vi.fn(() => reg.resume),
    setBootstrapResume: vi.fn((v: unknown) => {
      reg.resume = v;
    }),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
    consumeMaterialized: vi.fn(() => false),
    fileDocIds: vi.fn((): string[] => []),
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

const ipcHooks = vi.hoisted(() => ({
  bootstrapBatches: [] as unknown[][],
  cleared: [] as string[],
}));
vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async () => true),
  readNote: vi.fn(async () => "file text"),
  getNoteMeta: vi.fn(async () => null),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  clearYjsDoc: vi.fn(async (docId: string) => {
    ipcHooks.cleared.push(docId);
  }),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  listBinaries: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  writeTrashCopy: vi.fn(async () => "trash"),
  rebindNoteId: vi.fn(async () => true),
  applyBootstrapBatch: vi.fn(async (entries: Array<{ docId: string }>) => {
    ipcHooks.bootstrapBatches.push(entries);
    return entries.map((e) => ({ docId: e.docId, status: "written", reason: null }));
  }),
}));

const apiHooks = vi.hoisted(() => ({
  sessions: 0,
  pages: 0,
  pushes: [] as Array<Array<{ docId: string; expectEmpty?: boolean }>>,
  /** Page docs the fake bootstrap hands out (docId → text). */
  pageDocs: [] as Array<{ docId: string; relPath: string; text: string }>,
  emptyDocs: [] as string[],
  /** Make every bulk route answer 404, as a pre-bulk server does. */
  tooOld: false,
  pushStatus: "applied" as "applied" | "conflict",
}));
vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    resetNoteHistory: vi.fn(async () => {}),
    createBootstrapSession: vi.fn(async () => {
      if (apiHooks.tooOld) {
        throw Object.assign(new Error("not found"), { status: 404, code: "server_too_old" });
      }
      apiHooks.sessions++;
      return {
        sessionId: "s1",
        docs: apiHooks.pageDocs.length,
        bytes: 10,
        emptyDocs: apiHooks.emptyDocs,
        emptyTruncated: false,
        expiresAt: "",
      };
    }),
    fetchBootstrapPage: vi.fn(async () => {
      apiHooks.pages++;
      return {
        bytes: encodePage(apiHooks.pageDocs),
        nextCursor: null,
        docs: apiHooks.pageDocs.length,
        uncompressedBytes: 10,
      };
    }),
    batchPushDocs: vi.fn(async (_vaultId: string, items: Array<{ docId: string }>) => {
      apiHooks.pushes.push(items);
      return items.map((i) => ({
        docId: i.docId,
        status: apiHooks.pushStatus,
        code: null,
        error: null,
      }));
    }),
  },
  authManager: { getSession: vi.fn(async () => null) },
}));

const engineHooks = vi.hoisted(() => ({
  opts: null as VaultSyncEngineOptions | null,
  started: 0,
  reconnects: [] as Array<{ liveOnly?: boolean }>,
  liveOnly: false,
}));
vi.mock("../vaultSyncEngine", () => ({
  VaultSyncEngine: class {
    constructor(opts: VaultSyncEngineOptions) {
      engineHooks.opts = opts;
      engineHooks.liveOnly = opts.liveOnly === true;
    }
    start() {
      engineHooks.started++;
    }
    stop() {}
    setPresence() {}
    sendVoice() {
      return false;
    }
    refresh() {}
    reconnect(o: { liveOnly?: boolean } = {}) {
      engineHooks.reconnects.push(o);
      if (o.liveOnly !== undefined) engineHooks.liveOnly = o.liveOnly;
    }
    isLiveOnly() {
      return engineHooks.liveOnly;
    }
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return true;
    }
  },
}));

const storeHooks = vi.hoisted(() => ({
  promoted: [] as string[],
  dropped: [] as string[],
  applied: [] as string[],
}));
vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    constructor(_opts: VaultDocStoreOptions) {}
    async whenReady() {}
    knownDocs() {
      return [];
    }
    async promote(docId: string) {
      storeHooks.promoted.push(docId);
      const doc = new Y.Doc();
      return {
        doc,
        serialize: () => doc.getText("content").toString(),
        // The seed a server-empty doc gets: inserts the file's text ONCE, and
        // only into an empty doc (the real bridge's contract).
        seedFromFileIfEmpty: async () => {
          if (doc.getText("content").length > 0) return false;
          doc.getText("content").insert(0, "file text");
          return true;
        },
        ingestNow: async () => false,
        flushEgest: async () => {},
      };
    }
    async demote() {}
    async release() {}
    drop(docId: string) {
      storeHooks.dropped.push(docId);
    }
    async applyUpdate(docId: string) {
      storeHooks.applied.push(docId);
    }
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

const docSyncHooks = vi.hoisted(() => ({ connected: [] as string[] }));
vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = false;
    isSynced = false;
    readonly status = "connecting";
    readonly docId: string;
    readonly awareness = { setLocalStateField() {}, destroy() {} };
    constructor(input: { docId: string }) {
      this.docId = input.docId;
      docSyncHooks.connected.push(input.docId);
    }
    async whenSynced() {
      this.isSynced = true;
    }
    async whenFlushed() {
      return true;
    }
    destroy() {}
    refreshAccess() {}
  },
}));

import type { SessionInfo } from "../../api";
import { api } from "../../auth/authManager";
import { encodeBootstrapPage } from "../bootstrapCodec";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function encodePage(docs: Array<{ docId: string; relPath: string; text: string }>): Uint8Array {
  return encodeBootstrapPage(
    docs.map((d) => {
      const doc = new Y.Doc();
      if (d.text) doc.getText("content").insert(0, d.text);
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return { docId: d.docId, relPath: d.relPath, update };
    }),
  );
}

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

const notes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ docId: `d${i}`, relPath: `n${i}.md` }));

async function enable(sm: SyncManager) {
  const out = await sm.enable(session(), {
    orgId: "org-a",
    name: "a",
    path: "/vaults/a",
    epoch: 1,
  });
  await sm.whenBulkSyncSettled();
  await flush();
  // The channel's own edge: `ready` landed and its (live-only ⇒ empty) backfill
  // is drained. In production this is what hands over to the content run; here
  // it is fired explicitly because the fake engine has no socket to fire it.
  engineHooks.opts?.onInboundIdle?.();
  await sm.whenBulkSyncSettled();
  await flush();
  return out;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeRegistry.isNoteEmptyOnDisk.mockResolvedValue(false);
  vi.mocked(ipc.loadYjsState).mockResolvedValue({ snapshot: null, updates: [], updateCount: 0 });
  vaultScopes.end();
  fakeRegistry.vaultId = COLLECTION;
  fakeRegistry.notes = [];
  fakeRegistry.pushedSet = new Set();
  fakeRegistry.resume = null;
  fakeRegistry.materialized = [];
  fakeRegistry.primeLocal.mockResolvedValue(false);
  fakeRegistry.reconcile.mockResolvedValue({ seeded: false });
  engineHooks.opts = null;
  engineHooks.started = 0;
  engineHooks.reconnects = [];
  engineHooks.liveOnly = false;
  apiHooks.sessions = 0;
  apiHooks.pages = 0;
  apiHooks.pushes = [];
  apiHooks.pageDocs = [];
  apiHooks.emptyDocs = [];
  apiHooks.tooOld = false;
  apiHooks.pushStatus = "applied";
  ipcHooks.bootstrapBatches = [];
  ipcHooks.cleared = [];
  storeHooks.promoted = [];
  storeHooks.dropped = [];
  storeHooks.applied = [];
  docSyncHooks.connected = [];
});

describe("at or above the threshold", () => {
  it("starts the channel LIVE-ONLY, bootstraps, batch-pushes, then reconnects", async () => {
    fakeRegistry.notes = notes(25);
    apiHooks.pageDocs = [{ docId: "d0", relPath: "n0.md", text: "server copy" }];
    apiHooks.emptyDocs = fakeRegistry.notes.slice(1).map((n) => n.docId);

    const sm = new SyncManager();
    await enable(sm);

    // The channel never cold-backfills while the bulk engine owns the download…
    expect(engineHooks.opts?.liveOnly).toBe(true);
    // …one session, one page, ONE batch IPC for it…
    expect(apiHooks.sessions).toBe(1);
    expect(ipcHooks.bootstrapBatches).toHaveLength(1);
    expect(ipcHooks.bootstrapBatches[0]).toHaveLength(1);
    // …the downloaded doc is claimed and owes exactly one watcher echo…
    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("d0");
    expect(fakeRegistry.materialized).toEqual(["n0.md"]);
    // …the other 24 go up in ONE request, each flagged expectEmpty (they were
    // seeded from their files because the SERVER said it holds nothing)…
    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0]).toHaveLength(24);
    expect(apiHooks.pushes[0].every((i) => i.expectEmpty === true)).toBe(true);
    // …not one per-doc socket was opened…
    expect(docSyncHooks.connected).toEqual([]);
    // …and the channel goes back to normal, with the manifest now complete.
    expect(engineHooks.reconnects).toEqual([{ liveOnly: false }]);
  });

  it("resumes the bootstrap from the cursor the registry persisted", async () => {
    fakeRegistry.notes = notes(30);
    fakeRegistry.resume = {
      serverVaultId: COLLECTION,
      sessionId: "earlier",
      cursor: 4,
      docsTotal: 30,
      docsDone: 4,
      bytesTotal: 100,
      bytesDone: 40,
    };
    const sm = new SyncManager();
    await enable(sm);

    expect(api.createBootstrapSession).not.toHaveBeenCalled();
    expect(vi.mocked(api.fetchBootstrapPage).mock.calls[0]).toEqual([
      COLLECTION,
      "earlier",
      { cursor: 4 },
    ]);
    // Drained ⇒ no stale cursor left for the next launch to chase.
    expect(fakeRegistry.setBootstrapResume).toHaveBeenLastCalledWith(null);
  });

  it("sends a `conflict` to the per-doc path and throws the seed away first", async () => {
    fakeRegistry.notes = notes(25);
    apiHooks.emptyDocs = fakeRegistry.notes.map((n) => n.docId);
    apiHooks.pushStatus = "conflict";

    const sm = new SyncManager();
    await enable(sm);

    // The batch claimed nothing — the server applied nothing — and every doc
    // was flagged so the server could make exactly that check.
    expect(apiHooks.pushes[0].every((i) => i.expectEmpty === true)).toBe(true);
    // The seed is discarded locally (store.drop + clearYjsDoc), which is what
    // stops the follow-up pull from merging a second insert history…
    expect(ipcHooks.cleared).toHaveLength(25);
    expect(storeHooks.dropped).toHaveLength(25);
    // …and every conflicted doc then gets a REAL socket, which pulls first.
    expect(new Set(docSyncHooks.connected)).toEqual(
      new Set(fakeRegistry.notes.map((n) => n.docId)),
    );
  });
});

describe("below the threshold", () => {
  it("behaves exactly as today: no bulk routes, no live-only, per-doc sockets", async () => {
    fakeRegistry.notes = notes(24);
    const sm = new SyncManager();
    await enable(sm);

    expect(engineHooks.opts?.liveOnly).toBe(false);
    expect(api.createBootstrapSession).not.toHaveBeenCalled();
    expect(api.fetchBootstrapPage).not.toHaveBeenCalled();
    expect(api.batchPushDocs).not.toHaveBeenCalled();
    expect(engineHooks.reconnects).toEqual([]);
    // …and the old content run is what moved the notes.
    expect(docSyncHooks.connected).toHaveLength(24);
  });
});

describe("a server without the bulk routes", () => {
  it("reports `server_too_old` terminally, with the vault still populated", async () => {
    fakeRegistry.notes = notes(25);
    apiHooks.tooOld = true;
    const progress: string[] = [];
    const sm = new SyncManager();
    sm.setSyncProgressListener((p) => {
      if (p) progress.push(p.phase);
    });
    const out = await enable(sm);

    expect(out.ok).toBe(true); // the vault is usable…
    expect(fakeRegistry.reconcile).toHaveBeenCalled(); // …its structure is there…
    expect(engineHooks.started).toBe(1); // …and the channel is up.
    // The CONTENT phase is what failed, and it says so rather than silently
    // falling back to the per-note path.
    expect(progress[progress.length - 1]).toBe("error");
    expect(api.batchPushDocs).not.toHaveBeenCalled();
    expect(docSyncHooks.connected).toEqual([]);
    expect(sm.syncLog().some((e) => e.event === "server-too-old")).toBe(true);
  });
});


describe("unchanged empty notes on restart", () => {
  it("settles bootstrap emptyDocs before opening an upload run, even before channel ready", async () => {
    fakeRegistry.notes = notes(345);
    apiHooks.emptyDocs = fakeRegistry.notes.map((n) => n.docId);
    fakeRegistry.isNoteEmptyOnDisk.mockResolvedValue(true);
    const phases: string[] = [];
    const sm = new SyncManager();
    sm.setSyncProgressListener(p => { if (p) phases.push(p.phase); });
    await enable(sm);
    expect(apiHooks.pushes).toEqual([]);
    expect(storeHooks.promoted).toEqual([]);
    expect(docSyncHooks.connected).toEqual([]);
    expect(phases).not.toContain("uploading");
    expect(fakeRegistry.pushedSet.size).toBe(345);
    sm.disable();
  });

  it("still queues a blank file whose local CRDT holds unsent text", async () => {
    fakeRegistry.notes = notes(25);
    apiHooks.emptyDocs = fakeRegistry.notes.map((n) => n.docId);
    fakeRegistry.isNoteEmptyOnDisk.mockResolvedValue(true);
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "not written to disk yet");
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    vi.mocked(ipc.loadYjsState).mockImplementation(async id => ({
      snapshot: id === "d0" ? snapshot : null, updates: [], updateCount: 0,
    }));
    const sm = new SyncManager();
    await enable(sm);
    expect(apiHooks.pushes.flat().map(n => n.docId)).toEqual(["d0"]);
    expect(fakeRegistry.pushedSet.size).toBe(25);
    sm.disable();
  });
});
