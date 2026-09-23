// The content push of a RUNNING vault — the fourth `useBulkPath` site.
//
// `enable()` has batched its content push since the bulk engine shipped, but the
// two sites that run for the rest of the session did not: the steady-state
// content run (`runBulkSync`, driven by `ready.empty`/`ready.behind` and by every
// registry pull) and the local-change drain (`runLocalChangePush`, driven by the
// watcher). Both built a `ContentUploader`, whose unit is one
// `POST /api/sync-token` plus one WebSocket handshake per note at width 4.
//
// So dropping 500 notes into a vault that was already open took minutes, while
// quitting and relaunching the app made the identical work take seconds — the
// asymmetry this file exists to remove. What it pins:
//
//   · at or above the threshold both sites send ONE `docs/batch` request and
//     open NO per-doc socket (no token mint, no handshake);
//   · below it, nothing changed at all;
//   · the three things a batch may not settle — a `conflict`, an item over
//     `BULK_ITEM_MAX_BYTES`, and a doc with no local state that the SERVER never
//     called empty — each fall back to the per-doc pull-then-merge path;
//   · the local-change drain's ingest fast-path survives batching: our own egest
//     echoing back costs neither a request nor a socket.
//
// The registry, the channel, the doc store and the per-note provider are faked;
// `DocBatchPusher` and `ContentUploader` are REAL, so what is asserted is the
// routing production computes rather than a restatement of it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultDocStoreOptions } from "../vaultDocStore";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";

const COLLECTION = "collection-1";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: "collection-1" as string | null,
    notes: [] as Array<{ docId: string; relPath: string }>,
    pushedSet: new Set<string>(),
    primeLocal: vi.fn(async () => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => false),
    reset: vi.fn(),
    getMapping: vi.fn((relPath: string): { vaultId: string; docId: string } | null => {
      const hit = reg.notes.find((n) => n.relPath === relPath);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    }),
    pathForDocId: vi.fn(
      (docId: string) => reg.notes.find((n) => n.docId === docId)?.relPath ?? null,
    ),
    allDocIds: vi.fn(() => reg.notes.map((n) => n.docId)),
    mappedNotes: vi.fn(() => reg.notes),
    /** Every named doc's file has bytes unless a test says otherwise. */
    emptyOnDisk: new Set<string>(),
    isNoteEmptyOnDisk: vi.fn(async (relPath: string) => reg.emptyOnDisk.has(relPath)),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    setInboundHost: vi.fn(),
    isPushed: vi.fn((docId: string) => reg.pushedSet.has(docId)),
    markPushed: vi.fn((docId: string) => reg.pushedSet.add(docId)),
    markMaterialized: vi.fn(),
    bootstrapResume: vi.fn(() => null as unknown),
    setBootstrapResume: vi.fn(),
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

const fakeDisk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  trashCopies: [] as Array<{ path: string; content: string }>,
}));
vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async () => true),
  readNote: vi.fn(async (path: string) => fakeDisk.files.get(path) ?? "file text"),
  getNoteMeta: vi.fn(async () => null),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  listBinaries: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  writeTrashCopy: vi.fn(async (path: string, _stamp: string, content: string) => {
    fakeDisk.trashCopies.push({ path, content });
    return `.context/trash/stamp/${path}`;
  }),
  rebindNoteId: vi.fn(async () => true),
  applyBootstrapBatch: vi.fn(async () => []),
}));

const apiHooks = vi.hoisted(() => ({
  /** Every `POST …/docs/batch` request that REACHED the server, by item. */
  pushes: [] as Array<Array<{ docId: string; expectEmpty?: boolean }>>,
  /** Per-doc status overrides; everything else is `applied`. */
  status: new Map<string, "applied" | "skipped" | "conflict" | "denied">(),
  /** Attempts to fail with a 502 before the route works again — a restarting
   *  server. `withRetry` makes three attempts, so 3 fails the whole chunk. */
  failAttempts: 0,
  /** Doc ids the response deliberately leaves out (the server answered, but not
   *  for this note): a per-item, NON-permanent failure. */
  omit: new Set<string>(),
}));
vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    createBootstrapSession: vi.fn(async () => {
      throw new Error("the live path must never open a bootstrap session");
    }),
    batchPushDocs: vi.fn(async (_vaultId: string, items: Array<{ docId: string }>) => {
      if (apiHooks.failAttempts > 0) {
        apiHooks.failAttempts--;
        throw Object.assign(new Error("bad gateway"), { status: 502 });
      }
      apiHooks.pushes.push(items);
      return items
        .filter((i) => !apiHooks.omit.has(i.docId))
        .map((i) => ({
          docId: i.docId,
          status: apiHooks.status.get(i.docId) ?? ("applied" as const),
          code: null,
          error: null,
        }));
    }),
  },
  authManager: { getSession: vi.fn(async () => null) },
}));

