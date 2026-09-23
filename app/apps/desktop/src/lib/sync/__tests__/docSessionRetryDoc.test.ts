// `SyncManager.retryDoc` — the Health page's per-row Retry.
//
// The thing under test is not "does it call the uploader" but "does it undo the
// three pieces of state that would each, on their own, make the retry a silent
// no-op":
//
//   1. `permanentFailures` — a doc in there is skipped by every later `ready`.
//   2. `registry.isPushed` — a believed-pushed doc is in no work list at all.
//   3. `divergedDocs` — without it the push takes the echo-guarded fast path and
//      may never open a socket, which is exactly wrong for a doc we cannot prove
//      the server ever received.
//
// Same fakes as `docSessionEmptyNote.test.ts` (registry, Rust IPC, vault channel,
// doc store, per-note provider); the ContentUploader is REAL, so the queue and
// the size ceiling are the ones production computes.

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
    unmarkPushed: vi.fn((docId: string) => {
      reg.pushed.delete(docId);
    }),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
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

vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    resetNoteHistory: vi.fn(async () => ({ bytesBefore: 0, bytesAfter: 0 })),
  },
}));

const engineHooks = vi.hoisted(() => ({
  opts: null as VaultSyncEngineOptions | null,
  settled: false,
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
    refresh() {}
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return engineHooks.settled;
    }
  },
}));

