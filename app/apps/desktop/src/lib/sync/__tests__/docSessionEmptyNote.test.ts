// Intentionally-empty notes and the `ready.empty` verdict.
//
// Every new note is now created EMPTY (Rust `notefile.rs create_note` used to
// seed `# {stem}`), which routes EVERY new note through `settleServerEmpty`: the
// server names it on `ready.empty`, the probe reads a zero-byte file, and the
// doc is marked pushed + badged synced and never queued. That is the same
// mechanism that stopped a vault of 307 zero-byte `_Index.md` stubs from
// "re-syncing 307 notes" on every reload, so half of this suite guards that it
// does not regress.
//
// The other half is the hole that empty-by-default opened. `contentWorkList`
// filters `emptyEverywhere` BEFORE it consults `serverEmpty`, and the only things
// that clear a verdict are a watcher event for a NON-suppressed doc, an inbound
// delete, and a restart. So: create a note → the connect settles it → the network
// drops → open it and type → close it → reconnect. The typing's egest fires a
// watcher event, but while the note is open `suppressedDoc() === docId`
// short-circuits `handleLocalFileChanged` BEFORE the `emptyEverywhere.delete`, so
// the verdict survived, the next `ready.empty` skipped the probe, and the text
// never uploaded until an app restart. `openDoc` clears the verdict for exactly
// that reason.
//
// Same fakes as `docSessionBulkOrder.test.ts` (registry, Rust IPC, vault channel,
// doc store, per-note provider); the ContentUploader is REAL, so the queue is the
// one production computes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";
import type { VaultDocStoreOptions } from "../vaultDocStore";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: "collection-1" as string | null,
    pushed: new Set<string>(),
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
    materializePendingFromBootstrap: vi.fn(async () => false),
    pendingFromBootstrapCount: vi.fn(() => 0),
    deferredPathFor: vi.fn((_docId: string): string | null => null),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    heldRefusals: vi.fn((): unknown[] => []),
    retryHeldRefusals: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
    materialized: new Set<string>(),
    consumeMaterialized: vi.fn((relPath: string) => reg.materialized.delete(relPath)),
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

/** Rust: the disk the probe and the uploader read. */
const fakeDisk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  shas: new Map<string, string>(),
}));

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async (path: string) => fakeDisk.files.has(path)),
  readNote: vi.fn(async (path: string) => fakeDisk.files.get(path) ?? ""),
  getNoteMeta: vi.fn(async (path: string) =>
    fakeDisk.shas.has(path) ? { path, sha256: fakeDisk.shas.get(path) } : null,
  ),
  writeTrashCopy: vi.fn(async () => ".context/trash/x"),
  rebindNoteId: vi.fn(async () => true),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  pruneYjsDocs: vi.fn(async () => ({ docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 })),
  listAttachments: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
}));

/**
 * The server. Only `enable`'s fire-and-forget attachment reconcile reaches it,
 * and a real `fetch` from Node rejects — late enough to log into a worker this
 * file has already closed.
 */
vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    resetNoteHistory: vi.fn(async () => {}),
  },
}));

const engineHooks = vi.hoisted(() => ({
  opts: null as VaultSyncEngineOptions | null,
  started: 0,
  refreshes: 0,
  settled: false,
}));

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

const storeHooks = vi.hoisted(() => ({
  opts: null as VaultDocStoreOptions | null,
  open: null as string | null,
}));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    parkMark() {
      return 0;
    }
    async settleParked() {}
    takeOverflowed() {
      return [];
    }
    constructor(opts: VaultDocStoreOptions) {
      storeHooks.opts = opts;
    }
    async promote() {
      return {
        doc: new Y.Doc(),
        serialize: () => "content",
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

const connects = vi.hoisted(() => ({ order: [] as string[], readOnly: false,
  onSynced: (() => {}) as () => void }));

vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = connects.readOnly;
    isSynced = false;
    readonly status = "connecting";
    readonly docId: string;
    readonly awareness = { setLocalStateField() {}, destroy() {} };
    constructor(input: { docId: string }) {
      this.docId = input.docId;
      connects.order.push(input.docId);
    }
    async whenSynced() {
      connects.onSynced();
      this.isSynced = true;
    }
    async whenFlushed() {
      return true;
    }
    destroy() {}
    refreshAccess() {}
  },
}));