const engineHooks = vi.hoisted(() => ({
  opts: null as VaultSyncEngineOptions | null,
  settled: false,
  refreshes: 0,
}));
vi.mock("../vaultSyncEngine", () => ({
  VaultSyncEngine: class {
    constructor(opts: VaultSyncEngineOptions) {
      engineHooks.opts = opts;
    }
    start() {}
    stop() {}
    setPresence() {}
    sendVoice() {
      return false;
    }
    refresh() {
      engineHooks.refreshes++;
    }
    reconnect() {}
    isLiveOnly() {
      return false;
    }
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return engineHooks.settled;
    }
  },
}));

const storeHooks = vi.hoisted(() => ({
  promoted: [] as string[],
  /** Docs whose local CRDT already holds text (a doc with history). */
  withContent: new Set<string>(),
  content: new Map<string, string>(),
  /** What `ingestNow` reports for a doc: did the file change anything? */
  ingestChanges: new Set<string>(),
  ingested: [] as string[],
}));
vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    constructor(_opts: VaultDocStoreOptions) {}
    async whenReady() {}
    knownDocs() {
      return [];
    }
    async promote(docId: string, relPath: string) {
      storeHooks.promoted.push(docId);
      const doc = new Y.Doc();
      if (storeHooks.withContent.has(docId)) {
        doc.getText("content").insert(0, storeHooks.content.get(docId) ?? "doc text");
      }
      const ingest = () => {
        storeHooks.ingested.push(docId);
        if (!storeHooks.ingestChanges.has(docId)) return false;
        doc.getText("content").insert(0, "+");
        return true;
      };
      return {
        doc,
        serialize: () => doc.getText("content").toString(),
        seedFromFileIfEmpty: async () => {
          if (doc.getText("content").length > 0) return false;
          doc.getText("content").insert(0, fakeDisk.files.get(relPath) ?? "file text");
          return true;
        },
        ingestNow: async () => ingest(),
        // The per-doc path probes before the pull and merges after it (#200).
        beginPull: () => {},
        abandonPull: () => {},
        hasUnmergedFileChange: async () => storeHooks.ingestChanges.has(docId),
        reconcileAfterPull: async () => ingest(),
        flushEgest: async () => {
          fakeDisk.files.set(relPath, doc.getText("content").toString());
        },
      };
    }
    async demote() {}
    async release() {}
    drop(docId: string) {
      storeHooks.withContent.delete(docId);
      storeHooks.content.delete(docId);
    }
    async applyUpdate() {}
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