const storeHooks = vi.hoisted(() => ({ open: null as string | null }));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {
    constructor(_opts: VaultDocStoreOptions) {}
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

const connects = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("../syncManager", () => ({
  DocSync: class {
    readonly readOnly = false;
    isSynced = false;
    readonly status = "connecting";
    readonly docId: string;
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
    destroy() {}
    refreshAccess() {}
  },
}));

import type { SessionInfo } from "../../api";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

const DOC = "doc-big";
const REL = "Big.md";
/** Just over `MAX_NOTE_BYTES` (10 MB) so the uploader's own ceiling refuses it
 *  permanently, with no socket — the production path for a too-large note. */
const OVERSIZED = "x".repeat(10 * 1024 * 1024 + 16);

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

const managers: SyncManager[] = [];

function manager(): SyncManager {
  const sm = new SyncManager();
  managers.push(sm);
  return sm;
}

async function enable(sm: SyncManager) {
  return sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** One connect cycle's `ready.empty`, then the queue drained. */
async function ready(sm: SyncManager, empty: string[]) {
  engineHooks.settled = true;
  engineHooks.opts!.onServerEmpty?.(empty, false);
  await sm.whenBulkSyncSettled();
  await flush();
}

/** Wait past the local-change debounce (800 ms) and let the drain finish. */
async function drainLocalChanges(sm: SyncManager) {
  await new Promise((r) => setTimeout(r, 1_000));
  await sm.whenBulkSyncSettled();
  await flush();
  await new Promise((r) => setTimeout(r, 50));
  await flush();
}

beforeEach(() => {
  vaultScopes.end();
  fakeRegistry.pushed = new Set();
  fakeRegistry.mappedNotes.mockReturnValue([{ docId: DOC, relPath: REL }]);
  fakeRegistry.getMapping.mockImplementation((relPath: string) =>
    relPath === REL ? { vaultId: "collection-1", docId: DOC } : null,
  );
  fakeRegistry.pathForDocId.mockImplementation((docId: string) => (docId === DOC ? REL : null));
  fakeRegistry.emptyOnDisk = new Set();
  fakeRegistry.markPushed.mockClear();
  fakeRegistry.unmarkPushed.mockClear();
  fakeDisk.files.clear();
  fakeDisk.files.set(REL, OVERSIZED);
  fakeDisk.shas.clear();
  engineHooks.opts = null;
  engineHooks.settled = false;
  storeHooks.open = null;
  connects.order = [];
});

afterEach(async () => {
  for (const sm of managers.splice(0)) {
    sm.disable();
    await sm.whenBulkSyncSettled();
  }
  await flush();
});

describe("SyncManager.retryDoc", () => {
  it("re-queues a note the size ceiling permanently refused, once its file shrinks", async () => {
    const sm = manager();
    await enable(sm);

    // The run refuses it locally: no socket, a permanent failure remembered.
    await ready(sm, [DOC]);
    expect(connects.order).toEqual([]);
    const first = sm.syncFailures();
    expect(first.content).toHaveLength(1);
    expect(first.content[0].docId).toBe(DOC);
    expect(first.content[0].permanent).toBe(true);
    expect(first.content[0].reason).toContain("the limit is 10 MB");

    // A further connect must NOT re-queue it — that memory is the whole point of
    // `permanentFailures`.
    connects.order = [];
    await ready(sm, [DOC]);
    expect(connects.order).toEqual([]);

    // The user trims the note and hits Retry on the Health page.
    fakeDisk.files.set(REL, "now small");
    await sm.retryDoc(DOC);

    // The believed-pushed claim is withdrawn straight away, before any await —
    // a doc the server may not have must never stay marked as confirmed.
    expect(fakeRegistry.unmarkPushed).toHaveBeenCalledWith(DOC);
    // And the remembered refusal is gone, so the doc is eligible again.
    expect(sm.syncFailures().content).toHaveLength(0);

    await drainLocalChanges(sm);
    // A real push, over a real socket: `divergedDocs` forces the connect rather
    // than letting the echo guard decide the bytes already landed.
    expect(connects.order).toContain(DOC);
  });

  it("fails permanently again — and stays honest — when the note is still too big", async () => {
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);
    expect(sm.syncFailures().content).toHaveLength(1);

    await sm.retryDoc(DOC); // file untouched: still over the cap
    await drainLocalChanges(sm);

    const after = sm.syncFailures().content;
    expect(after).toHaveLength(1);
    expect(after[0].permanent).toBe(true);
    // Re-failing costs one encode and opens no socket; it is not a retry loop.
    expect(connects.order).toEqual([]);
  });

  it("does nothing for an unmapped doc, and nothing at all when sync is off", async () => {
    const sm = manager();
    await sm.retryDoc(DOC); // never enabled
    expect(fakeRegistry.unmarkPushed).not.toHaveBeenCalled();

    await enable(sm);
    fakeRegistry.pathForDocId.mockReturnValue(null);
    await sm.retryDoc("doc-unknown");
    expect(fakeRegistry.unmarkPushed).not.toHaveBeenCalled();
  });
});

/** `inspectDoc` is the Health page's "Check a note" box. Every field is a fact
 *  the sync layer already holds; the test's job is to prove none of them is
 *  inferred, and that a torn-down vault answers about nothing. */
describe("SyncManager.inspectDoc", () => {
  it("reports a permanent refusal, and the queue state around a retry", async () => {
    const sm = manager();
    await enable(sm);

    // Before anything has run: mapped, nothing claimed.
    expect(sm.inspectDoc(DOC)).toEqual({
      pushed: false,
      queued: false,
      diverged: false,
      permanentFailure: null,
      emptyEverywhere: false,
    });

    // The size ceiling refuses it: the reason is carried, not summarised.
    await ready(sm, [DOC]);
    const refused = sm.inspectDoc(DOC);
    expect(refused.permanentFailure).toContain("the limit is 10 MB");
    expect(refused.queued).toBe(false);

    // Retry queues it, forgets the refusal, withdraws the pushed claim and marks
    // it diverged — all four are visible here, which is the point of the box.
    fakeDisk.files.set(REL, "now small");
    await sm.retryDoc(DOC);
    expect(sm.inspectDoc(DOC)).toEqual({
      pushed: false,
      queued: true,
      diverged: true,
      permanentFailure: null,
      emptyEverywhere: false,
    });

    // Once the push lands, the queue is empty and the server has it.
    await drainLocalChanges(sm);
    const settled = sm.inspectDoc(DOC);
    expect(settled.queued).toBe(false);
    expect(settled.pushed).toBe(true);
    expect(settled.diverged).toBe(false);
  });

  it("settles a note that is empty here AND on the server", async () => {
    const sm = manager();
    await enable(sm);
    fakeDisk.files.set(REL, "");
    fakeRegistry.emptyOnDisk = new Set([REL]);

    await ready(sm, [DOC]);
    const inspected = sm.inspectDoc(DOC);
    // Nothing anywhere is not a failure — it is confirmed by definition, and
    // this flag is what stops it being re-queued on every single connect.
    expect(inspected.emptyEverywhere).toBe(true);
    expect(inspected.pushed).toBe(true);
    expect(inspected.permanentFailure).toBe(null);
  });

  it("answers about nothing when no vault is live", async () => {
    const sm = manager();
    const empty = {
      pushed: false,
      queued: false,
      diverged: false,
      permanentFailure: null,
      emptyEverywhere: false,
    };
    expect(sm.inspectDoc(DOC)).toEqual(empty);

    await enable(sm);
    await ready(sm, [DOC]);
    expect(sm.inspectDoc(DOC).permanentFailure).not.toBe(null);

    // After teardown the registry still holds whatever a fake left behind; the
    // scope guard is what makes the answer honest rather than the vault we left.
    sm.disable();
    expect(sm.inspectDoc(DOC)).toEqual(empty);
  });
});

/** The timeline behind the Health page. It is not a debug log: every line has to
 *  be a sentence about the user's notes. */
describe("SyncManager.syncLog", () => {
  it("records the run, the server's requests and a note's refusal", async () => {
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);

    const events = sm.syncLog().map((e) => e.event);
    expect(events).toContain("server-empty");
    expect(events).toContain("run-start");
    expect(events).toContain("too-large");

    const refusal = sm.syncLog().find((e) => e.event === "too-large")!;
    expect(refusal.level).toBe("error");
    expect(refusal.docId).toBe(DOC);
    expect(refusal.path).toBe(REL);
    expect(refusal.message).toContain(REL);

    // A terminal run with failures says so, in a whole sentence.
    const ended = sm.syncLog().find((e) => e.event === "run-failed");
    expect(ended?.message).toMatch(/not synced$/);

    // No jargon reaches the page.
    for (const e of sm.syncLog()) {
      expect(e.message).not.toMatch(/CRDT|state vector|manifest|docId|Y\.Doc/i);
    }
  });

  it("records a retry, and notifies subscribers", async () => {
    const sm = manager();
    await enable(sm);
    const seen: number[] = [];
    const off = sm.onSyncLog(() => seen.push(sm.syncLog().length));

    await sm.retryDoc(DOC);
    const retry = sm.syncLog().find((e) => e.event === "retry");
    expect(retry?.message).toBe("Retrying this note");
    expect(retry?.path).toBe(REL);
    expect(seen.length).toBeGreaterThan(0);

    off();
    const before = seen.length;
    await sm.retrySync();
    expect(seen.length).toBe(before);
  });

  it("empties on teardown — the vault you left explains nothing about this one", async () => {
    const sm = manager();
    await enable(sm);
    await ready(sm, [DOC]);
    expect(sm.syncLog().length).toBeGreaterThan(0);
    sm.disable();
    expect(sm.syncLog()).toEqual([]);
  });
});
