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

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";
import type { VaultDocStoreOptions } from "../vaultDocStore";

const OPEN_DOC = "doc-open";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: "collection-1" as string | null,
    pushed: new Set<string>(),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn((_relPath: string): { vaultId: string; docId: string } | null => null),
    pathForDocId: vi.fn((_docId: string): string | null => null),
    allDocIds: vi.fn((): string[] => []),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
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
        serialize: () => "content",
        ingestNow: async () => false,
        seedFromFileIfEmpty: async () => {},
        flushEgest: async () => {},
      };
    }
    async demote() {}
    async release() {}
    peekResident() {
      return null;
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
 *  is the queue the uploader actually built. */
const connects = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = false;
    isSynced = false;
    constructor(input: { docId: string }) {
      connects.order.push(input.docId);
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
  engineHooks.opts = null;
  engineHooks.started = 0;
  engineHooks.refreshes = 0;
  engineHooks.settled = false;
  storeHooks.opts = null;
  storeHooks.open = null;
  storeHooks.promoted = [];
  connects.order = [];
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

    // A removal is deliberately inert: propagating disk deletions would let
    // `git checkout`-style churn delete a team's notes.
    sm.handleLocalFilesChanged([{ path: "Gone.md", kind: "removed" }]);
    expect(sm.hasPendingRegistryPull()).toBe(false);
    fakeRegistry.getMapping.mockReturnValue(null);
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
});
