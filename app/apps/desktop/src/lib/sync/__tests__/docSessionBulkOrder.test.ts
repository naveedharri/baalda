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
    renamePath: vi.fn(async (_from: string, _to: string) => {}),
    recordFailure: vi.fn((_f: unknown) => {}),
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
  };
  return state;
});

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async (path: string) => fakeDisk.files.has(path)),
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
      ? { snapshot: [1], updates: [], updateCount: 0 }
      : { snapshot: null, updates: [], updateCount: 0 },
  ),
  clearYjsDoc: vi.fn(async () => {}),
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
  fakeRegistry.renamePath.mockClear();
  fakeRegistry.recordFailure.mockClear();
  fakeDisk.files.clear();
  fakeDisk.shas.clear();
  fakeDisk.crdt.clear();
  fakeDisk.trashed = [];
  fakeDisk.rebinds = [];
  engineHooks.opts = null;
  engineHooks.started = 0;
  engineHooks.refreshes = 0;
  engineHooks.settled = false;
  storeHooks.opts = null;
  storeHooks.open = null;
  storeHooks.promoted = [];
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

    sm.handleLocalFilesChanged([{ path: "Fresh.md", kind: "modified" }]);
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

  it("propagates a delete after the grace window, keeping a local copy first", async () => {
    const sm = new SyncManager();
    mapOne("Notes/Gone.md");
    await live(sm);

    sm.handleLocalFilesChanged([{ path: "Notes/Gone.md", kind: "removed" }]);
    // Nothing yet — the window is what makes an atomic save safe.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeRegistry.deletePath).not.toHaveBeenCalled();

    await drain();
    // The bytes are kept BEFORE the server is told, so a mistake is recoverable.
    expect(fakeDisk.trashed).toEqual([{ path: "Notes/Gone.md", content: "content" }]);
    expect(fakeRegistry.deletePath).toHaveBeenCalledWith("Notes/Gone.md");
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

  it("abandons the WHOLE batch when too many notes vanish at once", async () => {
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
    // …and the refusal is reported, not silent.
    expect(fakeRegistry.recordFailure).toHaveBeenCalledTimes(6);
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