import type { NoteBridge } from "../../bridge/noteBridge";
import * as ipc from "../../ipc";
import type { SessionInfo } from "../../api";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

const DOC = "doc-new";
const REL = "Untitled.md";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

/** Every manager a test spins up, torn down after it — a run still in flight
 *  when the file ends logs into a closed worker. */
const managers: SyncManager[] = [];

function manager(): SyncManager {
  const sm = new SyncManager();
  managers.push(sm);
  return sm;
}

async function enable(sm: SyncManager) {
  return sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
}

/** Enough NoteBridge for `openDoc` + its background `confirmOpenDoc`. */
function bridge(): NoteBridge {
  return {
    doc: new Y.Doc(),
    serialize: () => "typed while offline",
    seedFromFileIfEmpty: async () => {},
    abandonPull: () => {},
    reconcileAfterPull: async () => false,
  } as unknown as NoteBridge;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** One connect cycle's `ready` frames, then the queue drained. */
async function ready(sm: SyncManager, empty: string[]) {
  engineHooks.settled = true;
  engineHooks.opts!.onServerEmpty?.(empty, false);
  await sm.whenBulkSyncSettled();
  await flush();
}

beforeEach(() => {
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.pushed = new Set();
  fakeRegistry.mappedNotes.mockReturnValue([{ docId: DOC, relPath: REL }]);
  fakeRegistry.getMapping.mockImplementation((relPath: string) =>
    relPath === REL ? { vaultId: "collection-1", docId: DOC } : null,
  );
  fakeRegistry.pathForDocId.mockImplementation((docId: string) => (docId === DOC ? REL : null));
  fakeRegistry.emptyOnDisk = new Set([REL]);
  fakeRegistry.isNoteEmptyOnDisk.mockClear();
  fakeRegistry.markPushed.mockClear();
  fakeDisk.files.clear();
  fakeDisk.files.set(REL, "");
  fakeDisk.shas.clear();
  engineHooks.opts = null;
  engineHooks.started = 0;
  engineHooks.refreshes = 0;
  engineHooks.settled = false;
  storeHooks.opts = null;
  storeHooks.open = null;
  connects.order = [];
  connects.readOnly = false;
  connects.onSynced = () => {};
  fakeRegistry.recordFailure.mockClear();
  vi.mocked(ipc.writeTrashCopy).mockClear();
  vi.mocked(ipc.loadYjsState).mockResolvedValue({
    snapshot: null,
    updates: [],
    updateCount: 0,
  });
});

afterEach(async () => {
  for (const sm of managers.splice(0)) {
    sm.disable();
    await sm.whenBulkSyncSettled();
  }
  await flush();
});

describe("a note created empty", () => {
  it.each(["placeholder", "matching", "local-edit"])("checks a read-only %s only after its server content lands", async (kind) => {
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);
    connects.readOnly = true;
    const local = kind === "placeholder" ? "" : kind === "matching" ? "server content" : "my local edit";
    fakeDisk.files.set(REL, local);
    let remote = "";
    connects.onSynced = () => {
      remote = "server content";
      // The pull may egest before the confirmation callback resumes.
      fakeDisk.files.set(REL, remote);
    };
    const b = bridge();
    Object.assign(b, { path: REL, serialize: () => remote });
    await sm.openDoc(b, REL);
    await flush();
    // No copy either way (decided 2026-11-19); a real edit is still reported.
    expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
    if (kind === "local-edit") {
      expect(fakeRegistry.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ docId: DOC }));
    } else {
      expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
      expect(fakeRegistry.recordFailure).not.toHaveBeenCalled();
    }
  });

  it("is settled from disk and never queued again (the 307-stub guarantee)", async () => {
    const sm = manager();
    const badges: Record<string, string> = {};
    sm.setDocStateListener((patch) => {
      for (const [id, state] of Object.entries(patch)) if (state) badges[id] = state;
    });
    await enable(sm);

    await ready(sm, [DOC]);
    // Nothing to push: no socket, badged synced, recorded as confirmed.
    expect(connects.order).toEqual([]);
    expect(badges[DOC]).toBe("synced");
    expect(fakeRegistry.markPushed).toHaveBeenCalledWith(DOC);

    // A second connect names it again (the server still holds nothing, which is
    // correct). This time not even the disk is consulted.
    fakeRegistry.isNoteEmptyOnDisk.mockClear();
    await ready(sm, [DOC]);
    expect(connects.order).toEqual([]);
    expect(fakeRegistry.isNoteEmptyOnDisk).not.toHaveBeenCalled();
  });

  it("is probed and queued again once it has been OPENED and filled", async () => {
    // The hole `openDoc`'s `emptyEverywhere.delete` closes: an egest from the
    // OPEN note is suppressed before the watcher clear, so without that line the
    // verdict outlives the content and the text never uploads.
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);
    expect(connects.order).toEqual([]);

    // Open it (this is what clears the verdict) and type: the file now has bytes.
    await sm.openDoc(bridge(), REL);
    await flush();
    expect(connects.order).toEqual([DOC]); // the open note's own provider
    fakeDisk.files.set(REL, "typed while offline");
    fakeRegistry.emptyOnDisk = new Set();

    // Close the note, reconnect: the server still has nothing for it, and this
    // time the probe runs and the doc is queued.
    sm.closeCurrent();
    storeHooks.open = null;
    connects.order = [];
    fakeRegistry.isNoteEmptyOnDisk.mockClear();
    await ready(sm, [DOC]);

    expect(fakeRegistry.isNoteEmptyOnDisk).toHaveBeenCalledWith(REL);
    expect(connects.order).toEqual([DOC]);
  });

  it("still settles from disk when the opened note was never filled", async () => {
    // Opening alone must not manufacture an upload — it only re-arms the probe.
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);

    await sm.openDoc(bridge(), REL);
    await flush();
    sm.closeCurrent();
    storeHooks.open = null;
    connects.order = [];
    fakeRegistry.isNoteEmptyOnDisk.mockClear();
    await ready(sm, [DOC]);

    expect(fakeRegistry.isNoteEmptyOnDisk).toHaveBeenCalledWith(REL);
    expect(connects.order).toEqual([]);
  });

  it("refuses to settle a 0-byte file whose local CRDT still holds the note", async () => {
    // `materializeContent` created the placeholder and then FAILED to write the
    // local CRDT's text into it (disk full, permission, an epoch switch). The
    // server holds nothing, the file is 0 bytes — and the note is alive in
    // `index.sqlite`. Settling here marked it pushed and badged it synced, so it
    // was never queued again and the text was stranded forever.
    const held = new Y.Doc();
    held.getText("content").insert(0, "the text only index.sqlite has");
    vi.mocked(ipc.loadYjsState).mockResolvedValue({
      snapshot: null,
      updates: [Y.encodeStateAsUpdate(held)],
      updateCount: 1,
    });

    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);

    // Queued for the push path instead: a socket carried the text up, and the
    // doc got no "empty everywhere" verdict — the next connect probes it again
    // rather than skipping it forever.
    expect(connects.order).toEqual([DOC]);
    connects.order = [];
    fakeRegistry.isNoteEmptyOnDisk.mockClear();
    await ready(sm, [DOC]);
    expect(fakeRegistry.isNoteEmptyOnDisk).toHaveBeenCalledWith(REL);
  });
});

