// W3: opening a keyed vault on a device without its key never materializes,
// empties or deletes local files: the registry pauses like a missing root.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  rebindNoteId: vi.fn(async () => true),
  deleteFile: vi.fn(async () => {}),
  deletePath: vi.fn(async () => {}),
  isVaultMismatch: () => false,
  vaultSecretGet: vi.fn(),
  vaultSecretSet: vi.fn(),
  vaultSecretDelete: vi.fn(),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));
vi.mock("../../auth/authManager", () => ({ api: {} }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
import { fullTree, reconcileWithTree } from "./helpers/reconcile";
import { blocksStructure, isVaultKeyBlocked, noteVaultKeyState } from "../../vaultKeys/runtime";

const ORG = "org-1";

function tree(paths: string[]): TreeNode {
  return {
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: paths.map((p) => ({ id: p, name: p, path: p, isDir: false })),
  };
}

function fakeApi(notes: Array<{ id: string; rel_path: string }>) {
  return {
    listVaults: vi.fn(async () => [{ id: "v1", name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes, tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes, tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string; id?: string }) => ({
      id: input.id ?? `note-${input.relPath}`,
      rel_path: input.relPath,
    })),
    updateFolder: vi.fn(async () => ({})),
  };
}

function host(over: Partial<InboundHost> = {}): InboundHost {
  return {
    releaseDoc: async () => {},
    notePathChanged: () => {},
    noteRemoved: () => {},
    materializeContent: async () => false,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.writeNote).mockClear();
  vi.mocked(ipc.listTree).mockClear();
  noteVaultKeyState("v1", { state: "ready", generation: 1 });
});

describe("vault key pause", () => {
  it("only the keyed-but-unusable states block structure", () => {
    expect(blocksStructure({ state: "waiting-for-teammate" })).toBe(true);
    expect(blocksStructure({ state: "needs-account-key" })).toBe(true);
    expect(blocksStructure({ state: "key-mismatch" })).toBe(true);
    expect(blocksStructure({ state: "security-warning" })).toBe(true);
    expect(blocksStructure({ state: "ready", generation: 1 })).toBe(false);
    expect(blocksStructure({ state: "unkeyed" })).toBe(false);
    expect(blocksStructure({ state: "disabled" })).toBe(false);
  });

  it("a pull while the key is missing writes, empties and deletes nothing; it resumes after", async () => {
    const api = fakeApi([
      { id: "n1", rel_path: "A.md" },
      { id: "n2", rel_path: "B.md" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    reg.setInboundHost(host({ structurePaused: () => isVaultKeyBlocked("v1") }));
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["A.md"]));
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    vi.mocked(ipc.listTree).mockClear();

    noteVaultKeyState("v1", { state: "waiting-for-teammate" });
    expect(isVaultKeyBlocked("v1")).toBe(true);
    // Even a disk walk that comes back empty must not read as deletions.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([])));
    expect(await reg.pull()).toBe(false);
    expect(ipc.listTree).not.toHaveBeenCalled();
    expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
    expect(ipc.writeNote).not.toHaveBeenCalled();
    expect(ipc.deleteFile).not.toHaveBeenCalled();
    expect(reg.getMapping("A.md")?.docId).toBe("n1");

    noteVaultKeyState("v1", { state: "ready", generation: 1 });
    expect(isVaultKeyBlocked("v1")).toBe(false);
  });
});