/** The per-note provider: one instance == one token mint + one handshake. */
const connects = vi.hoisted(() => ({
  order: [] as string[],
  readOnly: new Set<string>(),
  serverContent: new Map<string, string>(),
}));
vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly: boolean;
    isSynced = false;
    readonly status = "connecting";
    readonly awareness = { setLocalStateField() {}, destroy() {} };
    private readonly doc: Y.Doc;
    private readonly docId: string;
    constructor(input: { docId: string; doc: Y.Doc }) {
      connects.order.push(input.docId);
      this.readOnly = connects.readOnly.has(input.docId);
      this.doc = input.doc;
      this.docId = input.docId;
    }
    async whenSynced() {
      const canonical = connects.serverContent.get(this.docId);
      if (canonical != null && this.doc.getText("content").length === 0) {
        this.doc.getText("content").insert(0, canonical);
      }
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
import { SyncManager } from "../docSession";
import { BULK_ITEM_MAX_BYTES } from "../pool";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

const notes = (n: number, prefix = "d") =>
  Array.from({ length: n }, (_, i) => ({ docId: `${prefix}${i}`, relPath: `${prefix}${i}.md` }));

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

/**
 * Bring a SMALL vault up (below the threshold, so `enable` itself takes no bulk
 * path) and settle its backfill — the state a live import arrives into.
 */
async function liveVault(sm: SyncManager) {
  fakeRegistry.notes = notes(2, "old");
  for (const n of fakeRegistry.notes) fakeRegistry.pushedSet.add(n.docId);
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  engineHooks.settled = true;
  engineHooks.opts?.onStatus?.("synced");
  engineHooks.opts?.onServerEmpty?.([], false);
  await sm.whenBulkSyncSettled();
  await flush();
  apiHooks.pushes = [];
  connects.order = [];
  storeHooks.promoted = [];
}

/** Add `count` freshly-registered notes and tell the session what the server
 *  said about them, then let the content run drain. */
async function importNotes(
  sm: SyncManager,
  count: number,
  opts: { serverEmpty?: boolean } = {},
) {
  const fresh = notes(count, "new");
  fakeRegistry.notes = [...fakeRegistry.notes, ...fresh];
  if (opts.serverEmpty !== false) {
    // What registration answered: `status: "created"` ⇒ the server holds nothing
    // for these ids. (In production the registry reports it as it registers.)
    sm.noteServerCreated(fresh.map((n) => n.docId));
  }
  engineHooks.opts?.onInboundIdle?.();
  await sm.whenBulkSyncSettled();
  await flush();
  return fresh;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.vaultId = COLLECTION;
  fakeRegistry.notes = [];
  fakeRegistry.pushedSet = new Set();
  fakeRegistry.emptyOnDisk = new Set();
  fakeRegistry.primeLocal.mockResolvedValue(false);
  fakeRegistry.reconcile.mockResolvedValue({ seeded: false });
  fakeDisk.files.clear();
  fakeDisk.trashCopies = [];
  apiHooks.pushes = [];
  apiHooks.status = new Map();
  apiHooks.failAttempts = 0;
  apiHooks.omit = new Set();
  engineHooks.opts = null;
  engineHooks.settled = false;
  engineHooks.refreshes = 0;
  storeHooks.promoted = [];
  storeHooks.withContent = new Set();
  storeHooks.content = new Map();
  storeHooks.ingestChanges = new Set();
  storeHooks.ingested = [];
  connects.order = [];
  connects.readOnly = new Set();
  connects.serverContent = new Map();
});

