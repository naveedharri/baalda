// `VaultRegistry.deletePaths` — the batched twin of `deletePath`.
//
// The contract this suite exists to pin is NOT "it is faster": it is that a
// batch of N leaves this registry in EXACTLY the state N single deletes would
// (the drift test below, modelled on the server's `bulk-registry-batch.test.ts`),
// and that every per-item verdict lands where the single route's throw/return
// would have. A batch that quietly dropped a `denied` note's mapping would make
// the next pull re-materialize the file as a stranger — the ghost the whole
// delete path exists to avoid.
//
// Everything is faked: no Tauri, no network.

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { ApiError, BulkApiError, type ApiClient } from "../../api";
import type { NoteDeleteResult } from "../bulkTypes";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { BATCH_MAX_NOTES } from "../pool";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";

const notePath = (i: number) => `Note${i}.md`;
const serverId = (relPath: string) => `srv-${relPath}`;

function tree(n: number, folders: string[] = []): TreeNode {
  const children: TreeNode[] = folders.map((path) => ({
    id: path,
    name: path.split("/").pop()!,
    path,
    isDir: true,
    children: [],
  }));
  for (let i = 0; i < n; i++) {
    children.push({ id: `n${i}`, name: notePath(i), path: notePath(i), isDir: false });
  }
  return { id: "root", name: "vault", path: "", isDir: true, children };
}

interface FakeOpts {
  /** docId → the result the batch route answers with (default: `deleted`). */
  deleteResults?: Map<string, NoteDeleteResult>;
  /** Make the batch route answer 404, like a server without it. */
  serverTooOld?: boolean;
  /** Make the single-note route throw this status. */
  failSingle?: Map<string, number>;
}

function fakeApi(opts: FakeOpts = {}) {
  const state = {
    /** One entry per `notes/delete-batch` REQUEST, holding the ids it carried. */
    deleteBatches: [] as string[][],
    /** One entry per `DELETE /api/notes/:id`. */
    singleDeletes: [] as string[],
    deletedFolders: [] as string[],
  };
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({
      id: `folder-${input.path}`,
      path: input.path,
    })),
    batchCreateFolders: vi.fn(async (_v: string, items: Array<{ path: string }>) =>
      items.map((i) => ({
        path: i.path,
        id: `folder-${i.path}`,
        status: "created" as const,
        code: null,
        error: null,
      })),
    ),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: serverId(input.relPath),
      rel_path: input.relPath,
      title: null,
    })),
    batchCreateNotes: vi.fn(async (_v: string, items: Array<{ relPath: string }>) =>
      items.map((i) => ({
        relPath: i.relPath,
        docId: serverId(i.relPath),
        status: "created" as const,
        folderId: null,
        title: null,
        code: null,
        error: null,
      })),
    ),
    deleteNote: vi.fn(async (id: string) => {
      state.singleDeletes.push(id);
      const status = opts.failSingle?.get(id);
      if (status !== undefined) throw new ApiError(status, `boom ${status}`);
    }),
    deleteFolder: vi.fn(async (id: string) => {
      state.deletedFolders.push(id);
    }),
    deleteNotesBatch: vi.fn(async (_vaultId: string, docIds: string[]) => {
      if (opts.serverTooOld) {
        throw new BulkApiError(404, "server_too_old", "no such route");
      }
      state.deleteBatches.push([...docIds]);
      return docIds.map(
        (docId): NoteDeleteResult =>
          opts.deleteResults?.get(docId) ?? {
            docId,
            status: "deleted",
            code: null,
            error: null,
          },
      );
    }),
  } as unknown as ApiClient;
  return { api, state };
}

/** `.context/config.json` as one mutable string, like the real file. */
function configFile() {
  let content: string | null = null;
  vi.mocked(ipc.getVaultConfig).mockImplementation(async () => content);
  vi.mocked(ipc.setVaultConfig).mockImplementation(async (c: string) => {
    content = c;
  });
  return { read: () => (content ? (JSON.parse(content) as Record<string, unknown>) : null) };
}

/** A registered registry holding `n` notes, every one of them confirmed pushed. */
async function registryWith(n: number, api: ApiClient, folders: string[] = []) {
  const reg = new VaultRegistry(api);
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(n, folders));
  for (const m of reg.mappedNotes()) reg.markPushed(m.docId);
  return reg;
}

