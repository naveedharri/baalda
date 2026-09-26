// The ORDER of a vault's bulk sync, and what the content run is allowed to send.
//
// Before this, `enable()` pushed every mapped note over a dedicated per-note
// provider (a `POST /api/sync-token` + a WebSocket apiece, 3.7 notes/second in
// prod) WHILE the vault channel was backfilling those same notes over one socket.
// Every note was therefore delivered twice, and the slow path was the fragile one:
// a token mint failure timed out, five in a row aborted the run, and nothing ever
// restarted it — leaving 613 notes registered with zero content on the server.
//
// So the contract these tests pin is:
//   1. download first — no content run until the vault backfill has settled;
//   2. a doc the backfill delivered cleanly is marked pushed, so the run's queue
//      is exactly "what the server did not deliver";
//   3. the server's `ready.empty` outranks the local `pushed` checkpoint, and
//      those docs go to the FRONT of the queue;
//   4. every `ready` re-arms a run, which is what makes the uploader's failure
//      streak a pause rather than a verdict.
//
// The registry, the vault channel, the doc store and the per-note provider are
// faked; the ContentUploader is REAL, so the queue and its order are the ones
// production computes rather than a restatement of them here.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";
import type { VaultDocStoreOptions } from "../vaultDocStore";

const OPEN_DOC = "doc-open";

// Captured before any `vi.useFakeTimers()` runs: the drain helpers below need a
// REAL event-loop turn (crypto.subtle.digest resolves off the threadpool, which
// fake timers cannot advance), and setImmediate is faked by default too.
const realSetTimeout = globalThis.setTimeout;
const realTick = () => new Promise<void>((r) => realSetTimeout(r, 1));

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: "collection-1" as string | null,
    pushed: new Set<string>(),
    // Phase A of `enable`: nothing to prime from in these fixtures (the mapping
    // is supplied directly), so the ordering under test stays the reconcile's.
    primeLocal: vi.fn(async (_orgId: string) => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn((_relPath: string): { vaultId: string; docId: string } | null => null),
    pathForDocId: vi.fn((_docId: string): string | null => null),
    /** relPaths the fake disk holds as EMPTY files. */
    emptyOnDisk: new Set<string>(),
    isNoteEmptyOnDisk: vi.fn(async (relPath: string) => reg.emptyOnDisk.has(relPath)),
    allDocIds: vi.fn((): string[] => []),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    setInboundHost: vi.fn(),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn((docId: string) => reg.pushed.has(docId)),
    markPushed: vi.fn((docId: string) => {
      reg.pushed.add(docId);
    }),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
    // ---- disk-delete propagation (#93) ----
    /** Paths the registry's own materialize step created; one echo each. */
    materialized: new Set<string>(),
    consumeMaterialized: vi.fn((relPath: string) => reg.materialized.delete(relPath)),
    /** The server delete. THE call a propagated disk delete must make. */
    deletePath: vi.fn(async (_path: string) => {}),
    /** Its batched twin, used once a window is worth a request of its own.
     *  Answers `deleted` for everything unless a test says otherwise. */
    deletePaths: vi.fn(
      async (paths: readonly string[]) =>
        paths.map((path) => ({
          path,
          status: "deleted" as "deleted" | "denied" | "failed",
          reason: null as string | null,
          code: null as string | null,
        })),
    ),
    renamePath: vi.fn(async (_from: string, _to: string): Promise<boolean> => true),
    recordFailure: vi.fn((_f: unknown) => {}),
    // ---- #221: folders and the closed-app drift report ----
    /** Registered folder ids by path. */
    folders: new Map<string, string>(),
    getFolderId: vi.fn((path: string): string | null => reg.folders.get(path) ?? null),
    lastPassDrift: vi.fn((): { missingMapped: number; unmappedLocal: number } | null => null),
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

/**
 * Rust. Only the calls this suite's paths make: the disk probe behind a
 * propagated delete, the recovery copy it writes first, the index rebind a
 * rename needs, and the handful of reads `enable()` fires off.
 */
const fakeDisk = vi.hoisted(() => {
  const state = {
    /** Paths that exist on disk. A `removed` watcher event for a path NOT here
     *  is what the drain re-verifies and then propagates. */
    files: new Map<string, string>(),
    /** sha256 the Rust index would report per path (rename pairing). */
    shas: new Map<string, string>(),
    /** Docs with local CRDT state (materializeContent's pre-check). */
    crdt: new Set<string>(),
    trashed: [] as Array<{ path: string; content: string }>,
    rebinds: [] as Array<{ path: string; docId: string }>,
    /** Directories on disk (#221 folder-move pairing walks the tree). */
    dirs: new Set<string>(),
    /** What `vault_root_state` answers. */
    root: "dir" as "dir" | "missing" | "not-dir",
    /** Every `materialize_notes_batch` call (index + rebind of moved files). */
    materialized: [] as Array<Array<{ relPath: string; docId: string | null }>>,
  };
  return state;
});

/** The full tree `list_tree` would return for `fakeDisk` (dirs + files). */
function fakeTree() {
  type Node = { id: string; name: string; path: string; isDir: boolean; children?: Node[]; childrenLoaded?: boolean };
  const root: Node = { id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true };
  const byPath = new Map<string, Node>([["", root]]);
  const ensureDir = (path: string): Node => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf("/");
    const parent = ensureDir(i === -1 ? "" : path.slice(0, i));
    const node: Node = { id: path, name: path.slice(i + 1), path, isDir: true, children: [], childrenLoaded: true };
    parent.children!.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const d of fakeDisk.dirs) ensureDir(d);
  for (const f of fakeDisk.files.keys()) {
    const i = f.lastIndexOf("/");
    const parent = ensureDir(i === -1 ? "" : f.slice(0, i));
    parent.children!.push({ id: f, name: f.slice(i + 1), path: f, isDir: false });
  }
  return root;
}

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async (path: string) => fakeDisk.files.has(path)),
  vaultRootState: vi.fn(async () => fakeDisk.root),
  listTree: vi.fn(async () => fakeTree()),
  materializeNotesBatch: vi.fn(async (items: Array<{ relPath: string; docId: string | null }>) => {
    fakeDisk.materialized.push(items);
    return items.map((i) => ({ relPath: i.relPath, created: false, rebound: true, error: null }));
  }),
  readNote: vi.fn(async (path: string) => fakeDisk.files.get(path) ?? ""),
  getNoteMeta: vi.fn(async (path: string) =>
    fakeDisk.shas.has(path) ? { path, sha256: fakeDisk.shas.get(path) } : null,
  ),
  writeTrashCopy: vi.fn(async (path: string, stamp: string, content: string) => {
    fakeDisk.trashed.push({ path, content });
    return `.context/trash/${stamp}/${path}`;
  }),
  rebindNoteId: vi.fn(async (path: string, docId: string) => {
    fakeDisk.rebinds.push({ path, docId });
    return true;
  }),
  loadYjsState: vi.fn(async (docId: string) =>
    fakeDisk.crdt.has(docId)
      ? { snapshot: new Uint8Array([1]), updates: [], updateCount: 0 }
      : { snapshot: null, updates: [], updateCount: 0 },
  ),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
}));

/** The vault channel. Captures its options so a test can play server frames. */
const engineHooks = vi.hoisted(() => {
  const state = {
    opts: null as VaultSyncEngineOptions | null,
    started: 0,
    refreshes: 0,
    settled: false,
  };
  return state;
});

vi.mock("../vaultSyncEngine", () => ({
  VaultSyncEngine: class {
    constructor(opts: VaultSyncEngineOptions) {
      engineHooks.opts = opts;
    }
    start() {
      engineHooks.started++;
    }
    stop() {}
    setPresence() {}
    sendVoice() {
      return false;
    }
    refresh() {
      engineHooks.refreshes++;
    }
    reconnect() { engineHooks.refreshes++; }
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return engineHooks.settled;
    }
  },
}));

/** The bridge-tiering store. `promote` hands back a bridge stub good enough for
 *  the real ContentUploader: a Y.Doc, non-empty content, no-op disk I/O. */
const storeHooks = vi.hoisted(() => ({
  opts: null as VaultDocStoreOptions | null,
  open: null as string | null,
  promoted: [] as string[],
  /** Docs the hot tier is holding a LIVE bridge for, by docId. A watcher event
   *  for one of these is supposed to be merged into the doc immediately. */
  residents: new Set<string>(),
  /** Every `peekResident(...)?.ingestNow()` the sync layer actually made. */
  residentIngests: [] as string[],
  /** Per-doc text a promoted bridge serializes to ("content" when unset). */
  texts: new Map<string, string>(),
}));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    constructor(opts: VaultDocStoreOptions) {
      storeHooks.opts = opts;
    }
    async promote(docId: string) {
      storeHooks.promoted.push(docId);
      return {
        doc: new Y.Doc(),
        serialize: () => storeHooks.texts.get(docId) ?? "content",
        ingestNow: async () => false,
        beginPull: () => {},
        abandonPull: () => {},
        hasUnmergedFileChange: async () => false,
        reconcileAfterPull: async () => false,
        seedFromFileIfEmpty: async () => {},
        flushEgest: async () => {},
      };
    }
    async demote() {}
    async release() {}
    peekResident(docId: string) {
      if (!storeHooks.residents.has(docId)) return null;
      return {
        ingestNow: async () => {
          storeHooks.residentIngests.push(docId);
          return false;
        },
      };
    }
    suppressedDoc() {
      return storeHooks.open;
    }
    setSuppressedDoc(docId: string | null) {
      storeHooks.open = docId;
    }
    async flushStateVectors() {}
    async destroyAll() {}
  },
}));

