// ONE number decides whether a run takes the batch path — and it decides it the
// same way at every site, which is what this file pins.
//
// Below the threshold nothing about the app changes: the per-item routes, the
// per-note IPC and the per-doc sockets are exactly what they were. That is the
// point of a threshold rather than a flag day — the safety path and the fast
// path are both exercised on every ordinary launch, and the fast one is the
// COMMON one (every real vault is >25 notes), so it cannot rot.
//
// Four sites now: registering notes, registering folders, materializing
// server-only notes, and — since the live import fix — pushing note CONTENT from
// a running vault (see `docSessionLiveBatch.test.ts` for what that one does).

import { readFileSync } from "node:fs";
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
  rebindNoteId: vi.fn(async () => true),
  materializeNotesBatch: vi.fn(
    async (items: Array<{ relPath: string; docId: string | null }>) =>
      items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  ),
  isVaultMismatch: (e: unknown) =>
    e instanceof Error && e.message.startsWith("vault-mismatch"),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient, RegisteredNote } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { BULK_THRESHOLD_DOCS, useBulkPath } from "../pool";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";

function tree(notes: number, folders: string[] = []): TreeNode {
  const children: TreeNode[] = folders.map((path) => ({
    id: path,
    name: path.split("/").pop()!,
    path,
    isDir: true,
    children: [],
  }));
  for (let i = 0; i < notes; i++) {
    children.push({ id: `n${i}`, name: `Note${i}.md`, path: `Note${i}.md`, isDir: false });
  }
  return { id: "root", name: "vault", path: "", isDir: true, children };
}

/** A server that answers both the per-item and the batch routes, counting each. */
function fakeApi(opts: { serverNotes?: RegisteredNote[] } = {}) {
  const calls = {
    createNote: 0,
    createFolder: 0,
    batchNotes: 0,
    batchFolders: 0,
    batchNoteItems: 0,
    batchFolderItems: 0,
  };
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => opts.serverNotes ?? []),
    listNoteRegistry: vi.fn(async () => ({
      notes: opts.serverNotes ?? [],
      tombstones: [],
    })),
    // The paged twin the reconciler actually calls; identical answer.
    listNoteRegistryPaged: vi.fn(async () => ({
      notes: opts.serverNotes ?? [],
      tombstones: [],
    })),
    createFolder: vi.fn(async (input: { path: string }) => {
      calls.createFolder++;
      return { id: `folder-${input.path}`, path: input.path };
    }),
    createNote: vi.fn(async (input: { relPath: string }) => {
      calls.createNote++;
      return { id: `srv-${input.relPath}`, rel_path: input.relPath, title: null };
    }),
    batchCreateFolders: vi.fn(async (_vaultId: string, items: Array<{ path: string }>) => {
      calls.batchFolders++;
      calls.batchFolderItems += items.length;
      return items.map((i) => ({
        path: i.path,
        id: `folder-${i.path}`,
        status: "created" as const,
        code: null,
        error: null,
      }));
    }),
    batchCreateNotes: vi.fn(async (_vaultId: string, items: Array<{ relPath: string }>) => {
      calls.batchNotes++;
      calls.batchNoteItems += items.length;
      return items.map((i) => ({
        relPath: i.relPath,
        docId: `srv-${i.relPath}`,
        status: "created" as const,
        folderId: null,
        title: null,
        code: null,
        error: null,
      }));
    }),
  } as unknown as ApiClient;
  return { api, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(true);
  vi.mocked(ipc.materializeNotesBatch).mockImplementation(async (items) =>
    items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  );
});

describe("useBulkPath", () => {
  it("is the threshold and nothing else", () => {
    expect(BULK_THRESHOLD_DOCS).toBe(25);
    expect(useBulkPath(0)).toBe(false);
    expect(useBulkPath(BULK_THRESHOLD_DOCS - 1)).toBe(false);
    expect(useBulkPath(BULK_THRESHOLD_DOCS)).toBe(true);
    expect(useBulkPath(5000)).toBe(true);
  });
});