/** Everything about a registry a delete is allowed to touch. */
function snapshot(reg: VaultRegistry) {
  const mapped = reg.mappedNotes().map((m) => `${m.relPath}=${m.docId}`).sort();
  return {
    mapped,
    pushed: reg.mappedNotes().map((m) => `${m.docId}:${reg.isPushed(m.docId)}`).sort(),
    byDocId: reg.allDocIds().slice().sort(),
    lookups: mapped.map((entry) => {
      const relPath = entry.split("=")[0];
      return `${relPath}->${reg.getMapping(relPath)?.docId ?? "none"}`;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
});

describe("VaultRegistry.deletePaths — no drift from deletePath", () => {
  it("a batch of 30 leaves EXACTLY what 30 single deletes leave", async () => {
    const paths = Array.from({ length: 30 }, (_, i) => notePath(i));

    const batched = fakeApi();
    const batchCfg = configFile();
    const regBatch = await registryWith(40, batched.api);
    const outcomes = await regBatch.deletePaths(paths);
    await regBatch.flushCheckpoint();

    const single = fakeApi();
    const singleCfg = configFile();
    const regSingle = await registryWith(40, single.api);
    for (const p of paths) await regSingle.deletePath(p);
    await regSingle.flushCheckpoint();

    // Same local state…
    expect(snapshot(regBatch)).toEqual(snapshot(regSingle));
    // …down to what lands in `.context/config.json`.
    expect(batchCfg.read()?.docs).toEqual(singleCfg.read()?.docs);
    expect(batchCfg.read()?.pushed).toEqual(singleCfg.read()?.pushed);
    // The ten survivors are untouched; the thirty are gone from every map.
    expect(regBatch.mappedNotes()).toHaveLength(10);
    expect(outcomes.every((o) => o.status === "deleted")).toBe(true);

    // …and the transport is the only difference: ONE request, not thirty.
    expect(batched.state.deleteBatches).toHaveLength(1);
    expect(batched.state.singleDeletes).toEqual([]);
    expect(single.state.singleDeletes).toHaveLength(30);
  });

  it("chunks at BATCH_MAX_NOTES — 450 notes are 200 + 200 + 50", async () => {
    const { api, state } = fakeApi();
    configFile();
    const reg = await registryWith(450, api);

    const paths = Array.from({ length: 450 }, (_, i) => notePath(i));
    const outcomes = await reg.deletePaths(paths);

    expect(state.deleteBatches.map((b) => b.length)).toEqual([BATCH_MAX_NOTES, BATCH_MAX_NOTES, 50]);
    expect(state.singleDeletes).toEqual([]);
    expect(outcomes.filter((o) => o.status === "deleted")).toHaveLength(450);
    expect(reg.mappedNotes()).toEqual([]);
  });
});

describe("VaultRegistry.deletePaths — per-item verdicts", () => {
  it("a denied note KEEPS its mapping and is reported", async () => {
    const denied = serverId(notePath(3));
    const { api } = fakeApi({
      deleteResults: new Map([
        [denied, { docId: denied, status: "denied", code: "no_edit_permission", error: null }],
      ]),
    });
    configFile();
    const reg = await registryWith(30, api);

    const paths = Array.from({ length: 30 }, (_, i) => notePath(i));
    const outcomes = await reg.deletePaths(paths);

    const refused = outcomes.find((o) => o.path === notePath(3))!;
    expect(refused.status).toBe("denied");
    expect(refused.code).toBe("no_edit_permission");
    // The mapping survives: a later pull re-materializes the file WITH its
    // content instead of leaving a half-deleted ghost.
    expect(reg.getMapping(notePath(3))?.docId).toBe(denied);
    expect(reg.isPushed(denied)).toBe(true);
    expect(reg.mappedNotes()).toHaveLength(1);
  });

  it("treats `unknown_note` as done — the batch's 404", async () => {
    // The single route swallows a 404 for exactly this reason: the row is
    // already gone, which IS the goal state.
    const gone = serverId(notePath(1));
    const { api } = fakeApi({
      deleteResults: new Map([
        [gone, { docId: gone, status: "error", code: "unknown_note", error: "no such note" }],
      ]),
    });
    configFile();
    const reg = await registryWith(30, api);

    const outcomes = await reg.deletePaths(Array.from({ length: 30 }, (_, i) => notePath(i)));

    expect(outcomes.find((o) => o.path === notePath(1))?.status).toBe("deleted");
    expect(reg.getMapping(notePath(1))).toBeNull();
  });

  it("an errored item keeps its mapping and carries the server's reason", async () => {
    const bad = serverId(notePath(5));
    const { api } = fakeApi({
      deleteResults: new Map([
        [bad, { docId: bad, status: "error", code: null, error: "database is on fire" }],
      ]),
    });
    configFile();
    const reg = await registryWith(30, api);

    const outcomes = await reg.deletePaths(Array.from({ length: 30 }, (_, i) => notePath(i)));

    const failed = outcomes.find((o) => o.path === notePath(5))!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("database is on fire");
    expect(reg.getMapping(notePath(5))?.docId).toBe(bad);
  });
});

describe("VaultRegistry.deletePaths — older servers and folders", () => {
  it("falls back to the per-note route on `server_too_old`", async () => {
    const { api, state } = fakeApi({ serverTooOld: true });
    configFile();
    const reg = await registryWith(30, api);

    const paths = Array.from({ length: 30 }, (_, i) => notePath(i));
    const outcomes = await reg.deletePaths(paths);

    expect(state.deleteBatches).toEqual([]); // the route 404'd
    expect(state.singleDeletes.sort()).toEqual(paths.map(serverId).sort());
    expect(outcomes.every((o) => o.status === "deleted")).toBe(true);
    expect(reg.mappedNotes()).toEqual([]);
  });

  it("reports the per-note refusals the fallback hits, and keeps those mappings", async () => {
    const stuck = serverId(notePath(2));
    const { api } = fakeApi({
      serverTooOld: true,
      failSingle: new Map([[stuck, 403]]),
    });
    configFile();
    const reg = await registryWith(30, api);

    const outcomes = await reg.deletePaths(Array.from({ length: 30 }, (_, i) => notePath(i)));

    expect(outcomes.find((o) => o.path === notePath(2))?.status).toBe("failed");
    expect(reg.getMapping(notePath(2))?.docId).toBe(stuck);
  });

  it("leaves a FOLDER path on the single cascading call", async () => {
    // One folder is already one request server-side (a recursive cascade);
    // routing it through the note batch would be a regression, not a saving.
    const { api, state } = fakeApi();
    configFile();
    const reg = await registryWith(30, api, ["Archive"]);

    await reg.deletePaths(["Archive", ...Array.from({ length: 30 }, (_, i) => notePath(i))]);

    expect(state.deletedFolders).toEqual(["folder-Archive"]);
    expect(state.deleteBatches).toHaveLength(1);
    expect(state.deleteBatches[0]).toHaveLength(30);
  });
});