/** The per-note provider. Records the connect ORDER — which, at concurrency 1,
 *  is the queue the uploader actually built — and every teardown, so a test can
 *  assert that the provider for a doc the server no longer has is STOPPED rather
 *  than left to re-mint against a tombstone. */
const connects = vi.hoisted(() => ({ order: [] as string[], destroyed: [] as string[] }));

vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = false;
    isSynced = false;
    readonly status = "connecting";
    readonly docId: string;
    /** Enough of a y-protocols Awareness for `openDoc`'s presence stamp. */
    readonly awareness = { setLocalStateField() {}, destroy() {} };
    constructor(input: { docId: string }) {
      this.docId = input.docId;
      connects.order.push(input.docId);
    }
    async whenSynced() {
      this.isSynced = true;
    }
    async whenFlushed() {
      return true;
    }
    destroy() {
      connects.destroyed.push(this.docId);
    }
    refreshAccess() {}
  },
}));

import type { SessionInfo } from "../../api";
import * as ipc from "../../ipc";
import { SyncManager } from "../docSession";
import { vaultScopes, type SyncProgress } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

async function enable(sm: SyncManager) {
  return sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
}

/** Let the microtask queue (and the uploader's `await tick()`-free path) settle. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.pushed = new Set();
  fakeRegistry.reconcile.mockClear();
  fakeRegistry.pull.mockClear();
  fakeRegistry.markPushed.mockClear();
  fakeRegistry.mappedNotes.mockReturnValue([]);
  fakeRegistry.getMapping.mockReturnValue(null);
  fakeRegistry.pathForDocId.mockReturnValue(null);
  fakeRegistry.emptyOnDisk = new Set();
  fakeRegistry.isNoteEmptyOnDisk.mockClear();
  fakeRegistry.materialized = new Set();
  fakeRegistry.consumeMaterialized.mockClear();
  fakeRegistry.deletePath.mockClear().mockResolvedValue(undefined);
  fakeRegistry.deletePaths.mockClear().mockImplementation(async (paths: readonly string[]) =>
    paths.map((path) => ({ path, status: "deleted" as const, reason: null, code: null })),
  );
  fakeRegistry.renamePath.mockClear();
  fakeRegistry.recordFailure.mockClear();
  fakeDisk.files.clear();
  fakeDisk.shas.clear();
  fakeDisk.crdt.clear();
  fakeDisk.trashed = [];
  fakeDisk.rebinds = [];
  fakeDisk.dirs = new Set();
  fakeDisk.root = "dir";
  fakeDisk.materialized = [];
  fakeRegistry.folders = new Map();
  fakeRegistry.lastPassDrift.mockReset().mockReturnValue(null);
  fakeRegistry.renamePath.mockReset().mockResolvedValue(true);
  // A test may swap the recovery-copy writer for a failing one; put the real
  // fake back, or the failure leaks into every suite that runs after it.
  vi.mocked(ipc.writeTrashCopy).mockImplementation(
    async (path: string, stamp: string, content: string) => {
      fakeDisk.trashed.push({ path, content });
      return `.context/trash/${stamp}/${path}`;
    },
  );
  engineHooks.opts = null;
  engineHooks.started = 0;
  engineHooks.refreshes = 0;
  engineHooks.settled = false;
  storeHooks.opts = null;
  storeHooks.open = null;
  storeHooks.promoted = [];
  storeHooks.residents = new Set();
  storeHooks.residentIngests = [];
  storeHooks.texts = new Map();
  connects.order = [];
  connects.destroyed = [];
});

describe("SyncManager — download before upload", () => {
  it("starts no content run until the vault backfill has settled", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    const sm = new SyncManager();
    await enable(sm);

    // The engine is up (one socket, backfilling) and nothing has been pushed over
    // a per-note provider — that is the whole point of the reorder.
    expect(engineHooks.started).toBe(1);
    await flush();
    expect(connects.order).toEqual([]);

    // The backfill lands: `ready` (with nothing empty), then the queue drains.
    engineHooks.opts!.onServerEmpty?.([], false);
    await flush();
    expect(connects.order).toEqual([]); // still draining

    engineHooks.settled = true;
    engineHooks.opts!.onInboundIdle?.();
    await sm.whenBulkSyncSettled();
    await flush();
    expect(connects.order).toEqual(["a"]); // the one doc the backfill didn't confirm
  });

  it("a doc the backfill delivered cleanly is never pushed again", async () => {
    // `onConverged`: the cold apply wrote the server's state to disk and the file
    // had nothing of its own to add, so the server has this note BY DEFINITION.
    // Without this the run re-sent every backfilled note over its own socket.
    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "a", relPath: "A.md" },
      { docId: "b", relPath: "B.md" },
    ]);
    const sm = new SyncManager();
    await enable(sm);

    storeHooks.opts!.onConverged?.("a");
    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("a");

    engineHooks.settled = true;
    engineHooks.opts!.onServerEmpty?.([], false);
    await sm.whenBulkSyncSettled();
    await flush();
    expect(connects.order).toEqual(["b"]);
  });

  it("never marks a diverged doc pushed — its local-only ops are nobody else's", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "d", relPath: "D.md" }]);
    fakeRegistry.pathForDocId.mockReturnValue("D.md");
    const sm = new SyncManager();
    await enable(sm);

    // A cold apply merged an external edit into this doc: those ops exist only
    // here until a provider pushes them.
    storeHooks.opts!.onExternalMerge?.("d");
    storeHooks.opts!.onConverged?.("d");
    expect(fakeRegistry.markPushed).not.toHaveBeenCalled();
    fakeRegistry.pathForDocId.mockReturnValue(null);
  });
});

describe("SyncManager — ready.empty is the authority", () => {
  it("queues exactly the docs the server lacks, first, ignoring the local checkpoint", async () => {
    // The prod state: every note is "pushed" locally, and the server holds no
    // content for two of them.
    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "keep", relPath: "Keep.md" },
      { docId: "lost-2", relPath: "Lost2.md" },
      { docId: "fresh", relPath: "Fresh.md" },
      { docId: "lost-1", relPath: "Lost1.md" },
      { docId: OPEN_DOC, relPath: "Open.md" },
    ]);
    for (const id of ["keep", "lost-1", "lost-2", OPEN_DOC]) fakeRegistry.pushed.add(id);
    const sm = new SyncManager();
    await enable(sm);
    // The note the user has open: its editor session owns that doc's provider.
    storeHooks.open = OPEN_DOC;

    engineHooks.settled = true;
    // `unmapped` is a doc id this device knows nothing about (a note it cannot
    // see, or one deleted locally) — it must not manufacture work.
    engineHooks.opts!.onServerEmpty?.(["lost-1", "lost-2", "unmapped", OPEN_DOC], false);
    await sm.whenBulkSyncSettled();
    await flush();

    // Empty-on-the-server first (in the order the vault lists them), then the
    // genuinely unconfirmed note. The open doc and the unmapped id are absent.
    expect(connects.order).toEqual(["lost-2", "lost-1", "fresh"]);
    expect(engineHooks.refreshes).toBe(0); // nothing was truncated
  });

  it("pushes a doc the server says this device is AHEAD on, despite the local checkpoint", async () => {
    // The other way the checkpoint lies: the server HAS the note, but not all of
    // it — this device holds ops (an edit typed offline, a push cut short) the
    // server never received. `pushed` says done; the server's `ready.behind`
    // outranks it. Before this, such a doc was badged synced forever, its edits
    // never left the machine, and every connect re-delivered a 2-byte empty diff
    // for it — 40 of them made one vault "sync 40 notes" on every reload.
    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "same", relPath: "Same.md" },
      { docId: "ahead", relPath: "Ahead.md" },
    ]);
    fakeRegistry.pushed.add("same");
    fakeRegistry.pushed.add("ahead");
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;

    // The server's `ready`: `behind` lands right before `empty`, as the engine
    // delivers them.
    engineHooks.opts!.onServerBehind?.(["ahead"]);
    engineHooks.opts!.onServerEmpty?.([], false);
    await sm.whenBulkSyncSettled();
    await flush();

    expect(connects.order).toEqual(["ahead"]);

    // Confirmed by that push: the next `ready` that no longer names it queues
    // nothing — no loop.
    engineHooks.opts!.onServerBehind?.([]);
    engineHooks.opts!.onServerEmpty?.([], false);
    await sm.whenBulkSyncSettled();
    await flush();
    expect(connects.order).toEqual(["ahead"]);
  });

  it("settles a server-empty doc whose local file is empty too - no push, ever", async () => {
    // The production loop behind "310 files re-syncing on every reload": the
    // vault holds hundreds of zero-byte placeholder notes. The server has no
    // content for them (there is none), names them on every `ready`, and the run
    // pushed each one over its own socket - seeding nothing - every connect.
    const notes = [
      { docId: "stub-1", relPath: "Daily/_Index.md" },
      { docId: "stub-2", relPath: "Departments/_Index.md" },
      { docId: "real", relPath: "Real.md" },
    ];
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.pathForDocId.mockImplementation(
      (docId: string) => notes.find((n) => n.docId === docId)?.relPath ?? null,
    );
    fakeRegistry.emptyOnDisk = new Set(["Daily/_Index.md", "Departments/_Index.md"]);
    for (const n of notes) fakeRegistry.pushed.add(n.docId);
    const sm = new SyncManager();
    const badges: Record<string, string> = {};
    sm.setDocStateListener((patch) => {
      for (const [id, state] of Object.entries(patch)) if (state) badges[id] = state;
    });
    await enable(sm);
    engineHooks.settled = true;

    engineHooks.opts!.onServerEmpty?.(["stub-1", "stub-2", "real"], false);
    await sm.whenBulkSyncSettled();
    await flush();

    // Only the note with bytes to give dialled the server; the stubs were settled
    // from disk, badged synced, and recorded as confirmed.
    expect(connects.order).toEqual(["real"]);
    expect(badges["stub-1"]).toBe("synced");
    expect(badges["stub-2"]).toBe("synced");
    expect(fakeRegistry.isNoteEmptyOnDisk).toHaveBeenCalledTimes(3);

    // The next connect names them again (the server still has nothing, which is
    // correct). This time not even the disk is consulted: nothing re-queues.
    fakeRegistry.isNoteEmptyOnDisk.mockClear();
    engineHooks.opts!.onServerEmpty?.(["stub-1", "stub-2"], false);
    await sm.whenBulkSyncSettled();
    await flush();
    expect(connects.order).toEqual(["real"]);
    expect(fakeRegistry.isNoteEmptyOnDisk).not.toHaveBeenCalled();
  });

  it("asks for the next batch when the server truncated its list", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;
    engineHooks.opts!.onServerEmpty?.(["a"], true);
    await sm.whenBulkSyncSettled();
    await flush();

    expect(connects.order).toEqual(["a"]);
    // One re-hello, not a loop: the flag is consumed, so the next `ready` decides
    // afresh whether there is more.
    expect(engineHooks.refreshes).toBe(1);
  });

  it("does not re-hello after a run that sent nothing (no tight loop)", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    fakeRegistry.pushed.add("a");
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;
    // Truncated, but every doc it named is one we already confirmed and it named
    // nothing we can act on — pushing nothing must not earn another handshake.
    engineHooks.opts!.onServerEmpty?.(["zz-unmapped"], true);
    await sm.whenBulkSyncSettled();
    await flush();
    expect(connects.order).toEqual([]);
    expect(engineHooks.refreshes).toBe(0);
  });

  it("a ready during a live run refreshes the list without starting a second run", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "a", relPath: "A.md" },
      { docId: "b", relPath: "B.md" },
    ]);
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;
    engineHooks.opts!.onServerEmpty?.([], false);
    // Two more `ready` frames while the first run is in flight.
    engineHooks.opts!.onServerEmpty?.([], false);
    engineHooks.opts!.onServerEmpty?.([], false);
    await sm.whenBulkSyncSettled();
    await flush();
    // Each doc connected exactly once: no second run doubled the work.
    expect(connects.order).toEqual(["a", "b"]);
  });

  it("badges every confirmed note synced even when there is nothing to send", async () => {
    // Only a run's uploader used to stamp confirmed docs `synced`; a fully
    // synced vault (empty work list ⇒ no run) sat on unsynced badges until
    // something happened to start one.
    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "a", relPath: "A.md" },
      { docId: "b", relPath: "B.md" },
      { docId: OPEN_DOC, relPath: "Open.md" },
    ]);
    for (const id of ["a", "b", OPEN_DOC]) fakeRegistry.pushed.add(id);
    const sm = new SyncManager();
    const badges: Record<string, string> = {};
    sm.setDocStateListener((patch) => {
      for (const [id, state] of Object.entries(patch)) if (state) badges[id] = state;
    });
    await enable(sm);
    storeHooks.open = OPEN_DOC;
    engineHooks.settled = true;
    engineHooks.opts!.onServerEmpty?.([], false);
    engineHooks.opts!.onInboundIdle?.();
    await flush();
    expect(connects.order).toEqual([]);
    expect(badges).toEqual({ a: "synced", b: "synced" }); // the open note reports itself
  });

  it("reaches a terminal phase with nothing to send, and does not re-stamp it", async () => {
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    fakeRegistry.pushed.add("a");
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    await enable(sm);
    engineHooks.settled = true;
    engineHooks.opts!.onInboundIdle?.();
    await flush();
    expect(progress[progress.length - 1]?.phase).toBe("done");

    // A teammate typing keeps draining the inbound queue, which fires this edge
    // over and over. Re-stamping `done` there is a store write per keystroke.
    const settledAt = progress.length;
    for (let i = 0; i < 5; i++) engineHooks.opts!.onInboundIdle?.();
    await flush();
    expect(progress).toHaveLength(settledAt);
  });

  it("stops claiming 'Syncing…' when the vault channel never connects, and recovers on ready", async () => {
    vi.useFakeTimers();
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    fakeRegistry.pushed.add("a");
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    await enable(sm);
    // The engine is started but its socket never opens: no status, no ready.
    engineHooks.opts!.onStatus?.("error");
    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    // The download phase gave up: the pill must not read "Syncing…" forever.
    expect(progress[progress.length - 1]?.phase).toBe("error");

    // The server comes back: hello → backfill → ready. The stall clears and the
    // run lands on `done` exactly as it would have without the outage.
    engineHooks.settled = true;
    engineHooks.opts!.onStatus?.("synced");
    engineHooks.opts!.onServerEmpty?.([], false);
    engineHooks.opts!.onInboundIdle?.();
    await flush();
    expect(progress[progress.length - 1]?.phase).toBe("done");
    vi.useRealTimers();
  });

  it("does not trip the watchdog once the channel has reached ready", async () => {
    vi.useFakeTimers();
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    fakeRegistry.pushed.add("a");
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    await enable(sm);
    engineHooks.opts!.onStatus?.("synced");
    engineHooks.opts!.onServerEmpty?.([], false);
    // A slow backfill is still draining well past the watchdog window.
    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect(progress[progress.length - 1]?.phase).not.toBe("error");
    vi.useRealTimers();
  });

  it("starts a fresh bulk download after a large live grant and its registry pull", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;
    engineHooks.opts!.onInboundIdle?.();
    await flush();
    const bulk = vi.spyOn(sm as unknown as { runBulkEngine(scope: unknown): Promise<void> }, "runBulkEngine")
      .mockResolvedValue();
    fakeRegistry.pull.mockClear();
    engineHooks.opts!.onBootstrapRequired?.();
    expect(bulk).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(251);
    await flush();
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(engineHooks.refreshes).toBeGreaterThan(0);
    sm.disable();
    vi.useRealTimers();
  });

  it("keeps download progress alive while a paused connection is draining content", async () => {
    vi.useFakeTimers();
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "a", relPath: "A.md" }]);
    fakeRegistry.pushed.add("a");
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    await enable(sm);
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      engineHooks.opts!.onInboundProgress?.(i, 10);
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(progress[progress.length - 1]?.phase).toBe("downloading");
    expect(progress[progress.length - 1]?.done).toBe(4);
    sm.disable();
    vi.useRealTimers();
  });
});

describe("SyncManager.handleLocalFilesChanged", () => {
  it("folds a whole watcher batch into ONE registry pull", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    // An AI writing a folder full of new notes: 40 unmapped files plus the
    // directory itself, all in one watcher batch.
    const changes = [
      { path: "Imported", kind: "tree" as const },
      ...Array.from({ length: 40 }, (_, i) => ({
        path: `Imported/n${i}.md`,
        kind: "modified" as const,
      })),
    ];
    sm.handleLocalFilesChanged(changes);
    expect(sm.hasPendingRegistryPull()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("queues mapped notes for a content push without pulling the registry", async () => {
    vi.useFakeTimers();
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Mapped.md" ? { vaultId: "collection-1", docId: "m1" } : null,
    );
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([{ path: "Mapped.md", kind: "modified" }]);
    expect(sm.hasPendingRegistryPull()).toBe(false); // nothing structural happened
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    fakeRegistry.getMapping.mockReturnValue(null);
    vi.useRealTimers();
  });

  it("ignores the watcher echo of the registry's OWN materialized placeholder", async () => {
    // #93's trigger. The pull creates a 0-byte file for a server-only note; the
    // watcher reports it as a `modified` for a path the registry maps, and the
    // content push then diff-merged that emptiness into the note's populated
    // CRDT and sent it. One echo per created path is dropped instead.
    vi.useFakeTimers();
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Fresh.md" ? { vaultId: "collection-1", docId: "f1" } : null,
    );
    fakeRegistry.materialized = new Set(["Fresh.md"]);
    const sm = new SyncManager();
    await enable(sm);

    sm.handleLocalFilesChanged([{ path: "Fresh.md", kind: "modified", unchanged: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connects.order).toEqual([]); // nothing was pushed for it

    // The NEXT change to the same file is a real one and pushes normally.
    fakeRegistry.pushed.add("f1");
    sm.handleLocalFilesChanged([{ path: "Fresh.md", kind: "modified" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storeHooks.promoted).toContain("f1");
    fakeRegistry.getMapping.mockReturnValue(null);
    vi.useRealTimers();
  });

  it("does not swallow a real edit coalesced with a materialized placeholder echo", async () => {
    vi.useFakeTimers();
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Fresh.md" ? { vaultId: "collection-1", docId: "f1" } : null,
    );
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "f1", relPath: "Fresh.md" }]);
    fakeRegistry.pushed.add("f1");
    fakeRegistry.materialized = new Set(["Fresh.md"]);
    const sm = new SyncManager();
    await enable(sm);
    sm.handleLocalFilesChanged([{ path: "Fresh.md", kind: "modified", unchanged: false }]);
    await vi.advanceTimersByTimeAsync(1000);
    // The local-change fast path may settle without opening a socket, but the
    // edit must reach the bridge instead of being discarded as an echo.
    expect(storeHooks.promoted).toContain("f1");
    expect(fakeRegistry.materialized.size).toBe(0);
    fakeRegistry.getMapping.mockReturnValue(null);
    fakeRegistry.mappedNotes.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("ignores the watcher echo of a folder the pull itself created or removed — no pull chain", async () => {
    // #98's engine. A pull created (or removed) a directory; the watcher reported
    // it as a `tree` change; `tree` meant "structural, pull again"; that pull
    // undid the first one's write… Each pass's own disk write requested the next,
    // ~1.5 s apart, for days. The pull now remembers the folders it touches and
    // their echo is consumed here, so no planner mistake can chain pulls again.
    vi.useFakeTimers();
    fakeRegistry.materialized = new Set(["Projects/Community/Content/pipeline"]);
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([{ path: "Projects/Community/Content/pipeline", kind: "tree" }]);
    expect(sm.hasPendingRegistryPull()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    expect(fakeRegistry.materialized.size).toBe(0); // one echo, consumed

    // The same path changing AGAIN is a real structural change and pulls.
    sm.handleLocalFilesChanged([{ path: "Projects/Community/Content/pipeline", kind: "tree" }]);
    expect(sm.hasPendingRegistryPull()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("never lets a binary reach the note path — no pull, no push, no `notes` row", async () => {
    // A `.docx` dropped into a folder is the blob mirror's, and everything in
    // this method reads an unmapped file as a note nobody has registered yet.
    // `App.tsx` short-circuits it; this is the same rule where the damage would
    // be done (`routesToAttachmentSync`).
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([
      { path: "Team/report.docx", kind: "tree" },
      { path: "Media/clip.mp4", kind: "modified" },
      { path: "attachments/abc.png", kind: "tree" },
      { path: "Team/gone.xlsx", kind: "removed" },
    ]);
    expect(sm.hasPendingRegistryPull()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    expect(connects.order).toEqual([]);

    // A note in the same batch still routes normally.
    sm.handleLocalFilesChanged([
      { path: "Team/report.docx", kind: "tree" },
      { path: "Team/Plan.md", kind: "modified" },
    ]);
    expect(sm.hasPendingRegistryPull()).toBe(true);
    vi.useRealTimers();
  });

  it("the single-event form still routes exactly like one batch of one", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();
    sm.handleLocalFileChanged("New.md", "modified");
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ---- `unchanged` entries (#155) ------------------------------------------
  //
  // Rust now says, per `modified` entry, whether the file's sha256 still equals
  // the one the index already held. Our own egest echo, a materialized
  // placeholder echoing back, `git checkout` restoring identical bytes, a backup
  // tool touching files, and — the trigger — Linux's spurious inotify READ
  // events all arrive that way. An idle vault can emit hundreds of them, so they
  // have to cost the sync layer exactly its bookkeeping and nothing else.

  it("an unchanged entry for a mapped doc queues no push and never re-ingests a resident doc", async () => {
    vi.useFakeTimers();
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Idle.md" ? { vaultId: "collection-1", docId: "i1" } : null,
    );
    fakeRegistry.pushed.add("i1");
    storeHooks.residents.add("i1"); // a live bridge in the hot tier
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([{ path: "Idle.md", kind: "modified", unchanged: true }]);
    expect(sm.inspectDoc("i1").queued).toBe(false);
    expect(storeHooks.residentIngests).toEqual([]);
    expect(sm.hasPendingRegistryPull()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    expect(storeHooks.promoted).toEqual([]);
    expect(connects.order).toEqual([]);

    // The same path with NEW bytes is the ordinary path, untouched: queued,
    // merged into the resident doc, and pushed.
    sm.handleLocalFilesChanged([{ path: "Idle.md", kind: "modified" }]);
    expect(sm.inspectDoc("i1").queued).toBe(true);
    expect(storeHooks.residentIngests).toEqual(["i1"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(storeHooks.promoted).toContain("i1");
    fakeRegistry.getMapping.mockReturnValue(null);
    vi.useRealTimers();
  });

  it("an unchanged entry still spends the registry's materialized echo", async () => {
    // A materialized placeholder IS an unchanged `modified`: Rust wrote the
    // 0-byte file and re-indexed it, so the watcher's read finds the sha it just
    // stored. The claim has to be spent by the EVENT, not by what the event
    // turned out to contain — otherwise the note's first real edit, whenever it
    // comes, is the one that gets mistaken for the echo and dropped.
    vi.useFakeTimers();
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Fresh.md" ? { vaultId: "collection-1", docId: "f1" } : null,
    );
    fakeRegistry.materialized = new Set(["Fresh.md"]);
    const sm = new SyncManager();
    await enable(sm);

    sm.handleLocalFilesChanged([{ path: "Fresh.md", kind: "modified", unchanged: true }]);
    expect(fakeRegistry.materialized.size).toBe(0); // consumed, exactly once
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connects.order).toEqual([]);
    fakeRegistry.getMapping.mockReturnValue(null);
    vi.useRealTimers();
  });

  it("an unchanged entry for an UNMAPPED path still asks for a registry pull", async () => {
    // "Unchanged" is a statement about the index, not about the server. A file
    // the registry does not map has never been registered, however old its bytes
    // are — dropping it here is how a note stays invisible to the team forever.
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([{ path: "Unregistered.md", kind: "modified", unchanged: true }]);
    expect(sm.hasPendingRegistryPull()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("an unchanged entry does not reopen a permanent failure", async () => {
    // The other verdict about the file's bytes. A note over `MAX_NOTE_BYTES`
    // fails ONCE, permanently, without a socket; only bytes that actually moved
    // can make it worth trying again. A read event re-queueing it would put the
    // 10 MB read back on every watcher tick, forever.
    vi.useFakeTimers();
    fakeDisk.files.set("Huge.md", "x".repeat(11 * 1024 * 1024));
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Huge.md" ? { vaultId: "collection-1", docId: "h1" } : null,
    );
    fakeRegistry.pathForDocId.mockImplementation((d: string) => (d === "h1" ? "Huge.md" : null));
    const sm = new SyncManager();
    await enable(sm);

    sm.handleLocalFilesChanged([{ path: "Huge.md", kind: "modified" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(sm.inspectDoc("h1").permanentFailure).toMatch(/too large/);

    sm.handleLocalFilesChanged([{ path: "Huge.md", kind: "modified", unchanged: true }]);
    expect(sm.inspectDoc("h1").permanentFailure).toMatch(/too large/);
    expect(sm.inspectDoc("h1").queued).toBe(false);

    // Trimmed under the ceiling — real new bytes, so the verdict is void.
    sm.handleLocalFilesChanged([{ path: "Huge.md", kind: "modified" }]);
    expect(sm.inspectDoc("h1").permanentFailure).toBeNull();
    expect(sm.inspectDoc("h1").queued).toBe(true);

    fakeRegistry.getMapping.mockReturnValue(null);
    fakeRegistry.pathForDocId.mockReturnValue(null);
    vi.useRealTimers();
  });

  it("an unchanged entry does not clear the `empty everywhere` verdict the file earned", async () => {
    // `emptyEverywhere` and `permanentFailures` are cleared by the SAME skipped
    // line, and both are verdicts about the file's BYTES — which an unchanged
    // event says have not moved. Re-opening them would put the doc back in the
    // work list on every read event, which is the "re-syncing 307 notes" bug
    // wearing a different hat.
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "e1", relPath: "Empty.md" }]);
    fakeRegistry.getMapping.mockImplementation((relPath: string) =>
      relPath === "Empty.md" ? { vaultId: "collection-1", docId: "e1" } : null,
    );
    fakeRegistry.pathForDocId.mockImplementation((d: string) => (d === "e1" ? "Empty.md" : null));
    fakeRegistry.emptyOnDisk = new Set(["Empty.md"]);
    fakeDisk.files.set("Empty.md", "");
    const sm = new SyncManager();
    await enable(sm);
    engineHooks.settled = true;
    engineHooks.opts!.onServerEmpty?.(["e1"], false);
    await sm.whenBulkSyncSettled();
    await flush();
    expect(sm.inspectDoc("e1").emptyEverywhere).toBe(true);

    sm.handleLocalFilesChanged([{ path: "Empty.md", kind: "modified", unchanged: true }]);
    expect(sm.inspectDoc("e1").emptyEverywhere).toBe(true);
    expect(sm.inspectDoc("e1").queued).toBe(false);

    // New bytes void it: the placeholder may hold text now.
    sm.handleLocalFilesChanged([{ path: "Empty.md", kind: "modified" }]);
    expect(sm.inspectDoc("e1").emptyEverywhere).toBe(false);
    expect(sm.inspectDoc("e1").queued).toBe(true);

    sm.disable();
    await sm.whenBulkSyncSettled();
    fakeRegistry.getMapping.mockReturnValue(null);
    fakeRegistry.pathForDocId.mockReturnValue(null);
  });
});

/**
 * A disk delete is a real delete (#93).
 *
 * Deleting a synced note's `.md` in Finder used to be dropped on the floor, and
 * the next unrelated registry pull re-created it as a 0-byte placeholder — whose
 * emptiness was then diff-merged into the note's still-populated CRDT and PUSHED,
 * destroying the server's copy. So the removal now propagates as the same soft
 * delete the sidebar's Delete makes, behind a grace window that filters out
 * everything which merely looks like a delete for a moment.
 *
 * The window is the whole design, and each test below is one thing it has to
 * survive.
 */
