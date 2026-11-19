// #406: a file that changes while its one-step registration is in flight.
//
// A script or agent creates a note and fills it a moment later. The app reads
// the file (empty) for the seed, the fill's watcher event lands while the note
// is still unmapped (so it only asks for a registry pull), and the server
// answers `covered` for the empty state. Settling that answer as "synced" left
// the server, and every teammate, with a 0-byte note while the sender's file
// held the text and its badge said synced.
//
// `noteSeeded` now re-reads the file after the answer:
//   · fresh seed (built from the file), file moved on ⇒ never settled; the
//     local CRDT is cleared and the doc goes to the HTTP pull-then-merge, which
//     starts from the server's ops and folds the current file in (no doubling);
//   · seed from the local CRDT, file moved on ⇒ settled, then queued for the
//     same ingest + push its lost watcher event would have queued;
//   · file unchanged ⇒ exactly today's behaviour.
//
// Same fake style as `oneStepMergeOpenNote.test.ts`.

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

const disk = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  clearYjsDoc: vi.fn(async () => {}),
  readNote: vi.fn(async (p: string) => {
    const t = disk.files.get(p);
    if (t === undefined) throw new Error("missing");
    return t;
  }),
  writeTrashCopy: vi.fn(async () => ".context/trash/x"),
  loadYjsState: vi.fn(async () => ({ snapshot: null, updates: [], updateCount: 0 })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
}));

vi.mock("../../auth/authManager", () => ({
  api: {},
  authManager: { getServerUrl: () => "http://server.test" },
}));
vi.mock("../vaultSyncEngine", () => ({ VaultSyncEngine: class {} }));
vi.mock("../syncManager", () => ({ DocSync: class {} }));
vi.mock("../vaultDocStore", () => ({
  createIpcManifestStore: () => ({ load: async () => [], save: async () => {} }),
  VaultDocStore: class {},
}));

import { sha256Hex } from "../../bridge/adapter";
import * as ipc from "../../ipc";
import { SyncManager } from "../docSession";
import type { NoteSeedState } from "../registry";

const REL = "agent/README.md";
const FILLED = "# README\n\nWritten by the agent a moment after creating the file.\n";

const store = vi.hoisted(() => ({ applied: [] as string[], log: [] as string[] }));

function fakeStore() {
  return {
    suppressedDoc: () => null,
    release: async (d: string) => void store.log.push(`release:${d}`),
    drop: (d: string) => void store.log.push(`drop:${d}`),
    promote: async (d: string) => {
      store.log.push(`promote:${d}`);
      return {
        doc: new Y.Doc(),
        serialize: () => "",
        applyRemote: () => void store.applied.push(d),
        flushEgest: async () => {},
      };
    },
    demote: async (d: string) => void store.log.push(`demote:${d}`),
  };
}

function manager() {
  const sm = new SyncManager();
  const internals = sm as unknown as Record<string, unknown>;
  internals.enabled = true;
  internals.scope = { isCurrent: () => true, vaultEpoch: 1 };
  internals.docStore = fakeStore();
  const merge = vi.spyOn(sm, "noteNeedsMerge").mockImplementation(() => {});
  const priv = sm as unknown as { armLocalChangeDrain(...a: unknown[]): void };
  const drain = vi.spyOn(priv, "armLocalChangeDrain").mockImplementation(() => {});
  const localChanges = internals.localChanges as Map<string, string>;
  return { sm, merge, drain, localChanges };
}

async function seedOf(text: string, fresh: boolean): Promise<NoteSeedState> {
  const d = new Y.Doc();
  if (text) d.getText("content").insert(0, text);
  const state = Y.encodeStateAsUpdate(d);
  d.destroy();
  return { state, textSha256: await sha256Hex(text), fresh };
}

beforeEach(() => {
  store.applied = [];
  store.log = [];
  disk.files.clear();
  fakeRegistry.paths.clear();
  fakeRegistry.paths.set("d", REL);
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("noteSeeded when the file changed during registration (#406)", () => {
  it("fresh empty seed, file filled meanwhile: not settled, local CRDT cleared, merged", async () => {
    const { sm, merge, localChanges } = manager();
    const seed = await seedOf("", true);
    disk.files.set(REL, FILLED); // the fill landed while the request was in flight

    await sm.noteSeeded("d", null, seed);

    expect(fakeRegistry.markPushed).not.toHaveBeenCalled();
    expect(fakeRegistry.recordAck).not.toHaveBeenCalled();
    expect(store.applied).toEqual([]); // the stale seed is never written over the file
    expect(store.log).toEqual(["promote:d", "demote:d", "drop:d"]);
    expect(ipc.clearYjsDoc).toHaveBeenCalledWith("d", 1);
    expect(merge).toHaveBeenCalledWith(["d"]);
    expect(localChanges.size).toBe(0);
  });

  it("fresh partial seed, file grew meanwhile: merged, never settled", async () => {
    const { sm, merge } = manager();
    const seed = await seedOf("# README\n", true);
    disk.files.set(REL, FILLED);

    await sm.noteSeeded("d", null, seed);

    expect(fakeRegistry.markPushed).not.toHaveBeenCalled();
    expect(store.applied).toEqual([]);
    expect(merge).toHaveBeenCalledWith(["d"]);
  });

  it("fresh seed, file unchanged: applied and settled exactly as before", async () => {
    const { sm, merge, drain } = manager();
    const seed = await seedOf(FILLED, true);
    disk.files.set(REL, FILLED);

    await sm.noteSeeded("d", null, seed);

    expect(store.applied).toEqual(["d"]);
    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("d");
    expect(fakeRegistry.recordAck).toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it("seed from the local CRDT, file changed meanwhile: settled, then queued for ingest + push", async () => {
    const { sm, merge, drain, localChanges } = manager();
    const seed = await seedOf("# README\n", false);
    disk.files.set(REL, FILLED);

    await sm.noteSeeded("d", null, seed);

    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("d");
    expect(localChanges.get("d")).toBe(REL);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
  });

  it("seed from the local CRDT, file unchanged: nothing queued", async () => {
    const { sm, drain, localChanges } = manager();
    const seed = await seedOf(FILLED, false);
    disk.files.set(REL, FILLED);

    await sm.noteSeeded("d", null, seed);

    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("d");
    expect(localChanges.size).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it("an unreadable file is no evidence: today's behaviour", async () => {
    const { sm, merge } = manager();
    const seed = await seedOf("", true); // file missing from `disk`

    await sm.noteSeeded("d", null, seed);

    expect(fakeRegistry.markPushed).toHaveBeenCalledWith("d");
    expect(merge).not.toHaveBeenCalled();
  });
});