// `ready.empty` on a shared-vault join names server-only notes whose placeholder
// is deferred until the bootstrap delivers them, so nothing is on disk yet.
// Probing them read a missing file per doc, and Rust logs every failed read as
// an ERROR: thousands of "Couldn't read the note" lines per join.
describe("ready.empty for a note that is not on disk yet", () => {
  it("does not probe a doc whose placeholder is still deferred, and does not queue it", async () => {
    fakeRegistry.deferredPathFor.mockImplementation((docId: string) => (docId === DOC ? REL : null));
    fakeDisk.files.delete(REL);
    // A server-listed note: only `ready.empty` could queue it, not "never pushed".
    fakeRegistry.pushed.add(DOC);
    try {
      const sm = manager();
      await enable(sm);
      vi.mocked(ipc.noteExists).mockClear();
      await ready(sm, [DOC]);
      expect(fakeRegistry.isNoteEmptyOnDisk).not.toHaveBeenCalled();
      expect(ipc.noteExists).not.toHaveBeenCalled();
      expect(connects.order).toEqual([]);
      expect(fakeRegistry.markPushed).not.toHaveBeenCalledWith(DOC);
    } finally {
      fakeRegistry.deferredPathFor.mockImplementation(() => null);
    }
  });

  it("never reads a mapped file that is missing from disk", async () => {
    fakeDisk.files.delete(REL);
    fakeRegistry.emptyOnDisk = new Set();
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);
    expect(ipc.noteExists).toHaveBeenCalledWith(REL, 1);
    expect(fakeRegistry.isNoteEmptyOnDisk).not.toHaveBeenCalled();
    // Same verdict a failed read gave: not settled as empty, kept in the push queue.
    expect(connects.order).toEqual([DOC]);
  });
});