describe("site 1 — registering notes", () => {
  it("24 notes go one request each", async () => {
    const { api, calls } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(24));

    expect(calls.createNote).toBe(24);
    expect(calls.batchNotes).toBe(0);
  });

  it("25 notes go in ONE batch", async () => {
    const { api, calls } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(25));

    expect(calls.createNote).toBe(0);
    expect(calls.batchNotes).toBe(1);
    expect(calls.batchNoteItems).toBe(25);
    // …and the vault is mapped exactly as the per-item path maps it.
    expect(reg.getMapping("Note0.md")).toEqual({ vaultId: VAULT, docId: "srv-Note0.md" });
    expect(reg.mappedNotes()).toHaveLength(25);
  });

  it("chunks a big vault instead of sending one enormous request", async () => {
    const { api, calls } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(450));

    expect(calls.batchNotes).toBe(3); // 200 + 200 + 50
    expect(calls.batchNoteItems).toBe(450);
    expect(reg.mappedNotes()).toHaveLength(450);
  });
});

describe("site 2 — registering folders", () => {
  it("24 folders keep the level-by-level loop", async () => {
    const folders = Array.from({ length: 24 }, (_, i) => `F${i}`);
    const { api, calls } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0, folders));

    expect(calls.createFolder).toBe(24);
    expect(calls.batchFolders).toBe(0);
  });

  it("25 folders go in ONE batch, with no parentId to resolve", async () => {
    const folders = Array.from({ length: 25 }, (_, i) => `F${i}`);
    const { api, calls } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0, folders));

    expect(calls.createFolder).toBe(0);
    expect(calls.batchFolders).toBe(1);
    expect(calls.batchFolderItems).toBe(25);
    expect(reg.getFolderId("F7")).toBe("folder-F7");
  });
});

describe("site 4 — pushing note CONTENT", () => {
  // What a content push DOES above and below the threshold is pinned where the
  // routing lives (`docSessionLiveBatch.test.ts`, `bulkEngine.test.ts`). What
  // belongs here is the thing this file is about: that every site asks the SAME
  // question, so the threshold cannot drift into a per-site constant.
  //
  // A source assertion, deliberately: the two live sites are ordinary private
  // methods with no seam of their own, and a site that quietly stopped
  // consulting `useBulkPath` would take the slow path forever while every
  // behavioural test that mocks its way past it still passed. This is the same
  // shape as `formatsLockstep.test.ts` — cheap, and it cannot rot in silence.
  const source = readFileSync(new URL("../docSession.ts", import.meta.url), "utf8");

  /** The body of one `private async <name>(…)` method, up to the next member. */
  function methodBody(name: string): string {
    const start = source.indexOf(`private async ${name}(`);
    expect(start, `${name} is gone — has it been renamed?`).toBeGreaterThan(-1);
    const end = source.indexOf("\n  private ", start + 1);
    return source.slice(start, end === -1 ? source.length : end);
  }

  it("the steady-state content run gates on the same threshold", () => {
    expect(methodBody("runBulkSync")).toContain("useBulkPath(");
  });

  it("…and so does the local-change drain", () => {
    expect(methodBody("runLocalChangePush")).toContain("useBulkPath(");
  });

  it("…and `enable`'s own bulk engine, which had it first", () => {
    expect(source).toContain("useBulkPath(this.registry.mappedNotes().length)");
  });
});

describe("site 3 — materializing server-only notes", () => {
  const serverOnly = (n: number): RegisteredNote[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `srv-${i}`,
      rel_path: `Remote${i}.md`,
      title: null,
    })) as RegisteredNote[];

  it("24 server-only notes stay on the per-note IPC", async () => {
    const { api } = fakeApi({ serverNotes: serverOnly(24) });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0));

    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls).toHaveLength(24);
    expect(vi.mocked(ipc.materializeNotesBatch)).not.toHaveBeenCalled();
  });

  it("25 go through ONE materialize_notes_batch — create-only, one echo each", async () => {
    const { api } = fakeApi({ serverNotes: serverOnly(25) });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0));

    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.rebindNoteId)).not.toHaveBeenCalled(); // folded into the batch
    const calls = vi.mocked(ipc.materializeNotesBatch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toHaveLength(25);
    // Every item carries the SERVER's doc id, which is what the batch binds.
    expect(calls[0][0][0]).toEqual({ relPath: "Remote0.md", docId: "srv-0" });
    // One owed watcher echo per created path, and only one.
    expect(reg.consumeMaterialized("Remote3.md")).toBe(true);
    expect(reg.consumeMaterialized("Remote3.md")).toBe(false);
  });
});
