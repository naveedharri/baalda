// Presence announces the note we are looking at by resolving its PATH through
// the registry at SEND time (#125).
//
// The old shape resolved the id ONCE, in `store.openNoteByPath`, and replayed
// it for the rest of the session. A member who joined a vault and clicked a
// note while the post-join reconcile was still running therefore announced
// whatever was true in that instant — nothing, or (worse) the LOCAL index id,
// which the server drops in silence because it isn't in anyone's readable set.
// The owner never saw them; they saw the owner fine. Switching notes after the
// reconcile settled "fixed" it, which is exactly the tell that the value was
// cached rather than computed.
//
// These pin the two halves of the fix: resolve on every announce, and
// re-announce when the registry map moves (without the user touching anything).

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultDocStoreOptions } from "../vaultDocStore";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";

const COLLECTION = "collection-1";
const NOTE = "Projects/Community/plan.md";
const NOTE_DOC = "server-doc-1";
const LOCAL_ID = "3f7c1e94-local-only";

/**
 * A registry whose path→docId map is a real (tiny) Map, so `getMappingCi`
 * behaves the way production's does rather than being a canned answer: exact
 * hit first, case-folded fallback on a miss.
 */
const fakeRegistry = vi.hoisted(() => {
  const byPath = new Map<string, { vaultId: string; docId: string }>();
  let mapListener: (() => void) | null = null;
  const reg = {
    byPath,
    vaultId: null as string | null,
    /** Test hook: publish a mapping the way a pull/registerNote would. */
    land(relPath: string, docId: string) {
      byPath.set(relPath, { vaultId: COLLECTION, docId });
      mapListener?.();
    },
    /** Test hook: fire the map listener with nothing actually changed. */
    touch() {
      mapListener?.();
    },
    primeLocal: vi.fn(async () => true),
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn((relPath: string) => byPath.get(relPath) ?? null),
    getMappingCi: vi.fn((relPath: string) => {
      const exact = byPath.get(relPath);
      if (exact) return exact;
      const want = relPath.toLowerCase();
      for (const [rp, m] of byPath) if (rp.toLowerCase() === want) return m;
      return null;
    }),
    pathForDocId: vi.fn((): string | null => null),
    allDocIds: vi.fn((): string[] => []),
    isNoteEmptyOnDisk: vi.fn(async () => false),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn((cb: (() => void) | null) => {
      mapListener = cb;
    }),
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
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  writeTrashCopy: vi.fn(async () => "trash"),
  rebindNoteId: vi.fn(async () => true),
}));

vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
    resetNoteHistory: vi.fn(async () => {}),
  },
}));

/** Every presence frame the engine was handed, in order. */
const engineHooks = vi.hoisted(() => ({
  presence: [] as Array<{ docId: string | null; status: string }>,
}));

vi.mock("../vaultSyncEngine", () => ({
  VaultSyncEngine: class {
    constructor(_opts: VaultSyncEngineOptions) {}
    start() {}
    stop() {}
    setPresence(p: { docId: string | null; status: string } | null) {
      if (p) engineHooks.presence.push({ docId: p.docId, status: p.status });
    }
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
      return null;
    }
    setSuppressedDoc() {}
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
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Joiner", email: "joiner@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

/** The coalescing window on the map-change re-announce, with slack. */
const settleRepush = () => new Promise((r) => setTimeout(r, 220));

const last = () => engineHooks.presence[engineHooks.presence.length - 1];

async function enabled(): Promise<SyncManager> {
  const sm = new SyncManager();
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  return sm;
}

beforeEach(() => {
  vi.useRealTimers();
  vaultScopes.end();
  fakeRegistry.byPath.clear();
  fakeRegistry.vaultId = COLLECTION;
  fakeRegistry.getMapping.mockClear();
  fakeRegistry.getMappingCi.mockClear();
  fakeRegistry.mappedNotes.mockReturnValue([]);
  engineHooks.presence.length = 0;
});

describe("SyncManager presence — announce-time resolution", () => {
  it("announces null, then the server id once the mapping lands — no reopen", async () => {
    // The repro: the joiner clicks a note while the reconcile is still mapping
    // notes, so the registry has nothing for its path yet.
    const sm = await enabled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sm.setViewing(NOTE, LOCAL_ID);

    // NOT the local id: teammates' readable sets are keyed on server ids, so a
    // local one is dropped in silence — and it would poison the change check
    // below into thinking we had already announced this note.
    expect(last()).toEqual({ docId: null, status: "online" });
    expect(engineHooks.presence.some((p) => p.docId === LOCAL_ID)).toBe(false);
    // …and it says so out loud, once, because both drops were silent.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(NOTE);

    const before = engineHooks.presence.length;
    // The reconcile registers the note. Nothing else happens — the user does
    // not switch notes, which is what used to be required.
    fakeRegistry.land(NOTE, NOTE_DOC);
    await settleRepush();

    expect(engineHooks.presence.length).toBe(before + 1);
    expect(last()).toEqual({ docId: NOTE_DOC, status: "online" });
    warn.mockRestore();
  });

  it("stays quiet when a map change doesn't move the resolved id", async () => {
    // A registry pull fires the map listener once per note. Re-announcing on
    // each would be thousands of frames for one unchanged answer.
    const sm = await enabled();
    fakeRegistry.byPath.set(NOTE, { vaultId: COLLECTION, docId: NOTE_DOC });
    sm.setViewing(NOTE, LOCAL_ID);
    expect(last()?.docId).toBe(NOTE_DOC);

    const before = engineHooks.presence.length;
    for (let i = 0; i < 50; i++) fakeRegistry.touch();
    await settleRepush();
    expect(engineHooks.presence.length).toBe(before);
  });

  it("resolves a case-different disk spelling", async () => {
    // The registry keys a note by the SERVER's spelling; the store opens it by
    // the disk one. On macOS/Windows those are the same file.
    const sm = await enabled();
    fakeRegistry.byPath.set("Projects/Community/plan.md", {
      vaultId: COLLECTION,
      docId: NOTE_DOC,
    });
    sm.setViewing("Projects/community/plan.md", LOCAL_ID);
    expect(last()?.docId).toBe(NOTE_DOC);
  });

  it("announces nothing for a closed note, and again once reopened", async () => {
    const sm = await enabled();
    fakeRegistry.byPath.set(NOTE, { vaultId: COLLECTION, docId: NOTE_DOC });
    sm.setViewing(NOTE, LOCAL_ID);
    expect(last()?.docId).toBe(NOTE_DOC);

    sm.setViewing(null);
    expect(last()?.docId).toBeNull();
    // A map change with nothing open must not resurrect the dot.
    const before = engineHooks.presence.length;
    fakeRegistry.land("Other/note.md", "server-doc-2");
    await settleRepush();
    expect(engineHooks.presence.length).toBe(before);
  });

  it("keeps Invisible invisible, including when the mapping lands later", async () => {
    // Invisible broadcasts a null doc BY DESIGN. Announce-time resolution must
    // not leak the real id through the re-announce path.
    const sm = await enabled();
    sm.setPresenceStatus("invisible");
    sm.setViewing(NOTE, LOCAL_ID);
    expect(last()).toEqual({ docId: null, status: "invisible" });

    const before = engineHooks.presence.length;
    fakeRegistry.land(NOTE, NOTE_DOC);
    await settleRepush();
    expect(engineHooks.presence.length).toBe(before);
    expect(last()?.docId).toBeNull();

    // Coming back online announces the id resolved NOW, not the stale null.
    sm.setPresenceStatus("online");
    expect(last()).toEqual({ docId: NOTE_DOC, status: "online" });
  });
});
