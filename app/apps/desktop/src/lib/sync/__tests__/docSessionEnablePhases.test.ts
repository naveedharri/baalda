// `enable()` in two phases: a LOCAL prime, then the networked reconcile.
//
// The boot no longer waits for the reconcile, so a note can be clicked while it
// is still running. Without the prime that click takes the local-only branch —
// no provider, `seedFromFile: true` — which seeds a mapped doc from disk before
// pulling the server's state: the split-brain reversal `decideSeed` forbids, and
// the shape of the note-doubling incident. The prime is what makes the click
// safe, and these tests pin its boundaries:
//
//   - `syncable()` (not `enabled`) is what the open path consults, so the
//     watcher pipeline / debounced pull / attachments stay OFF until the
//     reconcile is done — a pull racing a reconcile is its own class of bug;
//   - a note opened in the window is suppressed on the doc store the engine
//     creates AFTERWARDS, or the background feed becomes a second writer on
//     that same Y.Doc;
//   - a prime that refuses (legacy/foreign config) leaves today's behaviour.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultDocStoreOptions } from "../vaultDocStore";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";

const MAPPED = "Notes/mapped.md";
const MAPPED_DOC = "doc-mapped";
const COLLECTION = "collection-1";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    primed: false,
    primeLocal: vi.fn(async (_orgId: string) => reg.primed),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn((_relPath: string): { vaultId: string; docId: string } | null => null),
    pathForDocId: vi.fn((_docId: string): string | null => null),
    allDocIds: vi.fn((): string[] => []),
    isNoteEmptyOnDisk: vi.fn(async () => false),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setInboundHost: vi.fn(),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn(() => false),
    markPushed: vi.fn(),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
    consumeMaterialized: vi.fn(() => false),
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
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  writeTrashCopy: vi.fn(async () => "trash"),
  rebindNoteId: vi.fn(async () => true),
}));

/**
 * The server. Only `enable`'s fire-and-forget attachment reconcile reaches it —
 * but a real `fetch` from Node rejects and logs, and this file's tests finish
 * first, so that log landed in an already-closed worker ("Closing rpc while
 * onUserConsoleLog was pending") on roughly one run in three.
 */
vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    resetNoteHistory: vi.fn(async () => {}),
  },
}));

const engineHooks = vi.hoisted(() => ({ started: 0, opts: null as VaultSyncEngineOptions | null }));

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
    refresh() {}
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return false;
    }
  },
}));

const storeHooks = vi.hoisted(() => ({
  created: 0,
  suppressed: null as string | null,
  opts: null as VaultDocStoreOptions | null,
}));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    constructor(opts: VaultDocStoreOptions) {
      storeHooks.created++;
      storeHooks.opts = opts;
      // A FRESH store suppresses nothing — which is exactly why the handover
      // has to re-apply the open note's doc id.
      storeHooks.suppressed = null;
    }
    async promote() {
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
      return storeHooks.suppressed;
    }
    setSuppressedDoc(docId: string | null) {
      storeHooks.suppressed = docId;
    }
    async flushStateVectors() {}
    async destroyAll() {}
  },
}));

vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = false;
    isSynced = false;
    readonly status = "connecting";
    readonly docId: string;
    readonly awareness = { setLocalStateField() {}, destroy() {} };
    constructor(input: { docId: string }) {
      this.docId = input.docId;
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
import type { NoteBridge } from "../../bridge/noteBridge";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

/** Just enough bridge for `openDoc`: a real Y.Doc and a serialization. */
function bridge(): NoteBridge {
  const doc = new Y.Doc();
  return {
    doc,
    serialize: () => "hello",
    seedFromFileIfEmpty: async () => {},
  } as unknown as NoteBridge;
}

/** A deferred promise, to park the reconcile mid-flight. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.vaultId = COLLECTION;
  fakeRegistry.primed = true;
  fakeRegistry.primeLocal.mockClear();
  fakeRegistry.reconcile.mockClear().mockImplementation(async () => ({ seeded: false }));
  fakeRegistry.getMapping
    .mockReset()
    .mockImplementation((relPath: string) =>
      relPath === MAPPED ? { vaultId: COLLECTION, docId: MAPPED_DOC } : null,
    );
  fakeRegistry.pathForDocId.mockReset().mockReturnValue(null);
  fakeRegistry.mappedNotes.mockReturnValue([]);
  fakeRegistry.markPushed.mockClear();
  engineHooks.started = 0;
  engineHooks.opts = null;
  storeHooks.created = 0;
  storeHooks.suppressed = null;
});

describe("SyncManager.enable — the prime window", () => {
  it("makes a mapped note openable WITH a provider before the reconcile returns", async () => {
    const held = gate();
    fakeRegistry.reconcile.mockImplementation(async () => {
      await held.waited;
      return { seeded: false };
    });
    const sm = new SyncManager();
    const enabling = sm.enable(session(), {
      orgId: "org-a",
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await flush();

    // Not "enabled" — that flag still gates the watcher pipeline and the
    // debounced pull, neither of which may run beside a reconcile.
    expect(sm.isEnabled()).toBe(false);
    expect(sm.isSyncable()).toBe(true);
    // What the editor asks before choosing `seedFromFile`.
    expect(sm.willSync(MAPPED)).toBe(true);

    const opened = await sm.openDoc(bridge(), MAPPED);
    // The mapped branch: a provider owns this doc, so the caller passed
    // `seedFromFile: false` and pull-before-seed holds.
    expect(opened.sync).not.toBeNull();

    held.open();
    await enabling;
    expect(sm.isEnabled()).toBe(true);
    // One flag owns the state after the handover; `syncable()` never dipped.
    expect(sm.isSyncable()).toBe(true);
  });

  it("re-suppresses the note opened in the window on the store the engine creates", async () => {
    // `openDoc` sets the suppressed doc on the store that exists at open time —
    // which during the window is null. A fresh store that doesn't know about the
    // open note makes the background feed a SECOND writer on its Y.Doc.
    const held = gate();
    fakeRegistry.reconcile.mockImplementation(async () => {
      await held.waited;
      return { seeded: false };
    });
    const sm = new SyncManager();
    const enabling = sm.enable(session(), {
      orgId: "org-a",
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await flush();
    await sm.openDoc(bridge(), MAPPED);
    expect(storeHooks.created).toBe(0); // no engine yet

    held.open();
    await enabling;
    await flush();

    expect(storeHooks.created).toBe(1);
    expect(storeHooks.suppressed).toBe(MAPPED_DOC);
  });

  it("fires onPrimed exactly once, before the reconcile resolves", async () => {
    const held = gate();
    fakeRegistry.reconcile.mockImplementation(async () => {
      await held.waited;
      return { seeded: false };
    });
    const seen: string[] = [];
    const sm = new SyncManager();
    const enabling = sm.enable(
      session(),
      { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 },
      { onPrimed: () => seen.push("primed") },
    );
    await flush();

    expect(seen).toEqual(["primed"]);
    held.open();
    await enabling;
    expect(seen).toEqual(["primed"]);
  });

  it("teardown in the window revokes syncable", async () => {
    const held = gate();
    fakeRegistry.reconcile.mockImplementation(async () => {
      await held.waited;
      return { seeded: false };
    });
    const sm = new SyncManager();
    const enabling = sm.enable(session(), {
      orgId: "org-a",
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await flush();
    expect(sm.isSyncable()).toBe(true);

    sm.disable();

    expect(sm.isSyncable()).toBe(false);
    expect(sm.willSync(MAPPED)).toBe(false);
    // The parked reconcile belongs to a retired scope; it must not bring sync up.
    held.open();
    await enabling;
    expect(sm.isEnabled()).toBe(false);
  });

  it("a refused prime keeps the pre-prime behaviour", async () => {
    // A legacy (pre-stamp) or foreign config: nothing is adopted, so a note
    // opened in the window takes the local-only branch exactly as it did before
    // this split existed — and only the reconcile turns sync on.
    fakeRegistry.primed = false;
    const held = gate();
    fakeRegistry.reconcile.mockImplementation(async () => {
      await held.waited;
      return { seeded: false };
    });
    const sm = new SyncManager();
    const enabling = sm.enable(session(), {
      orgId: "org-a",
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await flush();

    expect(sm.isSyncable()).toBe(false);
    expect(sm.willSync(MAPPED)).toBe(false);

    held.open();
    await enabling;
    expect(sm.willSync(MAPPED)).toBe(true);
  });

  it("survives a prime that throws", async () => {
    // Best-effort by contract: a broken `.context/config.json` must fall back to
    // reconcile-first, never fail the enable.
    fakeRegistry.primeLocal.mockRejectedValueOnce(new Error("unreadable config"));
    const sm = new SyncManager();
    const result = await sm.enable(session(), {
      orgId: "org-a",
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });

    expect(result.ok).toBe(true);
    expect(sm.isEnabled()).toBe(true);
  });
});
