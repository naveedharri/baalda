// The connection badge, across a vault switch.
//
// The manager decides whether to speak by diffing against its OWN last emission
// (`emittedStatus`), while the store drops its copy to `offline` on every
// switch/sign-in (`vaultScopedSyncReset`) without telling it. The two only stay
// equal because `teardown()` clears that cache, so the next channel connect
// publishes again from scratch. Drop that one line and the app reads "offline"
// on a vault that is demonstrably connected, until the webview is reloaded —
// which is the shape of the bug reported on 2026-09-17 (whose actual cause was
// a dev-only HMR reload, see the note at the end of `docSession.ts`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VaultDocStoreOptions } from "../vaultDocStore";
import type { VaultSyncEngineOptions } from "../vaultSyncEngine";

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

const engineHooks = vi.hoisted(() => ({
  started: 0,
  opts: null as VaultSyncEngineOptions | null,
  /** What the fake engine answers to `backfillSettled()`. */
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
    refresh() {}
    inboundProgress() {
      return { done: 0, total: 0, queued: 0 };
    }
    backfillSettled() {
      return engineHooks.settled;
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
import type { SyncStatus } from "../syncManager";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
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
  fakeRegistry.pathForDocId.mockReset().mockReturnValue(null);
  fakeRegistry.mappedNotes.mockReturnValue([]);
  engineHooks.started = 0;
  engineHooks.opts = null;
  engineHooks.settled = false;
  storeHooks.created = 0;
  storeHooks.suppressed = null;
});

describe("the badge after a vault switch", () => {
  it("re-publishes `synced` to a store that reset itself to `offline`", async () => {
    const sm = new SyncManager();
    const seen: SyncStatus[] = [];
    // What the store does with it, mirrored: the badge the user reads.
    let badge: SyncStatus = "offline";
    sm.setStatusListener((s) => {
      seen.push(s);
      badge = s;
    });

    await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
    await flush();
    engineHooks.opts?.onStatus?.("synced");
    expect(badge).toBe("synced");

    // The switch: the store's own reset writes `offline` behind the manager's
    // back, so nothing but a fresh publish can put the badge back.
    sm.disable();
    badge = "offline";
    await sm.enable(session(), { orgId: "org-b", name: "b", path: "/vaults/b", epoch: 2 });
    await flush();
    engineHooks.opts?.onStatus?.("synced");

    expect(badge).toBe("synced");
    expect(seen.filter((s) => s === "synced")).toHaveLength(2);
  });
});
