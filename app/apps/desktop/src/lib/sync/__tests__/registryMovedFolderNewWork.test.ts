// A note made on this device inside a folder a teammate moved (offline, or
// before the move reached it) follows the folder to its new path. Left in the
// old directory it kept that directory alive, and the outbound half registered
// the old name again as a second folder holding just that note.

import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Set<string>();
const dirsOnDisk = new Set<string>();

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  rebindNoteId: vi.fn(async () => true),
  ensureFolder: vi.fn(async () => true),
  listBinaries: vi.fn(async () => []),
  readNote: vi.fn(async () => ""),
  noteExists: vi.fn(async (p: string) => disk.has(p)),
  renamePath: vi.fn(async (from: string, to: string) => {
    if (!disk.has(from)) throw new Error("source path does not exist");
    if (disk.has(to)) throw new Error("destination already exists");
    disk.delete(from);
    disk.add(to);
    const i = to.lastIndexOf("/");
    if (i > 0) dirsOnDisk.add(to.slice(0, i));
    return to;
  }),
  flushDeferredLinks: vi.fn(async () => false),
  deleteFolderIfEmpty: vi.fn(async (p: string) => {
    if ([...disk].some((f) => f.startsWith(p + "/"))) return false;
    dirsOnDisk.delete(p);
    return true;
  }),
  deletePath: vi.fn(async () => {}),
  listDiskDrift: vi.fn(async () => []),
  isVaultMismatch: () => false,
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
import { fullTree, reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";

function tree(paths: Iterable<string>, dirs: Iterable<string>): TreeNode {
  const root: TreeNode = { id: "root", name: "", path: "", isDir: true, children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const ensure = (p: string): TreeNode => {
    const hit = byPath.get(p);
    if (hit) return hit;
    const i = p.lastIndexOf("/");
    const parent = ensure(i === -1 ? "" : p.slice(0, i));
    const n: TreeNode = { id: p, name: p.slice(i + 1), path: p, isDir: true, children: [] };
    parent.children!.push(n);
    byPath.set(p, n);
    return n;
  };
  for (const d of dirs) ensure(d);
  for (const f of paths) {
    const i = f.lastIndexOf("/");
    ensure(i === -1 ? "" : f.slice(0, i)).children!.push({ id: f, name: f, path: f, isDir: false });
  }
  return root;
}

function fakeApi(notes: Array<{ id: string; rel_path: string }>, folders: Array<{ id: string; path: string }>) {
  return {
    listVaults: vi.fn(async () => [{ id: "v1", name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => folders),
    listFolderRegistry: vi.fn(async () => ({ folders: folders.map((f) => ({ ...f })), tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => {
      folders.push({ id: `folder-${input.path}`, path: input.path });
      return { id: `folder-${input.path}` };
    }),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes: notes.map((n) => ({ ...n })), tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: notes.map((n) => ({ ...n })), tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string; id?: string }) => {
      const row = { id: input.id ?? `note-${input.relPath}`, rel_path: input.relPath };
      notes.push(row);
      return row;
    }),
  };
}

const host = (): InboundHost => ({
  releaseDoc: async () => {},
  notePathChanged: () => {},
  noteRemoved: () => {},
  materializeContent: async () => false,
});

beforeEach(() => {
  disk.clear();
  dirsOnDisk.clear();
  vi.mocked(ipc.listTree).mockImplementation(async () => fullTree(tree(disk, dirsOnDisk)));
  vi.mocked(ipc.renamePath).mockClear();
});

async function setup() {
  const notes = [{ id: "n1", rel_path: "Old/a.md" }];
  const folders = [{ id: "f-old", path: "Old" }];
  const api = fakeApi(notes, folders);
  const reg = new VaultRegistry(api as unknown as ApiClient);
  reg.setInboundHost(host());
  disk.add("Old/a.md");
  dirsOnDisk.add("Old");
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(disk, dirsOnDisk));
  expect(reg.getMapping("Old/a.md")?.docId).toBe("n1");
  // From here the walk reads the fake disk as it is at each call.
  vi.mocked(ipc.listTree).mockImplementation(async () => fullTree(tree(disk, dirsOnDisk)));
  api.createFolder.mockClear();
  api.createNote.mockClear();
  // A teammate moves Old → New on the server.
  folders[0].path = "New";
  notes[0].rel_path = "New/a.md";
  return { api, reg };
}

describe("VaultRegistry — new work in a folder a teammate moved", () => {
  it("a note made here follows the folder and registers under the new path", async () => {
    const { api, reg } = await setup();
    disk.add("Old/mine.md"); // made on this device, never registered

    await reg.pull();
    await reg.pull();

        expect([...disk].sort()).toEqual(["New/a.md", "New/mine.md"]);
    expect(api.createNote.mock.calls.map((c) => (c[0] as { relPath: string }).relPath)).toEqual(["New/mine.md"]);
    expect(api.createFolder.mock.calls.map((c) => (c[0] as { path: string }).path)).not.toContain("Old");
    expect(reg.getFolderId("Old")).toBeNull();
  });

  it("a destination already taken keeps the note where it is (never overwritten)", async () => {
    const { reg } = await setup();
    disk.add("Old/mine.md");
    disk.add("New/mine.md"); // something already sits there

    await reg.pull();

    expect(disk.has("Old/mine.md")).toBe(true);
    expect(disk.has("New/mine.md")).toBe(true);
  });

  it("without a folder move nothing unmapped is moved", async () => {
    const notes = [{ id: "n1", rel_path: "Old/a.md" }];
    const api = fakeApi(notes, [{ id: "f-old", path: "Old" }]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    reg.setInboundHost(host());
    disk.add("Old/a.md");
    dirsOnDisk.add("Old");
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(disk, dirsOnDisk));
    disk.add("Old/mine.md");
    vi.mocked(ipc.listTree).mockImplementation(async () => fullTree(tree(disk, dirsOnDisk)));
    vi.mocked(ipc.renamePath).mockClear();

    await reg.pull();

    expect(vi.mocked(ipc.renamePath)).not.toHaveBeenCalled();
    expect(disk.has("Old/mine.md")).toBe(true);
  });
});