// The remaining hole after the `ready.empty` probe fix: a server-only note this
// device has never pushed is NOT on `ready.empty` once the probe skips it, but
// `!isPushed` still put it on every content work list (`contentWorkList`, the
// bulk engine's batch push, the per-doc uploader) — and the run read its file,
// which the bootstrap / backfill had not created yet. One Rust ERROR per doc.
describe("a never-pushed note whose file is still pending creation", () => {
  it("is neither read nor queued while its placeholder is deferred", async () => {
    fakeRegistry.deferredPathFor.mockImplementation((docId: string) => (docId === DOC ? REL : null));
    fakeDisk.files.delete(REL);
    try {
      const sm = manager();
      await enable(sm);
      vi.mocked(ipc.readNote).mockClear();
      vi.mocked(ipc.noteExists).mockClear();
      await ready(sm, []);
      expect(ipc.readNote).not.toHaveBeenCalledWith(REL, expect.anything());
      expect(ipc.noteExists).not.toHaveBeenCalled();
      expect(connects.order).toEqual([]);
      expect(fakeRegistry.markPushed).not.toHaveBeenCalledWith(DOC);
    } finally {
      fakeRegistry.deferredPathFor.mockImplementation(() => null);
    }
  });

  it("becomes ordinary work once the delivery has created the file", async () => {
    fakeRegistry.deferredPathFor.mockImplementation((docId: string) => (docId === DOC ? REL : null));
    fakeDisk.files.delete(REL);
    try {
      const sm = manager();
      await enable(sm);
      await ready(sm, []);
      expect(connects.order).toEqual([]);
      // The bootstrap / backfill wrote the file and cleared the pending entry.
      fakeRegistry.deferredPathFor.mockImplementation(() => null);
      fakeDisk.files.set(REL, "delivered text");
      await ready(sm, []);
      expect(connects.order).toEqual([DOC]);
    } finally {
      fakeRegistry.deferredPathFor.mockImplementation(() => null);
    }
  });

  it("keeps today's behavior for a never-pushed note whose file the user deleted", async () => {
    // Not pending: missing for another reason. It stays on the work list (its
    // only copy may be the local CRDT) and the disk-delete drain still owns the
    // delete; this change must not quietly drop it.
    fakeDisk.files.delete(REL);
    const sm = manager();
    await enable(sm);
    await ready(sm, []);
    expect(fakeRegistry.deferredPathFor).toHaveBeenCalledWith(DOC);
    expect(connects.order).toEqual([DOC]);
  });
});