describe("SyncManager — a burst of registry frames is ONE pull", () => {
  it("never lets a stream of frames push the debounced pull back indefinitely", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await enable(sm);
    fakeRegistry.pull.mockClear();

    // The server coalesces its own structural broadcasts into ~8 windows a second
    // (`REGISTRY_COALESCE_MS`), and one window can carry BOTH `reauth` and
    // `registry` — so during a delete drain or a bulk register, frames arrive
    // faster than the 250ms debounce for as long as the storm lasts. Every frame
    // used to clear and re-arm that timer, which is starvation, not coalescing:
    // the pull ran only once the storm stopped.
    for (let i = 0; i < 40; i++) {
      engineHooks.opts!.onRegistryChanged?.();
      await vi.advanceTimersByTimeAsync(100);
    }

    // Four seconds of unbroken frames: the pull has actually run…
    expect(fakeRegistry.pull).toHaveBeenCalled();
    // …and a handful of times, not once per frame.
    expect(fakeRegistry.pull.mock.calls.length).toBeLessThanOrEqual(6);
    vi.useRealTimers();
  });
});

describe("SyncManager — leftover CRDT history is reclaimed while idle", () => {
  it("a pull in a live session arms ONE debounced sweep over the registry ids and the open doc", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    fakeRegistry.allDocIds.mockReturnValue(["reg-1", "reg-2"]);
    await enable(sm);
    engineHooks.opts!.onStatus?.("synced");
    await vi.advanceTimersByTimeAsync(300);
    expect(sm.isLive()).toBe(true);
    // Let anything the startup/catch-up path armed run out first.
    await vi.advanceTimersByTimeAsync(6_000);
    const prune = vi.mocked(ipc.pruneYjsDocs);
    prune.mockClear();
    storeHooks.open = OPEN_DOC;

    // Two pulls a second apart: the second re-arms the same timer.
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(1_000);
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sm.hasPendingCrdtSweep()).toBe(true);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(prune).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(prune).toHaveBeenCalledTimes(1);
    const live = prune.mock.calls[0][0] as string[];
    expect(live).toEqual(expect.arrayContaining(["reg-1", "reg-2", OPEN_DOC]));

    // Nothing further without another trigger.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prune).toHaveBeenCalledTimes(1);
    fakeRegistry.allDocIds.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("arms nothing before the session is live, and nothing after a vault switch", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    fakeRegistry.allDocIds.mockReturnValue(["reg-1"]);
    await enable(sm);
    const prune = vi.mocked(ipc.pruneYjsDocs);
    prune.mockClear();
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sm.isLive()).toBe(false);
    expect(sm.hasPendingCrdtSweep()).toBe(false);

    engineHooks.opts!.onStatus?.("synced");
    await vi.advanceTimersByTimeAsync(300);
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sm.hasPendingCrdtSweep()).toBe(true);
    sm.disable();
    expect(sm.hasPendingCrdtSweep()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prune).not.toHaveBeenCalled();
    fakeRegistry.allDocIds.mockReturnValue([]);
    vi.useRealTimers();
  });
});

