// A sidebar delete of a note whose registration is still in flight.
//
// Before: `deletePath` found no mapping (the server had not answered yet), so
// it skipped the server; the file went from disk; the registration then landed
// and mapped a note that no longer existed locally; and the next pull wrote it
// back from the server — "1 note you removed… was restored", after every new
// file. Now the delete waits for the registrations in flight, then deletes the
// freshly registered note on the server like any other.
//
// Everything is faked: no Tauri, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null as string | null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => [] as Array<{ id: string; path: string; title: string }>),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  isVaultMismatch: (e: unknown) => e instanceof Error && e.message.startsWith("vault-mismatch"),
}));
vi.mock("../../vault/seed", () => ({
  seedWelcomeContent: vi.fn(async () => {}),
}));

import type { ApiClient } from "../../api";
import type { NoteDeleteResult } from "../bulkTypes";
import { REGISTRATION_SETTLE_MS, VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";
const EMPTY = { id: "root", name: "vault", path: "", isDir: true, children: [] };

/** A deferred: a promise the test resolves when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeApi() {
  const state = {
    singleDeletes: [] as string[],
    batchDeletes: [] as string[],
    deletedFolders: [] as string[],
    /** Holds the next createNote/createFolder answer until the test releases it. */
    pendingNote: null as ReturnType<typeof deferred<void>> | null,
    pendingFolder: null as ReturnType<typeof deferred<void>> | null,
  };
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => {
      if (state.pendingFolder) await state.pendingFolder.promise;
      return { id: `folder-${input.path}`, path: input.path };
    }),
    createNote: vi.fn(async (input: { relPath: string; docId?: string }) => {
      if (state.pendingNote) await state.pendingNote.promise;
      return { id: input.docId ?? `srv-${input.relPath}`, rel_path: input.relPath, title: null };
    }),
    deleteNote: vi.fn(async (id: string) => {
      state.singleDeletes.push(id);
    }),
    deleteFolder: vi.fn(async (id: string) => {
      state.deletedFolders.push(id);
    }),
    deleteNotesBatch: vi.fn(async (_vaultId: string, docIds: string[]) => {
      state.batchDeletes.push(...docIds);
      return docIds.map(
        (docId): NoteDeleteResult => ({ docId, status: "deleted", code: null, error: null }),
      );
    }),
  } as unknown as ApiClient;
  return { api, state };
}

async function connectedRegistry(api: ApiClient) {
  const reg = new VaultRegistry(api);
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, EMPTY);
  return reg;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("deleting a note whose registration is in flight", () => {
  it("waits for the registration, then deletes the note on the server", async () => {
    const { api, state } = fakeApi();
    const reg = await connectedRegistry(api);

    state.pendingNote = deferred<void>();
    const registering = reg.registerNote("Untitled.md", "Untitled", "doc-1");
    let deleted = false;
    const deleting = reg.deletePath("Untitled.md").then(() => {
      deleted = true;
    });

    // Still registering: the delete must not have given up on the server yet.
    await Promise.resolve();
    expect(deleted).toBe(false);
    expect(state.singleDeletes).toEqual([]);

    state.pendingNote.resolve();
    await registering;
    await deleting;

    expect(state.singleDeletes).toEqual(["doc-1"]);
    expect(reg.getMapping("Untitled.md")).toBeNull();
  });

  it("covers the batched route too", async () => {
    const { api, state } = fakeApi();
    const reg = await connectedRegistry(api);

    state.pendingNote = deferred<void>();
    const registering = reg.registerNote("Untitled 1.md", "Untitled 1", "doc-2");
    const deleting = reg.deletePaths(["Untitled 1.md"]);
    state.pendingNote.resolve();
    await registering;
    const outcomes = await deleting;

    expect(outcomes.map((o) => o.status)).toEqual(["deleted"]);
    expect([...state.singleDeletes, ...state.batchDeletes]).toEqual(["doc-2"]);
    expect(reg.getMapping("Untitled 1.md")).toBeNull();
  });

  it("waits for a new folder's registration before deleting it", async () => {
    const { api, state } = fakeApi();
    const reg = await connectedRegistry(api);

    state.pendingFolder = deferred<void>();
    const registering = reg.registerFolder("New Folder", "New Folder");
    const deleting = reg.deletePath("New Folder");
    state.pendingFolder.resolve();
    await registering;
    await deleting;

    expect(state.deletedFolders).toEqual(["folder-New Folder"]);
    expect(reg.getFolderId("New Folder")).toBeNull();
  });

  it("does not wait when nothing is registering", async () => {
    const { api, state } = fakeApi();
    const reg = await connectedRegistry(api);

    await reg.deletePath("Never registered.md");

    expect(state.singleDeletes).toEqual([]);
  });

  it("gives up waiting after the bound, so a hung request cannot freeze a delete", async () => {
    const { api, state } = fakeApi();
    const reg = await connectedRegistry(api);

    vi.useFakeTimers();
    state.pendingNote = deferred<void>(); // never resolved
    void reg.registerNote("Stuck.md", "Stuck", "doc-3");
    let deleted = false;
    const deleting = reg.deletePath("Stuck.md").then(() => {
      deleted = true;
    });

    await vi.advanceTimersByTimeAsync(REGISTRATION_SETTLE_MS - 1);
    expect(deleted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deleting;

    expect(deleted).toBe(true);
    expect(state.singleDeletes).toEqual([]);
  });
});
