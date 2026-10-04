// One-step creates: the HTTP merge and the OPEN note.
//
// `httpMergeOnce` must never put a second bridge on the file the editor holds.
// It used to `continue` past the open note and forget the id, so a conflict or
// adopt on a note the user had open was never merged. Now the id is parked and
// runs when the note closes. An adopt whose LOSER id is the open note parks the
// loser's release AND the winner's merge for the same path, so the editor's
// bridge (bound to the dead id) is never shadowed by the winner's.
//
// Same fake style as `docSessionEmptyNote.test.ts`; private fields are set
// directly so no vault has to be enabled.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: "collection-1" as string | null,
    paths: new Map<string, string>(),
    pathForDocId: vi.fn((docId: string): string | null => reg.paths.get(docId) ?? null),
    markPushed: vi.fn(),
    recordAck: vi.fn(),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    setNoteMetaListener: vi.fn(),
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    setInboundHost: vi.fn(),
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
  clearYjsDoc: vi.fn(async () => {}),
  readNote: vi.fn(async () => ""),
  writeTrashCopy: vi.fn(async () => ".context/trash/x"),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
}));

vi.mock("../../auth/authManager", () => ({
  api: {
    createBootstrapSession: vi.fn(async () => ({ sessionId: "s1" })),
    fetchBootstrapPage: vi.fn(async () => ({ bytes: new Uint8Array(), nextCursor: null })),
  },
  authManager: { getServerUrl: () => "http://server.test" },
}));

vi.mock("../bootstrapCodec", () => ({ decodeBootstrapPage: () => [] }));

vi.mock("../contentUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contentUpload")>()),
  mergeFileAfterPull: vi.fn(async () => {}),
}));

vi.mock("../vaultSyncEngine", () => ({ VaultSyncEngine: class {} }));
vi.mock("../syncManager", () => ({ DocSync: class {} }));

const store = vi.hoisted(() => ({
  open: null as string | null,
  log: [] as string[],
}));

vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {},
}));

import { BOOTSTRAP_ONLY } from "../../serverFeatures";
import { SyncManager } from "../docSession";

const REL = "Plan.md";

/** The bits of `VaultDocStore` the merge touches, logging every call. */
function fakeStore() {
  return {
    suppressedDoc: () => store.open,
    setSuppressedDoc: (d: string | null) => {
      store.open = d;
    },
    holdUntil: () => {},
    release: async (d: string) => {
      store.log.push(`release:${d}`);
    },
    drop: (d: string) => {
      store.log.push(`drop:${d}`);
    },
    promote: async (d: string) => {
      store.log.push(`promote:${d}`);
      return {
        doc: new Y.Doc(),
        serialize: () => "",
        applyRemote: () => {},
        flushEgest: async () => {},
      };
    },
    demote: async (d: string) => {
      store.log.push(`demote:${d}`);
    },
  };
}

const managers: SyncManager[] = [];

function manager(): SyncManager {
  const sm = new SyncManager();
  managers.push(sm);
  const internals = sm as unknown as Record<string, unknown>;
  internals.enabled = true;
  internals.scope = { isCurrent: () => true, vaultEpoch: 1 };
  internals.docStore = fakeStore();
  vi.spyOn(sm, "serverFeatures").mockResolvedValue(new Set([BOOTSTRAP_ONLY]));
  const priv = sm as unknown as {
    contentRunInFlight(): boolean;
    runDocBatchPush(...args: unknown[]): Promise<unknown>;
  };
  vi.spyOn(priv, "contentRunInFlight").mockReturnValue(false);
  vi.spyOn(priv, "runDocBatchPush").mockResolvedValue({
    pushed: 1,
    conflicts: [],
    oversized: [],
    deferred: [],
    denied: [],
    failures: [],
    cancelled: false,
    requests: 1,
  });
  return sm;
}

/** Let the fire-and-forget `runHttpMerge` settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  store.open = null;
  store.log = [];
  fakeRegistry.paths.clear();
});

afterEach(() => {
  managers.length = 0;
  vi.restoreAllMocks();
});

describe("HTTP merge and the open note", () => {
  it("a conflict on the open note stays queued and merges after the note closes", async () => {
    const sm = manager();
    fakeRegistry.paths.set("d", REL);
    store.open = "d";
    (sm as unknown as { currentRelPath: string | null }).currentRelPath = REL;

    sm.noteNeedsMerge(["d"]);
    await settle();
    // Nothing touched the editor's doc: no release, no second bridge.
    expect(store.log).toEqual([]);
    expect((sm as unknown as { deferredMerge: Map<string, unknown> }).deferredMerge.has("d")).toBe(true);

    sm.closeCurrent();
    await settle();
    expect(store.log).toEqual(["release:d", "drop:d", "promote:d", "demote:d"]);
    expect((sm as unknown as { deferredMerge: Map<string, unknown> }).deferredMerge.size).toBe(0);
  });

  it("a parked merge also rejoins the next run once the note is no longer open", async () => {
    const sm = manager();
    fakeRegistry.paths.set("d", REL);
    fakeRegistry.paths.set("e", "Other.md");
    store.open = "d";

    sm.noteNeedsMerge(["d"]);
    await settle();
    expect(store.log).toEqual([]);

    // The editor switched notes without this manager's close (e.g. a tab
    // replaced by `openDoc`, whose own close runs first anyway).
    store.open = null;
    sm.noteNeedsMerge(["e"]);
    await settle();
    expect(store.log.filter((l) => l.startsWith("promote:")).sort()).toEqual(["promote:d", "promote:e"]);
  });

  it("an adopt whose loser is the open note: loser kept, winner for the same path parked, both run on close", async () => {
    const sm = manager();
    fakeRegistry.paths.set("winner", REL); // the registry re-keyed the path to the winner
    store.open = "loser";
    (sm as unknown as { currentRelPath: string | null }).currentRelPath = REL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    sm.noteNeedsMerge(["winner"], ["loser"]);
    await settle();
    expect(store.log).toEqual([]); // no release of the editor's id, no winner bridge on its file
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loser"));
    const internals = sm as unknown as {
      pendingLoserRelease: Set<string>;
      deferredMerge: Map<string, unknown>;
    };
    expect(internals.pendingLoserRelease.has("loser")).toBe(true);
    expect(internals.deferredMerge.has("winner")).toBe(true);

    sm.closeCurrent();
    await settle();
    expect(store.log).toEqual([
      "release:loser",
      "drop:loser",
      "release:winner",
      "drop:winner",
      "promote:winner",
      "demote:winner",
    ]);
    expect(internals.pendingLoserRelease.size).toBe(0);
  });
});