describe("SyncManager — disk deletes propagate under a grace window", () => {
  /** Sync enabled AND live: the channel is `synced` and a pull has landed, which
   *  is the point from which a vanished file is news rather than a disk still
   *  catching up (a startup-missing file re-materializes instead). */
  async function live(sm: SyncManager) {
    await enable(sm);
    engineHooks.opts!.onStatus?.("synced");
    await vi.advanceTimersByTimeAsync(300);
  }

  /** Run out the grace window AND the drain's async chain.
   *
   *  The chain is not pure microtasks: the rename hash goes through
   *  `crypto.subtle.digest`, which resolves off the microtask queue, so a single
   *  `advanceTimersByTimeAsync` past the window can return with the drain still
   *  mid-flight. Repeated small advances give it real event-loop turns. */
  async function drain() {
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(300);
      // A real turn, not a faked one: without it the digest can still be
      // in flight when the loop ends, and a slow CI runner shows exactly that.
      await realTick();
    }
  }

  function mapOne(relPath: string, docId = "d1") {
    fakeRegistry.getMapping.mockImplementation((p: string) =>
      p === relPath ? { vaultId: "collection-1", docId } : null,
    );
    fakeRegistry.mappedNotes.mockReturnValue([{ docId, relPath }]);
    fakeRegistry.pushed.add(docId);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("propagates a delete after the grace window without retaining a copy", async () => {
    const sm = new SyncManager();
    mapOne("Notes/Gone.md");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Notes/Gone.md", kind: "removed" }]);
    // Nothing yet — the window is what makes an atomic save safe.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();

    await drain();
    expect(fakeDisk.trashed).toEqual([]);
    expect(fakeRegistry.deletePath).toHaveBeenCalledWith("Notes/Gone.md");
    vi.useRealTimers();
  });

  it("sweeps leftover CRDT history right after a delete drain removed a note", async () => {
    const sm = new SyncManager();
    mapOne("Notes/Gone.md");
    fakeRegistry.allDocIds.mockReturnValue(["other"]);
    await live(sm);
    await vi.advanceTimersByTimeAsync(6_000);
    const prune = vi.mocked(ipc.pruneYjsDocs);
    prune.mockClear();

    sm.handleLocalFilesChanged([{ path: "Notes/Gone.md", kind: "removed" }]);
    await drain();
    expect(fakeRegistry.deletePath).toHaveBeenCalledWith("Notes/Gone.md");
    // Immediate, but never within 5 s of the previous sweep.
    expect(sm.hasPendingCrdtSweep() || prune.mock.calls.length > 0).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(prune).toHaveBeenCalledTimes(1);
    fakeRegistry.allDocIds.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("a `modified` for the same path inside the window CANCELS the delete", async () => {
    // A third-party editor that saves by unlinking and rewriting, and a
    // rename-back, both look exactly like this.
    const sm = new SyncManager();
    mapOne("Saved.md");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Saved.md", kind: "removed" }]);
    sm.handleLocalFilesChanged([{ path: "Saved.md", kind: "modified" }]);
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeDisk.trashed).toEqual([]);
    vi.useRealTimers();
  });

  it("an UNCHANGED `modified` inside the window cancels the delete just the same", async () => {
    // An editor that saves by unlinking and rewriting, a `git checkout` back to
    // HEAD, a rename-there-and-back: the rewritten bytes are identical, so the
    // watcher reports `unchanged`. The delete is still off — the point of the
    // `modified` half is that the file EXISTS, not that it differs (#155).
    const sm = new SyncManager();
    mapOne("Reverted.md");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Reverted.md", kind: "removed" }]);
    sm.handleLocalFilesChanged([{ path: "Reverted.md", kind: "modified", unchanged: true }]);
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeDisk.trashed).toEqual([]);
    vi.useRealTimers();
  });

  it("does not propagate when the file is back on disk by drain time", async () => {
    const sm = new SyncManager();
    mapOne("Checkout.md");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Checkout.md", kind: "removed" }]);
    // `git checkout` puts it back without a watcher event we happened to route.
    fakeDisk.files.set("Checkout.md", "# back");
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("never propagates a note whose content this device never confirmed", async () => {
    // The only copy of that work may be local. Same rule the inbound trash
    // executor applies before it takes a file away.
    const sm = new SyncManager();
    mapOne("Unconfirmed.md", "d-unpushed");
    fakeRegistry.pushed.delete("d-unpushed");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Unconfirmed.md", kind: "removed" }]);
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("propagates nothing before the session is live", async () => {
    // Startup: the vault channel has not reached `synced`, so a missing file is
    // a disk that isn't ready (an unmounted drive, a fresh clone), not a delete.
    const sm = new SyncManager();
    mapOne("Early.md");
    await enable(sm);
    expect(sm.isLive()).toBe(false);

    sm.handleLocalFilesChanged([{ path: "Early.md", kind: "removed" }]);
    await drain();
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("holds the WHOLE batch for the user when too many notes vanish at once", async () => {
    // An unmounted volume, a `git checkout`, an iCloud eviction: hundreds of
    // removals in one batch, each individually plausible. The cap is a fifth of
    // the vault, never fewer than five.
    const sm = new SyncManager();
    const notes = Array.from({ length: 20 }, (_, i) => ({
      docId: `m${i}`,
      relPath: `N${i}.md`,
    }));
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.getMapping.mockImplementation((p: string) => {
      const hit = notes.find((n) => n.relPath === p);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    });
    for (const n of notes) fakeRegistry.pushed.add(n.docId);
    await live(sm);

    // Five would be allowed (20 × 0.2 = 4, floored at 5); six is not.
    sm.handleLocalFilesChanged(
      notes.slice(0, 6).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeDisk.trashed).toEqual([]); // nothing at all happened
    // …and, with the vault root present in a live session, the batch is held
    // for the user's answer (#221) rather than silently undone.
    expect(sm.pendingDeleteDecision()?.map((d) => d.docId)).toEqual(
      notes.slice(0, 6).map((n) => n.docId),
    );
    expect(sm.structureNotice().pendingDelete).toEqual({ count: 6 });
    vi.useRealTimers();
  });

  it("refuses an over-cap batch BEFORE it hydrates a single doc", async () => {
    // The shape this ordering exists for: an unmounted volume used to pay N
    // `note_exists` IPCs AND N CRDT hydrations (a `load_yjs_state`, a full
    // decode and a demote apiece) and only THEN be refused — maximum cost, zero
    // result. The existence re-check stays (pooled: it is the "is it really
    // gone" guard and it is what the cap counts); everything expensive must not
    // happen at all.
    const sm = new SyncManager();
    const notes = Array.from({ length: 50 }, (_, i) => ({
      docId: `big${i}`,
      relPath: `B${i}.md`,
    }));
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.getMapping.mockImplementation((p: string) => {
      const hit = notes.find((n) => n.relPath === p);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    });
    for (const n of notes) fakeRegistry.pushed.add(n.docId);
    await live(sm);
    storeHooks.promoted = [];

    // Cap is 10 (50 × 0.2); 30 vanish at once.
    sm.handleLocalFilesChanged(
      notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    // Not one doc was opened, not one byte was trashed, nothing was propagated…
    expect(storeHooks.promoted).toEqual([]);
    expect(fakeDisk.trashed).toEqual([]);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    // …and the whole batch is held for the user, not a prefix of it.
    expect(sm.pendingDeleteDecision()).toHaveLength(30);
    vi.useRealTimers();
  });

  it("keeps every rename in an over-cap window, and refuses only the deletes", async () => {
    // The shape the EARLY cap must never decide: a `git checkout` of a branch
    // where a folder was renamed (150 files) and 150 stale notes were deleted.
    // The drain has already drained `renameCandidates`, so refusing before the
    // pairing would throw those 150 away for good — the old paths would
    // re-materialize as ghosts on the next pull and the new paths would register
    // as brand-new doc_ids. 300 notes where there were 150: the 2026-08-25 fork.
    const sm = new SyncManager();
    const notes = Array.from({ length: 200 }, (_, i) => ({
      docId: `fk${i}`,
      relPath: `F${i}.md`,
    }));
    const byPath = new Map(notes.map((n) => [n.relPath, n]));
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.getMapping.mockImplementation((p: string) => {
      const hit = byPath.get(p);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    });
    for (const n of notes) fakeRegistry.pushed.add(n.docId);
    await live(sm);

    // Every promoted doc serializes to "content", so every renamed file's index
    // row reports that hash — the pairing signal.
    const sha = createHash("sha256").update("content", "utf8").digest("hex");
    const renamed = notes.slice(0, 150);
    const deleted = notes.slice(150); // 50, over the cap of max(5, ceil(200*0.2)) = 40
    const events: Array<{ path: string; kind: "modified" | "removed" }> = [];
    renamed.forEach((n, i) => {
      const to = `Moved/F${i}.md`;
      fakeDisk.files.set(to, "content");
      fakeDisk.shas.set(to, sha);
      events.push({ path: to, kind: "modified" });
      events.push({ path: n.relPath, kind: "removed" });
    });
    for (const n of deleted) events.push({ path: n.relPath, kind: "removed" });

    sm.handleLocalFilesChanged(events);
    // Step 3 pairs SERIALLY, and each pairing awaits a real `crypto.subtle`
    // digest — 150 of them need 150 real event-loop turns, not the dozen
    // `drain()` gives a one-note case.
    await vi.advanceTimersByTimeAsync(3_000);
    for (let i = 0; i < 400 && fakeRegistry.renamePath.mock.calls.length < 150; i++) {
      await vi.advanceTimersByTimeAsync(10);
      await realTick();
    }
    await drain();

    // Every rename kept its doc_id, on the server row AND on the index row.
    expect(fakeRegistry.renamePath).toHaveBeenCalledTimes(150);
    expect(fakeDisk.rebinds).toHaveLength(150);
    // …and the 50 real deletes were abandoned as a whole batch: no trash copy,
    // no server delete, single or batched.
    expect(fakeDisk.trashed).toEqual([]);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
    // The held question names the 50 DELETES, never the 150 notes that merely
    // moved (the early check used to report `gone` — 200 — against every
    // renamed note).
    expect(sm.pendingDeleteDecision()).toHaveLength(50);
    vi.useRealTimers();
  });

  it("pairs a rename by content hash instead of deleting and re-registering", async () => {
    // `notify` gives no rename pairing: an external rename is an unpaired
    // `removed` + `modified` in ONE batch. Matching the vanished doc's text
    // against the new file's hash is what keeps the doc_id — and with it the
    // note's history and its backlinks.
    const sm = new SyncManager();
    mapOne("Old.md");
    await live(sm);
    fakeRegistry.pull.mockClear();

    // The store's bridge stub serializes to "content"; the index reports the same
    // hash for the file that appeared.
    const sha = createHash("sha256").update("content", "utf8").digest("hex");
    fakeDisk.files.set("New.md", "content");
    fakeDisk.shas.set("New.md", sha);

    sm.handleLocalFilesChanged([
      { path: "New.md", kind: "modified" },
      { path: "Old.md", kind: "removed" },
    ]);
    // The registry pull WAITS for the drain: pulling first would register New.md
    // as a brand-new note seconds before the rename could be recognised.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();

    await drain();
    expect(fakeRegistry.renamePath).toHaveBeenCalledWith("Old.md", "New.md");
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    // The index row the watcher minted a fresh uuid for gets the doc_id back.
    expect(fakeDisk.rebinds).toEqual([{ path: "New.md", docId: "d1" }]);
    // …and only then does the pull run.
    expect(fakeRegistry.pull).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("deletes when the file that appeared is a DIFFERENT note", async () => {
    const sm = new SyncManager();
    mapOne("Old.md");
    await live(sm);

    fakeDisk.files.set("Unrelated.md", "something else");
    fakeDisk.shas.set(
      "Unrelated.md",
      createHash("sha256").update("something else", "utf8").digest("hex"),
    );

    sm.handleLocalFilesChanged([
      { path: "Unrelated.md", kind: "modified" },
      { path: "Old.md", kind: "removed" },
    ]);
    await drain();

    expect(fakeRegistry.renamePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePath).toHaveBeenCalledWith("Old.md");
    vi.useRealTimers();
  });

  /** `n` mapped notes, every one confirmed pushed — a vault big enough that the
   *  blast-radius cap (a fifth of it) allows the deletes a test then makes. */
  function mapMany(n: number) {
    const notes = Array.from({ length: n }, (_, i) => ({ docId: `bd${i}`, relPath: `D${i}.md` }));
    const byPath = new Map(notes.map((x) => [x.relPath, x]));
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.getMapping.mockImplementation((p: string) => {
      const hit = byPath.get(p);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    });
    for (const x of notes) fakeRegistry.pushed.add(x.docId);
    return notes;
  }

  it("sends a big window of disk deletes as ONE batch, not N single deletes", async () => {
    // A `git clean`, a folder dragged to the Trash in Finder, a sync client
    // pruning: 30 notes vanish at once. That used to be 30 serial DELETEs, each
    // re-resolving the permission algebra and each broadcasting a
    // `registry-changed` every peer re-pulled on.
    const sm = new SyncManager();
    const notes = mapMany(200); // cap is 40, so 30 is well inside it
    await live(sm);

    sm.handleLocalFilesChanged(
      notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePaths).toHaveBeenCalledTimes(1);
    expect(fakeRegistry.deletePaths.mock.calls[0][0]).toEqual(
      notes.slice(0, 30).map((n) => n.relPath),
    );
    expect(fakeDisk.trashed).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps the per-note call below the bulk threshold", async () => {
    // 10 deletes: one request each is already sub-second, and a rarely-exercised
    // safety path IS the bug — so the small case stays on the path it has
    // always taken.
    const sm = new SyncManager();
    const notes = mapMany(200);
    await live(sm);

    sm.handleLocalFilesChanged(
      notes.slice(0, 10).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePath).toHaveBeenCalledTimes(10);
    vi.useRealTimers();
  });

  it("does not consult the recovery-copy writer for intentional disk deletes", async () => {
    const sm = new SyncManager();
    const notes = mapMany(200);
    await live(sm);
    vi.mocked(ipc.writeTrashCopy).mockRejectedValue(new Error("must not be called"));

    sm.handleLocalFilesChanged(
      notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    const sent = fakeRegistry.deletePaths.mock.calls[0][0] as string[];
    expect(sent).toHaveLength(30);
    expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
    expect(fakeRegistry.recordFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "D7.md" }),
    );
    vi.useRealTimers();
  });

  it("reports a note the server refused, and leaves the rest deleted", async () => {
    // The batch answers per item. A `denied` note keeps its mapping inside the
    // registry (pinned by `registryDeleteBatch.test.ts`); here the session must
    // report it and NOT treat it as propagated.
    const sm = new SyncManager();
    const notes = mapMany(200);
    await live(sm);
    fakeRegistry.deletePaths.mockImplementation(async (paths: readonly string[]) =>
      paths.map((path) => ({
        path,
        status: path === "D3.md" ? ("denied" as const) : ("deleted" as const),
        reason: path === "D3.md" ? "no edit grant" : null,
        code: path === "D3.md" ? "no_edit_permission" : null,
      })),
    );

    sm.handleLocalFilesChanged(
      notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })),
    );
    await drain();

    const refusals = fakeRegistry.recordFailure.mock.calls.map((c) => c[0] as { path: string });
    expect(refusals).toHaveLength(1);
    expect(refusals[0].path).toBe("D3.md");
    vi.useRealTimers();
  });

  it("takes the OPEN note's provider down with the delete, not just its file", async () => {
    // The bridge deliberately survives — CodeMirror is still mounted and the
    // banner offers to close the note — but the network provider must not. The
    // server has just tombstoned this doc, so `POST /api/sync-token` answers 404
    // for it from here on (the route filters `deleted_at IS NULL`), the mint
    // fails, and the provider's token function falls back to `""`, which the
    // server rejects on every connect. Live in #93 that was dozens of
    // `[onAuthenticate] rejected … (token length 0)` a minute and a sync badge
    // strobing Synced/Syncing for as long as the note stayed open.
    const sm = new SyncManager();
    mapOne("Open.md", "d-open");
    await live(sm);

    const bridge = {
      docId: "d-open",
      doc: new Y.Doc(),
      serialize: () => "content",
      async seedFromFileIfEmpty() {},
      abandonPull() {},
      async reconcileAfterPull() {
        return false;
      },
    };
    await sm.openDoc(bridge as never, "Open.md");
    expect(connects.order).toContain("d-open");
    expect(connects.destroyed).toEqual([]);

    sm.handleLocalFilesChanged([{ path: "Open.md", kind: "removed" }]);
    await drain();

    expect(fakeRegistry.deletePath).toHaveBeenCalledWith("Open.md");
    // The provider is gone…
    expect(connects.destroyed).toEqual(["d-open"]);
    expect(sm.currentSync()).toBeNull();
    // …and nothing opened a replacement for a doc that no longer exists.
    expect(connects.order.filter((d) => d === "d-open")).toHaveLength(1);
    vi.useRealTimers();
  });
});

// ── #221: reorganising the vault folder with the app open ───────────────────

describe("SyncManager — structure changes made outside the app (#221)", () => {
  async function live(sm: SyncManager) {
    await enable(sm);
    engineHooks.opts!.onStatus?.("synced");
    await vi.advanceTimersByTimeAsync(300);
  }

  /** Out the grace window and the drain's async chain (real digests inside). */
  async function drain(turns = 16) {
    for (let i = 0; i < turns; i++) {
      await vi.advanceTimersByTimeAsync(300);
      await realTick();
    }
  }

    /** Map `notes` (all pushed) and register their folders. */
  function mapNotes(notes: Array<{ docId: string; relPath: string }>, folders: string[] = []) {
    const byPath = new Map(notes.map((n) => [n.relPath, n]));
    fakeRegistry.mappedNotes.mockReturnValue(notes);
    fakeRegistry.getMapping.mockImplementation((p: string) => {
      const hit = byPath.get(p);
      return hit ? { vaultId: "collection-1", docId: hit.docId } : null;
    });
    for (const n of notes) fakeRegistry.pushed.add(n.docId);
    for (const f of folders) fakeRegistry.folders.set(f, `folder-${f}`);
  }

  /** Five notes under `Old/`, one of them nested, each with its own text. */
  const oldNotes = [
    { docId: "fa", relPath: "Old/a.md" },
    { docId: "fb", relPath: "Old/sub/b.md" },
    { docId: "fc", relPath: "Old/c.md" },
    { docId: "fd", relPath: "Old/d.md" },
    { docId: "fe", relPath: "Old/e.md" },
  ];
  const others = Array.from({ length: 20 }, (_, i) => ({ docId: `o${i}`, relPath: `Keep/${i}.md` }));
  const textOf = (docId: string) => `# ${docId}\n\nbody of ${docId}`;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const n of oldNotes) storeHooks.texts.set(n.docId, textOf(n.docId));
  });

  it("recognises a folder moved outside the app as ONE folder move, keeping every id", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Old/sub", "Keep"]);
    await live(sm);
    fakeRegistry.pull.mockClear();
    // `mv Old Archive`: the files are under the new folder, one of them edited
    // in the same breath (4 of 5 byte-identical = the 80% rule).
    fakeDisk.dirs = new Set(["Archive", "Archive/sub", "Keep"]);
    for (const n of oldNotes) fakeDisk.files.set(n.relPath.replace(/^Old/, "Archive"), textOf(n.docId));
    fakeDisk.files.set("Archive/c.md", `${textOf("fc")}\nedited while moving`);
    const armed = vi.spyOn(sm as unknown as { armLocalChangeDrain: () => void }, "armLocalChangeDrain")
      .mockImplementation(() => {});

    // macOS reports the folder, never its children.
    sm.handleLocalFilesChanged([
      { path: "Archive", kind: "tree", gone: false },
      { path: "Old", kind: "tree", gone: true },
    ]);
    // The pull waits for the drain: pulling first registers Archive/* as new.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    await drain();

    // ONE server folder move, nothing per note, nothing deleted.
    expect(fakeRegistry.renamePath.mock.calls).toEqual([["Old", "Archive"]]);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
    // Every moved file is indexed under its KEPT doc id, the edited one included.
    expect(fakeDisk.materialized).toHaveLength(1);
    expect(fakeDisk.materialized[0]).toEqual(
      oldNotes.map((n) => ({ relPath: n.relPath.replace(/^Old/, "Archive"), docId: n.docId })),
    );
    // The edited-and-moved note still has its new bytes to send.
    const queued = (sm as unknown as { localChanges: Map<string, string> }).localChanges;
    expect([...queued]).toEqual([["fc", "Archive/c.md"]]);
    expect(armed).toHaveBeenCalled();
    // …and only then does the deferred pull run.
    expect(fakeRegistry.pull).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("holds a registry frame's pull while a moved folder is still being paired", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    fakeRegistry.pull.mockClear();
    fakeDisk.dirs = new Set(["Archive", "Archive/sub"]);
    for (const n of oldNotes) fakeDisk.files.set(n.relPath.replace(/^Old/, "Archive"), textOf(n.docId));

    sm.handleLocalFilesChanged([{ path: "Old", kind: "tree", gone: true }]);
    // A teammate's change arrives inside the window.
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    sm.handleLocalFilesChanged([{ path: "Archive", kind: "tree", gone: false }]);
    await drain();

    expect(fakeRegistry.renamePath.mock.calls).toEqual([["Old", "Archive"]]);
    expect(fakeRegistry.pull).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("holds a registry frame's pull while a renamed NOTE is still inside its grace window", async () => {
    // `mv Old/a.md Old/a2.md` plus an edit to another note in the same second:
    // the edit's push makes the server announce `registry-changed`, and that
    // frame used to run a pull inside the 2.5 s grace — registering a2.md as a
    // brand-new note and re-materializing a.md at the old path (0.1.69-staging).
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Old/sub", "Keep"]);
    await live(sm);
    fakeRegistry.pull.mockClear();
    fakeDisk.dirs = new Set(["Old", "Old/sub", "Keep"]);
    fakeDisk.files.set("Old/a2.md", textOf("fa"));
    // The new path's index row carries the file hash the per-note pairing reads.
    fakeDisk.shas.set("Old/a2.md", createHash("sha256").update(textOf("fa"), "utf8").digest("hex"));

    sm.handleLocalFilesChanged([
      { path: "Old/a.md", kind: "removed" },
      { path: "Old/a2.md", kind: "modified" },
    ]);
    // Our own content push echoes back as a server frame inside the window.
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    await drain();

    expect(fakeRegistry.renamePath.mock.calls).toEqual([["Old/a.md", "Old/a2.md"]]);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.pull).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("below 80% it is not a folder move: the notes fall to per-note pairing and the delete drain", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    fakeDisk.dirs = new Set(["Archive", "Archive/sub"]);
    // All five sub-paths exist, but only two still hold the doc's text.
    for (const n of oldNotes) fakeDisk.files.set(n.relPath.replace(/^Old/, "Archive"), `rewritten ${n.docId}`);
    fakeDisk.files.set("Archive/a.md", textOf("fa"));
    fakeDisk.files.set("Archive/d.md", textOf("fd"));

    sm.handleLocalFilesChanged([
      { path: "Archive", kind: "tree", gone: false },
      { path: "Old", kind: "tree", gone: true },
    ]);
    await drain(30);

    const moves = fakeRegistry.renamePath.mock.calls;
    expect(moves).not.toContainEqual(["Old", "Archive"]);
    // The two byte-identical notes pair one by one and keep their ids…
    expect(moves).toEqual(
      expect.arrayContaining([
        ["Old/a.md", "Archive/a.md"],
        ["Old/d.md", "Archive/d.md"],
      ]),
    );
    expect(moves).toHaveLength(2);
    // …and the three that did not pair go through the normal delete drain
    // (3 is under this vault's cap of 5).
    expect(fakeRegistry.deletePath.mock.calls.map((c) => c[0]).sort()).toEqual([
      "Old/c.md",
      "Old/e.md",
      "Old/sub/b.md",
    ]);
    vi.useRealTimers();
  });

  it("a gone folder with nothing new beside it is left to the pull, as before", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    fakeRegistry.pull.mockClear();

    sm.handleLocalFilesChanged([{ path: "Old", kind: "tree", gone: true }]);
    await drain();

    expect(fakeRegistry.renamePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.pull).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a vanished vault root stops everything and raises the reopen banner", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    const notices: Array<{ rootMissing: boolean }> = [];
    sm.setStructureNoticeListener((n) => notices.push(n));
    fakeRegistry.pull.mockClear();
    fakeDisk.root = "missing";

    // The watcher's root entry (Rust plans nothing else for that batch).
    sm.handleLocalFilesChanged([{ path: "", kind: "tree", gone: true }]);
    await drain(4);
    expect(sm.isVaultRootMissing()).toBe(true);
    expect(sm.structurePaused()).toBe(true);
    expect(notices[notices.length - 1]?.rootMissing).toBe(true);

    // Nothing that mutates runs from here: no deletes for the "vanished" notes,
    // no pull (which would re-create the old folder), no folder moves.
    sm.handleLocalFilesChanged(oldNotes.map((n) => ({ path: n.relPath, kind: "removed" as const })));
    engineHooks.opts!.onRegistryChanged?.();
    await drain();
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
    expect(fakeRegistry.renamePath).not.toHaveBeenCalled();
    expect(sm.pendingDeleteDecision()).toBeNull();
    // The registry's own gates read the same latch.
    expect(await sm.confirmVaultRoot()).toBe(false);
    vi.useRealTimers();
  });

  it("a root that vanishes between the event and the drain is refused silently, never asked", async () => {
    // The unmounted-volume shape: the children arrive as removals first.
    const sm = new SyncManager();
    const notes = Array.from({ length: 50 }, (_, i) => ({ docId: `u${i}`, relPath: `U${i}.md` }));
    mapNotes(notes);
    await live(sm);

    sm.handleLocalFilesChanged(notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })));
    fakeDisk.root = "missing";
    await drain();

    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
    expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
    expect(sm.pendingDeleteDecision()).toBeNull();
    expect(sm.isVaultRootMissing()).toBe(true);
    vi.useRealTimers();
  });

  it("#228: a deliberate reset never latches the root as missing", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    const notices: Array<{ rootMissing: boolean }> = [];
    sm.setStructureNoticeListener((n) => notices.push(n));
    await sm.withDeliberateRootChange(async () => {
      fakeDisk.root = "missing";
      sm.handleLocalFilesChanged([{ path: "", kind: "tree", gone: true }]);
      await drain(4);
      expect(await sm.checkVaultRoot()).toBe(true);
    });
    expect(sm.isVaultRootMissing()).toBe(false);
    expect(notices.some((n) => n.rootMissing)).toBe(false);
    // Outside the window the same disk answer latches as before.
    expect(await sm.checkVaultRoot()).toBe(false);
    expect(sm.isVaultRootMissing()).toBe(true);
    vi.useRealTimers();
  });

  it("#228: a local-only vault's vanished root is detected too", async () => {
    const sm = new SyncManager();
    // No `enable`: only the vault-wide scope every open claims.
    vaultScopes.ensure({ orgId: null, vaultPath: "/v", vaultEpoch: 1 });
    const notices: Array<{ rootMissing: boolean }> = [];
    sm.setStructureNoticeListener((n) => notices.push(n));
    fakeDisk.root = "missing";
    sm.handleLocalFilesChanged([{ path: "", kind: "tree", gone: true }]);
    await drain(4);
    expect(sm.isVaultRootMissing()).toBe(true);
    expect(notices[notices.length - 1]?.rootMissing).toBe(true);
    vi.useRealTimers();
  });

  it("#228: unsyncedNotePaths names every note the server has not confirmed", async () => {
    const sm = new SyncManager();
    mapNotes([...oldNotes, ...others], ["Old", "Keep"]);
    await live(sm);
    const all = [...oldNotes, ...others];
    for (const n of all) fakeRegistry.pushed.add(n.docId);
    expect(sm.unsyncedNotePaths()).toEqual([]);
    fakeRegistry.pushed.delete(all[0].docId);
    (sm as unknown as { localChanges: Map<string, string> }).localChanges.set(
      all[1].docId,
      all[1].relPath,
    );
    expect(sm.unsyncedNotePaths()).toEqual([all[0].relPath, all[1].relPath].sort());
    vi.useRealTimers();
  });

  describe("a live delete above the cap asks instead of undoing", () => {
    const notes = Array.from({ length: 50 }, (_, i) => ({ docId: `x${i}`, relPath: `X${i}.md` }));

    async function heldThirty(sm: SyncManager) {
      mapNotes(notes);
      await live(sm);
      // Cap is 10 (50 × 0.2); 30 vanish at once with the root present.
      sm.handleLocalFilesChanged(notes.slice(0, 30).map((n) => ({ path: n.relPath, kind: "removed" as const })));
      await drain();
    }

    it("holds the batch: nothing deleted, nothing restored, and Health lists it", async () => {
      const sm = new SyncManager();
      await heldThirty(sm);
      fakeRegistry.pull.mockClear();

      expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
      expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
      expect(sm.structureNotice().pendingDelete).toEqual({ count: 30 });
      // The registry pull skips exactly these docs until the user answers.
      expect([...sm.heldDocIds()].sort()).toEqual(notes.slice(0, 30).map((n) => n.docId).sort());
      // Health: one inbound-blocked row per held note.
      const rows = sm.syncFailures().registry.filter((f) => f.code === "delete_decision");
      expect(rows).toHaveLength(30);
      expect(rows[0]).toMatchObject({ kind: "inbound-blocked", path: "X0.md", docId: "x0" });
      // Other work carries on: an ordinary pull still runs.
      engineHooks.opts!.onRegistryChanged?.();
      await vi.advanceTimersByTimeAsync(600);
      expect(fakeRegistry.pull).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('"Delete for everyone" runs the soft delete uncapped, batched', async () => {
      const sm = new SyncManager();
      await heldThirty(sm);

      await sm.resolveDeleteDecision("delete");
      await drain(2);

      expect(fakeRegistry.deletePaths).toHaveBeenCalledTimes(1);
      expect(fakeRegistry.deletePaths.mock.calls[0][0]).toHaveLength(30);
      expect(sm.pendingDeleteDecision()).toBeNull();
      expect(sm.heldDocIds().size).toBe(0);
      vi.useRealTimers();
    });

    it('"Restore" deletes nothing and lets the pull materialize them again', async () => {
      const sm = new SyncManager();
      await heldThirty(sm);
      fakeRegistry.pull.mockClear();

      await sm.resolveDeleteDecision("restore");
      await drain(2);

      expect(fakeRegistry.deletePath).not.toHaveBeenCalled();
      expect(fakeRegistry.deletePaths).not.toHaveBeenCalled();
      expect(sm.heldDocIds().size).toBe(0);
      expect(fakeRegistry.pull).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("a held note whose file comes back leaves the question", async () => {
      const sm = new SyncManager();
      await heldThirty(sm);
      fakeDisk.files.set("X3.md", "content");
      sm.handleLocalFilesChanged([{ path: "X3.md", kind: "modified" }]);
      expect(sm.structureNotice().pendingDelete).toEqual({ count: 29 });
      expect(sm.heldDocIds().has("x3")).toBe(false);
      vi.useRealTimers();
    });

    it("a vault switch forgets the question (a restart restores, the safe direction)", async () => {
      const sm = new SyncManager();
      await heldThirty(sm);
      sm.disable();
      expect(sm.pendingDeleteDecision()).toBeNull();
      expect(sm.structureNotice()).toEqual({ rootMissing: false, pendingDelete: null, closedAppChanges: false });
      vi.useRealTimers();
    });
  });

  it("below the cap a live delete is unchanged: propagated, never asked", async () => {
    const sm = new SyncManager();
    const notes = Array.from({ length: 50 }, (_, i) => ({ docId: `y${i}`, relPath: `Y${i}.md` }));
    mapNotes(notes);
    await live(sm);

    sm.handleLocalFilesChanged(notes.slice(0, 4).map((n) => ({ path: n.relPath, kind: "removed" as const })));
    await drain();

    expect(fakeRegistry.deletePath).toHaveBeenCalledTimes(4);
    expect(sm.pendingDeleteDecision()).toBeNull();
    vi.useRealTimers();
  });

  it("shows the closed-app change notice once per open, and only for moved/deleted + new files", async () => {
    const sm = new SyncManager();
    fakeRegistry.lastPassDrift.mockReturnValue({ missingMapped: 3, unmappedLocal: 2 });
    await live(sm);
    expect(sm.structureNotice().closedAppChanges).toBe(true);

    sm.dismissClosedChangesNotice();
    expect(sm.structureNotice().closedAppChanges).toBe(false);
    // Later pulls in the same open never raise it again.
    engineHooks.opts!.onRegistryChanged?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(sm.structureNotice().closedAppChanges).toBe(false);

    // A fresh open re-evaluates; new files alone are not a structure change.
    sm.disable();
    fakeRegistry.lastPassDrift.mockReturnValue({ missingMapped: 0, unmappedLocal: 7 });
    await live(sm);
    expect(sm.structureNotice().closedAppChanges).toBe(false);
    vi.useRealTimers();
  });
});
