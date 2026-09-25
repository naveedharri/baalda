// #221: the registry's side of reorganising a vault folder with the app open.
//
//  - a vanished vault root stops every structural pass before it reads the
//    tree (`InboundHost.confirmVaultRoot` / `structurePaused`);
//  - notes held by an unanswered bulk delete are never re-materialized
//    (`InboundHost.heldDocIds`);
//  - each pass reports the drift the closed-app notice is built from
//    (`lastPassDrift`);
//  - a folder move carries the binaries' `files` ids with it.

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
  isVaultMismatch: () => false,
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
import { fullTree, reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";

function tree(paths: string[], dirs: string[] = []): TreeNode {
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

function fakeApi(notes: Array<{ id: string; rel_path: string }>, folders: Array<{ id: string; path: string }> = []) {
  const api = {
    listVaults: vi.fn(async () => [{ id: "v1", name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => folders),
    listFolderRegistry: vi.fn(async () => ({ folders, tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes, tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes, tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string; id?: string }) => ({
      id: input.id ?? `note-${input.relPath}`,
      rel_path: input.relPath,
    })),
    updateFolder: vi.fn(async () => ({})),
  };
  return api;
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
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.listTree).mockClear();
});

describe("VaultRegistry — a vanished vault root (#221)", () => {
  it("reconcile stops before it reads the tree or asks the server anything", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "A.md" }]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    reg.setInboundHost(host({ confirmVaultRoot: async () => false }));

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree([]));

    expect(api.listVaults).not.toHaveBeenCalled();
    expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
    expect(reg.getMapping("A.md")).toBeNull();
  });

  it("a pull after the root vanished materializes nothing", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "A.md" }]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    let rootPresent = true;
    reg.setInboundHost(
      host({ confirmVaultRoot: async () => rootPresent, structurePaused: () => !rootPresent }),
    );
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["A.md"]));
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    vi.mocked(ipc.listTree).mockClear();

    rootPresent = false;
    // A walk of a dead root could come back empty: every note would read as
    // server-only and be re-created at the old location.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([])));
    expect(await reg.pull()).toBe(false);
    expect(ipc.listTree).not.toHaveBeenCalled();
    expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
  });
});

describe("VaultRegistry — notes held by an unanswered bulk delete (#221)", () => {
  it("are neither re-materialized nor forgotten until the user answers", async () => {
    const api = fakeApi([
      { id: "n1", rel_path: "A.md" },
      { id: "n2", rel_path: "B.md" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    const held = new Set<string>(["n1"]);
    reg.setInboundHost(host({ heldDocIds: () => held }));
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["A.md", "B.md"]));
    vi.mocked(ipc.writeNoteIfMissing).mockClear();

    // Both files are gone from disk; only n1 is held.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([])));
    await reg.pull();
    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0])).toEqual(["B.md"]);
    expect(reg.getMapping("A.md")?.docId).toBe("n1");

    // "Restore": the hold is gone, and the next pull puts it back.
    held.clear();
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    await reg.pull();
    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0])).toContain("A.md");
  });
});

describe("VaultRegistry.lastPassDrift (#221)", () => {
  it("counts known notes missing on disk and unknown files that appeared", async () => {
    const api = fakeApi([
      { id: "n1", rel_path: "Old/a.md" },
      { id: "n2", rel_path: "Keep.md" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["Old/a.md", "Keep.md"]));
    expect(reg.lastPassDrift()).toEqual({ missingMapped: 0, unmappedLocal: 0 });

    // Moved while closed: the known path is gone, the new one is unknown.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(["New/a.md", "Keep.md"])));
    await reg.pull();
    expect(reg.lastPassDrift()).toEqual({ missingMapped: 1, unmappedLocal: 1 });
  });

  it("a teammate's new note is not drift — this device never knew its path", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "Mine.md" }]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["Mine.md"]));
    api.listNoteRegistryPaged.mockResolvedValue({
      notes: [
        { id: "n1", rel_path: "Mine.md" },
        { id: "n9", rel_path: "Theirs.md" },
      ],
      tombstones: [],
    });
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(["Mine.md", "Local.md"])));
    await reg.pull();
    expect(reg.lastPassDrift()).toEqual({ missingMapped: 0, unmappedLocal: 1 });
  });
});

describe("VaultRegistry.renamePath — a folder (#221)", () => {
  it("moves the server folder ONCE, remaps notes and binaries, and says it did", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "Old/a.md" }], [{ id: "f-old", path: "Old" }]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["Old/a.md"], ["Old"]));
    reg.setFileId("Old/report.pdf", "file-1");

    expect(await reg.renamePath("Old", "Archive")).toBe(true);
    expect(api.updateFolder).toHaveBeenCalledTimes(1);
    expect(api.updateFolder).toHaveBeenCalledWith("f-old", { name: "Archive", path: "Archive", parentId: null });
    expect(reg.getMapping("Archive/a.md")?.docId).toBe("n1");
    expect(reg.getMapping("Old/a.md")).toBeNull();
    expect(reg.getFileId("Archive/report.pdf")).toBe("file-1");
    expect(reg.getFileId("Old/report.pdf")).toBeNull();
  });

  it("answers false when the server refuses, and changes nothing", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "Old/a.md" }], [{ id: "f-old", path: "Old" }]);
    api.updateFolder.mockRejectedValue(new Error("root_frozen"));
    const reg = new VaultRegistry(api as unknown as ApiClient);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(["Old/a.md"], ["Old"]));

    expect(await reg.renamePath("Old", "Archive")).toBe(false);
    expect(reg.getMapping("Old/a.md")?.docId).toBe("n1");
  });
});