describe("a live import — the steady-state content run", () => {
  it("settles a clean Private→Read-only re-download without inventing failures", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    const restored = notes(30, "restored");
    // These stable ids existed locally before Private removed them. Exercise the
    // real lifecycle hook rather than constructing an already-restored vault.
    fakeRegistry.notes = [...fakeRegistry.notes, ...restored];
    for (const n of restored) {
      fakeRegistry.pushedSet.add(n.docId);
      storeHooks.withContent.add(n.docId);
      sm.noteRemoved(n.docId, n.relPath, null, "revoked");
      fakeRegistry.pushedSet.delete(n.docId);
    }
    fakeRegistry.notes = fakeRegistry.notes.filter((n) => !n.docId.startsWith("restored"));

    // Read-only restores the same identities with freshly-created local CRDT
    // histories and matching durable Markdown files.
    fakeRegistry.notes = [...fakeRegistry.notes, ...restored];
    for (const n of restored) {
      storeHooks.withContent.add(n.docId);
      fakeDisk.files.set(n.relPath, "doc text");
      apiHooks.status.set(n.docId, "denied");
      connects.readOnly.add(n.docId);
      connects.serverContent.set(n.docId, "doc text");
    }

    // The channel reports that this device has state the server does not cover
    // (the unrelated pre-revocation history), which is what queues the denied
    // batch even though the placeholder itself is empty.
    engineHooks.opts?.onServerBehind?.(restored.map((n) => n.docId));
    engineHooks.opts?.onServerEmpty?.([], false);
    engineHooks.opts?.onInboundIdle?.();
    await sm.whenBulkSyncSettled();
    await flush();

    expect(apiHooks.pushes).toHaveLength(1);
    expect(connects.order).toEqual(restored.map((n) => n.docId));
    expect(fakeDisk.trashCopies).toEqual([]);
    expect(sm.syncFailures().content).toEqual([]);
    for (const n of restored) {
      expect(fakeRegistry.pushedSet.has(n.docId)).toBe(true);
    }
  });

  it("keeps and classifies a real local edit during the same read-only transition", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    const restored = notes(30, "restored");
    fakeRegistry.notes = [...fakeRegistry.notes, ...restored];
    for (const n of restored) {
      storeHooks.withContent.add(n.docId);
      fakeDisk.files.set(n.relPath, "doc text");
      apiHooks.status.set(n.docId, "denied");
      connects.readOnly.add(n.docId);
      connects.serverContent.set(n.docId, "doc text");
    }
    fakeDisk.files.set("restored7.md", "a local edit made while private");
    // The edit is already in local CRDT history too. A plain file==doc check is
    // insufficient here: the server's denied verdict is what proves those ops
    // never landed remotely.
    storeHooks.content.set("restored7", "a local edit made while private");

    engineHooks.opts?.onInboundIdle?.();
    await sm.whenBulkSyncSettled();
    await flush();

    expect(fakeDisk.trashCopies).toEqual([
      { path: "restored7.md", content: "a local edit made while private" },
    ]);
    expect(sm.syncFailures().content).toEqual([
      expect.objectContaining({
        docId: "restored7",
        kind: "no-write-access",
        permanent: true,
      }),
    ]);

    // Private removes this local incarnation. The same stable id may later be
    // materialized again, but the old terminal verdict must not make it
    // ineligible for a fresh canonical pull.
    sm.noteRemoved("restored7", "restored7.md", null, "revoked");
    expect(sm.syncFailures().content).toEqual([]);
  });

  it("sends 30 pending notes in ONE request, with no token mint and no socket", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    const fresh = await importNotes(sm, 30);

    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0]).toHaveLength(30);
    // Seeded from their files because the SERVER said it holds nothing, and
    // flagged so the server re-checks that under its per-doc lock.
    expect(apiHooks.pushes[0].every((i) => i.expectEmpty === true)).toBe(true);
    // THE point: not one `POST /api/sync-token` + handshake among them.
    expect(connects.order).toEqual([]);
    // …and every one is confirmed, so the next `ready` re-queues nothing.
    for (const n of fresh) expect(fakeRegistry.pushedSet.has(n.docId)).toBe(true);
  });

  it("keeps 10 pending notes on the per-doc path, exactly as before", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    const fresh = await importNotes(sm, 10);

    expect(apiHooks.pushes).toEqual([]);
    expect(connects.order).toEqual(fresh.map((n) => n.docId));
  });

  it("falls back to a real socket for the doc the server refused as non-empty", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    apiHooks.status.set("new7", "conflict");
    await importNotes(sm, 30);

    expect(apiHooks.pushes).toHaveLength(1);
    // Every item asked the server to re-check emptiness under its lock…
    expect(apiHooks.pushes[0].every((i) => i.expectEmpty === true)).toBe(true);
    // …and exactly the doc it answered `conflict` for takes the pull-then-merge
    // path, on its own socket. Nothing else does.
    expect(connects.order).toEqual(["new7"]);
  });

  it("excludes an item over BULK_ITEM_MAX_BYTES to its own socket", async () => {
    const sm = new SyncManager();
    await liveVault(sm);
    fakeDisk.files.set("new3.md", "x".repeat(BULK_ITEM_MAX_BYTES + 1));
    await importNotes(sm, 30);

    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0]).toHaveLength(29); // the big one is not in it
    expect(apiHooks.pushes[0].some((i) => i.docId === "new3")).toBe(false);
    expect(connects.order).toEqual(["new3"]);
  });

  it("never batch-settles a doc with no local state that the server never called empty", async () => {
    // The guard that makes the batch path safe to use OUTSIDE `enable`: with no
    // server statement there is nothing to license a seed, and an empty doc
    // encodes to a 2-byte "I know nothing" the server would happily accept —
    // marking the note synced with its text nowhere but this disk. It goes to
    // the per-doc path, which pulls first.
    const sm = new SyncManager();
    await liveVault(sm);
    const fresh = await importNotes(sm, 30, { serverEmpty: false });

    expect(apiHooks.pushes).toEqual([]);
    expect(connects.order).toEqual(fresh.map((n) => n.docId));
  });

  it("batches the docs a `ready.empty` names mid-session, not just at enable", async () => {
    // The other live shape: a server that lost content (a restore, a crashed
    // run) names it on the next handshake. Before this, only `enable` batched,
    // so the repair opened a socket per note.
    const sm = new SyncManager();
    await liveVault(sm);
    const fresh = notes(40, "lost");
    fakeRegistry.notes = [...fakeRegistry.notes, ...fresh];
    for (const n of fresh) fakeRegistry.pushedSet.add(n.docId); // the local checkpoint lies

    engineHooks.opts?.onServerEmpty?.(
      fresh.map((n) => n.docId),
      false,
    );
    await sm.whenBulkSyncSettled();
    await flush();

    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0]).toHaveLength(40);
    expect(connects.order).toEqual([]);
  });
});

describe("a live import — the local-change drain", () => {
  /** 30 mapped notes whose docs already hold text, all changed on disk. */
  async function externalEdits(sm: SyncManager, changed: boolean) {
    const edited = notes(30, "edit");
    fakeRegistry.notes = [...fakeRegistry.notes, ...edited];
    for (const n of edited) {
      fakeRegistry.pushedSet.add(n.docId);
      storeHooks.withContent.add(n.docId);
      if (changed) storeHooks.ingestChanges.add(n.docId);
    }
    sm.handleLocalFilesChanged(
      edited.map((n) => ({ path: n.relPath, kind: "modified" as const })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    return edited;
  }

  it("merges 30 externally-edited notes in ONE request, with no socket", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await liveVault(sm);
    await externalEdits(sm, true);

    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0]).toHaveLength(30);
    // A plain CRDT merge of state this device already owns — never a file-seed,
    // so there is no emptiness claim to make.
    expect(apiHooks.pushes[0].every((i) => i.expectEmpty === undefined)).toBe(true);
    // The file's bytes reached the doc before it was packed.
    expect(new Set(storeHooks.ingested)).toEqual(new Set(notes(30, "edit").map((n) => n.docId)));
    expect(connects.order).toEqual([]);
    vi.useRealTimers();
  });

  it("costs nothing at all when the change was our own egest echoing back", async () => {
    // Most local-change events are exactly that. The per-doc path settled them
    // without a socket; the batch path must settle them without a REQUEST too,
    // or an idle vault would upload itself on every watcher tick.
    vi.useFakeTimers();
    const sm = new SyncManager();
    await liveVault(sm);
    await externalEdits(sm, false);

    expect(apiHooks.pushes).toEqual([]);
    expect(connects.order).toEqual([]);
    vi.useRealTimers();
  });

  /** Past the debounce, every retry backoff and the requeue's retry window. */
  async function settleRetries() {
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flush();
    }
  }

  it("requeues a chunk the transport lost, so the next drain sends it", async () => {
    // A transport failure fails EVERY item of its chunk — up to 100 notes on one
    // 502 from a restarting server. The drain empties `localChanges` up front and
    // these docs are already `isPushed`, so `contentWorkList` excludes them too:
    // without a requeue their freshly-ingested text sits in the local CRDT until
    // some future reconnect's `ready.behind` notices, which on a healthy socket
    // is hours. The per-doc path retried within seconds; so must this one.
    vi.useFakeTimers();
    const sm = new SyncManager();
    await liveVault(sm);
    apiHooks.failAttempts = 3; // `withRetry` makes three attempts, then gives up
    await externalEdits(sm, true);

    expect(apiHooks.pushes).toEqual([]); // nothing reached the server
    await settleRetries();

    // …and the whole batch came back on its own, in one request, with no socket.
    expect(apiHooks.pushes).toHaveLength(1);
    expect(apiHooks.pushes[0].map((i) => i.docId).sort()).toEqual(
      notes(30, "edit")
        .map((n) => n.docId)
        .sort(),
    );
    expect(connects.order).toEqual([]);
    vi.useRealTimers();
  });

  it("requeues unanswered notes while a denied item takes one pull-first fallback", async () => {
    // `denied` leaves the batch and takes one per-doc pull, where read-only
    // state and disk divergence can be checked. An unanswered id is different:
    // the server said nothing about that note, so the batch itself retries it.
    vi.useFakeTimers();
    const sm = new SyncManager();
    await liveVault(sm);
    apiHooks.status.set("edit0", "denied");
    // Unanswered ⇒ retryable. 25 of them, so the retry is a BATCH too and the
    // assertion reads the request rather than a pile of per-doc sockets.
    const unanswered = notes(30, "edit")
      .slice(1, 26)
      .map((n) => n.docId);
    for (const id of unanswered) apiHooks.omit.add(id);
    await externalEdits(sm, true);

    expect(apiHooks.pushes).toHaveLength(1);
    apiHooks.omit.clear(); // the server answers properly from here on
    await settleRetries();

    // Exactly the unanswered notes came back through the batch. The refused one
    // was settled by its one per-doc fallback instead.
    expect(apiHooks.pushes).toHaveLength(2);
    expect(apiHooks.pushes[1].map((i) => i.docId).sort()).toEqual([...unanswered].sort());
    expect(connects.order).toContain("edit0");
    vi.useRealTimers();
  });
});
