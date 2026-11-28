// #276: a folder renamed while the app was closed.
//
// The pass that opens the vault saw the recorded folder missing and the new
// one unknown. Inbound read the stale server row as "missing locally" and
// re-created the old path on disk as an empty ghost (for every member), while
// the new path registered as a second folder. Paired by positive evidence (its
// notes' text, its binaries' agreed bytes), it is ONE server folder move that
// keeps the folder id — and nothing is re-created.

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
  ensureFolder: vi.fn(async () => true),
  listBinaries: vi.fn(async () => []),
  readNote: vi.fn(async () => ""),
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

type Row = { id: string; path: string; name?: string };

/** A server whose folder move rewrites its own listing, like `PATCH /folders/:id`. */
function fakeApi(notes: Array<{ id: string; rel_path: string }>, folders: Row[]) {
  const api = {
    listVaults: vi.fn(async () => [{ id: "v1", name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => folders),
    listFolderRegistry: vi.fn(async () => ({ folders: folders.map((f) => ({ ...f })), tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes: notes.map((n) => ({ ...n })), tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: notes.map((n) => ({ ...n })), tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string; id?: string }) => ({
      id: input.id ?? `note-${input.relPath}`,
      rel_path: input.relPath,
    })),
    updateFolder: vi.fn(async (id: string, input: { path: string }) => {
      const row = folders.find((f) => f.id === id)!;
      const from = row.path;
      for (const f of folders) {
        if (f.path === from || f.path.startsWith(from + "/")) f.path = input.path + f.path.slice(from.length);
      }
      for (const n of notes) {
        if (n.rel_path.startsWith(from + "/")) n.rel_path = input.path + n.rel_path.slice(from.length);
      }
      return {};
    }),
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

const ensured = () => vi.mocked(ipc.ensureFolder).mock.calls.map((c) => c[0]);
const created = (api: ReturnType<typeof fakeApi>) =>
  api.createFolder.mock.calls.map((c) => (c[0] as { path: string }).path);

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.ensureFolder).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.rebindNoteId).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.listBinaries).mockReset().mockResolvedValue([]);
  vi.mocked(ipc.readNote).mockReset().mockResolvedValue("");
});

describe("VaultRegistry — a folder renamed while the app was closed (#276)", () => {
  /** The issue's repro: a synced folder holding two binaries, renamed in Finder. */
  async function binariesSetup() {
    const api = fakeApi([], [
      { id: "f-ex", path: "Examples" },
      { id: "f-qa", path: "Examples/qa-move" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    reg.setInboundHost(host());
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree([], ["Examples", "Examples/qa-move"]));
    reg.setFileId("Examples/qa-move/moved-1.png", "file-1");
    reg.setFileId("Examples/qa-move/moved-2.jpeg", "file-2");
    reg.setFileBase("file-1", "sha-1");
    reg.setFileBase("file-2", "sha-2");
    api.createFolder.mockClear();
    vi.mocked(ipc.ensureFolder).mockClear();
    // Quit; `mv Examples/qa-move Examples/qa-moved-folder`; reopen.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([], ["Examples", "Examples/qa-moved-folder"])));
    return { api, reg };
  }

  it("moves the server folder ONCE, keeps its id and the file ids, and re-creates no ghost", async () => {
    const { api, reg } = await binariesSetup();
    vi.mocked(ipc.listBinaries).mockResolvedValue([
      { relPath: "Examples/qa-moved-folder/moved-1.png", sha256: "sha-1", size: 1 },
      { relPath: "Examples/qa-moved-folder/moved-2.jpeg", sha256: "sha-2", size: 1 },
    ] as never);

    await reg.pull();

    expect(api.updateFolder).toHaveBeenCalledTimes(1);
    expect(api.updateFolder).toHaveBeenCalledWith("f-qa", {
      name: "qa-moved-folder",
      path: "Examples/qa-moved-folder",
      parentId: "f-ex",
    });
    expect(ensured()).not.toContain("Examples/qa-move");
    expect(created(api)).not.toContain("Examples/qa-moved-folder");
    expect(reg.getFolderId("Examples/qa-moved-folder")).toBe("f-qa");
    expect(reg.getFolderId("Examples/qa-move")).toBeNull();
    expect(reg.getFileId("Examples/qa-moved-folder/moved-1.png")).toBe("file-1");
    expect(reg.getFileId("Examples/qa-moved-folder/moved-2.jpeg")).toBe("file-2");
  });

  it("a folder moved into a NEW folder while closed is one move under that folder, registered first", async () => {
    const { api, reg } = await binariesSetup();
    // Quit; `mkdir -p Box && mv Examples/qa-move Box/`; reopen.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([], ["Examples", "Box", "Box/qa-move"])));
    vi.mocked(ipc.listBinaries).mockResolvedValue([
      { relPath: "Box/qa-move/moved-1.png", sha256: "sha-1", size: 1 },
      { relPath: "Box/qa-move/moved-2.jpeg", sha256: "sha-2", size: 1 },
    ] as never);

    await reg.pull();

    expect(created(api)).toContain("Box");
    expect(created(api)).not.toContain("Box/qa-move");
    expect(api.updateFolder).toHaveBeenCalledTimes(1);
    expect(api.updateFolder).toHaveBeenCalledWith("f-qa", { name: "qa-move", path: "Box/qa-move", parentId: "folder-Box" });
    expect(reg.getFolderId("Box/qa-move")).toBe("f-qa");
    expect(reg.getFileId("Box/qa-move/moved-1.png")).toBe("file-1");
  });

  it("a sub-folder moved OUT and its emptied parent deleted while closed is still one move", async () => {
    const { api, reg } = await binariesSetup();
    // Quit; `mv Examples/qa-move qa-move && rmdir Examples`; reopen.
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([], ["qa-move"])));
    vi.mocked(ipc.listBinaries).mockResolvedValue([
      { relPath: "qa-move/moved-1.png", sha256: "sha-1", size: 1 },
      { relPath: "qa-move/moved-2.jpeg", sha256: "sha-2", size: 1 },
    ] as never);

    await reg.pull();

    expect(api.updateFolder).toHaveBeenCalledWith("f-qa", { name: "qa-move", path: "qa-move", parentId: null });
    expect(created(api)).not.toContain("qa-move");
    expect(reg.getFolderId("qa-move")).toBe("f-qa");
    expect(reg.getFileId("qa-move/moved-2.jpeg")).toBe("file-2");
  });

  it("binaries whose bytes do not match their agreed base are no evidence: nothing moves", async () => {
    const { api, reg } = await binariesSetup();
    vi.mocked(ipc.listBinaries).mockResolvedValue([
      { relPath: "Examples/qa-moved-folder/moved-1.png", sha256: "sha-other", size: 1 },
      { relPath: "Examples/qa-moved-folder/moved-2.jpeg", sha256: "sha-2", size: 1 },
    ] as never);

    await reg.pull();

    expect(api.updateFolder).not.toHaveBeenCalled();
  });

  it("an unlistable disk gives the binaries no evidence and moves nothing", async () => {
    const { api, reg } = await binariesSetup();
    vi.mocked(ipc.listBinaries).mockRejectedValue(new Error("disk busy"));

    await reg.pull();

    expect(api.updateFolder).not.toHaveBeenCalled();
  });

  it("a folder and its sub-folder renamed together are two folder moves, parent first", async () => {
    // `mv Old/sub Old/sub2 && mv Old Archive` (a git checkout, an agent's two mvs).
    // By position alone the renamed sub-folder sank the parent below the ratio.
    const notes = [
      { id: "a1", rel_path: "Old/a1.md" },
      { id: "a2", rel_path: "Old/a2.md" },
      { id: "a3", rel_path: "Old/a3.md" },
      { id: "b1", rel_path: "Old/sub/b1.md" },
      { id: "b2", rel_path: "Old/sub/b2.md" },
    ];
    const api = fakeApi(notes, [
      { id: "f-old", path: "Old" },
      { id: "f-sub", path: "Old/sub" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    reg.setInboundHost(host({ localText: async (id) => `text ${id}` }));
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(notes.map((n) => n.rel_path), ["Old", "Old/sub"]));
    api.createFolder.mockClear();
    api.createNote.mockClear();
    const moved = (p: string) => p.replace(/^Old\/sub\//, "Archive/sub2/").replace(/^Old\//, "Archive/");
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(notes.map((n) => moved(n.rel_path)), ["Archive", "Archive/sub2"])));
    vi.mocked(ipc.readNote).mockImplementation(async (p: string) => {
      const n = notes.find((x) => moved(x.rel_path) === p);
      return n ? `text ${n.id}` : "";
    });

    await reg.pull();

    expect(api.updateFolder.mock.calls).toEqual([
      ["f-old", { name: "Archive", path: "Archive", parentId: null }],
      ["f-sub", { name: "sub2", path: "Archive/sub2", parentId: "f-old" }],
    ]);
    expect(created(api)).toEqual([]);
    expect(api.createNote).not.toHaveBeenCalled();
    expect(reg.getFolderId("Archive")).toBe("f-old");
    expect(reg.getFolderId("Archive/sub2")).toBe("f-sub");
    expect(reg.getMapping("Archive/sub2/b1.md")?.docId).toBe("b1");
    expect(reg.getMapping("Archive/a3.md")?.docId).toBe("a3");
  });

  describe("a rotation (mv B C && mv A B)", () => {
    const texts: Record<string, string> = { oa: "A overview", a1: "A one", ob: "B overview", b1: "B one" };
    async function rotationSetup(after: Record<string, string>, dirs: string[]) {
      const notes = [
        { id: "oa", rel_path: "A/overview.md" },
        { id: "a1", rel_path: "A/a1.md" },
        { id: "ob", rel_path: "B/overview.md" },
        { id: "b1", rel_path: "B/b1.md" },
      ];
      const api = fakeApi(notes, [
        { id: "f-a", path: "A" },
        { id: "f-b", path: "B" },
      ]);
      const reg = new VaultRegistry(api as unknown as ApiClient);
      reg.setInboundHost(host({ localText: async (id) => texts[id] ?? null }));
      await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(notes.map((n) => n.rel_path), ["A", "B"]));
      api.createFolder.mockClear();
      api.createNote.mockClear();
      vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(Object.keys(after), dirs)));
      vi.mocked(ipc.readNote).mockImplementation(async (p: string) => after[p] ?? "");
      return { api, reg };
    }

    it("moves B to C first, then A to B, and re-keys A's rows before B's", async () => {
      const { api, reg } = await rotationSetup(
        { "B/overview.md": "A overview", "B/a1.md": "A one", "C/overview.md": "B overview", "C/b1.md": "B one" },
        ["B", "C"],
      );

      await reg.pull();

      expect(api.updateFolder.mock.calls).toEqual([
        ["f-b", { name: "C", path: "C", parentId: null }],
        ["f-a", { name: "B", path: "B", parentId: null }],
      ]);
      expect(vi.mocked(ipc.rebindNoteId).mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ["B/overview.md", "oa"],
        ["B/a1.md", "a1"],
        ["C/overview.md", "ob"],
        ["C/b1.md", "b1"],
      ]);
      expect(created(api)).toEqual([]);
      expect(api.createNote).not.toHaveBeenCalled();
      expect(reg.getFolderId("B")).toBe("f-a");
      expect(reg.getFolderId("C")).toBe("f-b");
      expect(reg.getMapping("B/overview.md")?.docId).toBe("oa");
      expect(reg.getMapping("C/overview.md")?.docId).toBe("ob");
    });

    it("A's notes moved INTO a B that kept its own is no rotation: B keeps its id", async () => {
      // `mv A/* B/ && rmdir A` with B's own notes still at home.
      const { api, reg } = await rotationSetup(
        { "B/a1.md": "A one", "B/overview.md": "B overview", "B/b1.md": "B one", "B/A overview.md": "A overview" },
        ["B"],
      );

      await reg.pull();

      expect(api.updateFolder).not.toHaveBeenCalled();
      expect(reg.getFolderId("B")).toBe("f-b");
    });

    it("B copied to C (B still at home) is no rotation either", async () => {
      // `cp -r B C && mv A/* B/`: B's notes match under C AND still at home.
      const { api, reg } = await rotationSetup(
        {
          "B/overview.md": "B overview",
          "B/b1.md": "B one",
          "B/a1.md": "A one",
          "C/overview.md": "B overview",
          "C/b1.md": "B one",
        },
        ["B", "C"],
      );

      await reg.pull();

      expect(api.updateFolder.mock.calls.map((c) => c[0])).not.toContain("f-b");
      expect(reg.getFolderId("B")).toBe("f-b");
    });
  });

  it("pairs a folder of notes by their text and gives each index row its kept doc id", async () => {
    const api = fakeApi([{ id: "n1", rel_path: "Old/a.md" }, { id: "n2", rel_path: "Old/sub/b.md" }], [
      { id: "f-old", path: "Old" },
      { id: "f-sub", path: "Old/sub" },
    ]);
    const reg = new VaultRegistry(api as unknown as ApiClient);
    const texts: Record<string, string> = { n1: "alpha", n2: "beta" };
    reg.setInboundHost(host({ localText: async (id) => texts[id] ?? null }));
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(["Old/a.md", "Old/sub/b.md"], ["Old", "Old/sub"]),
    );
    api.createFolder.mockClear();
    api.createNote.mockClear();
    vi.mocked(ipc.ensureFolder).mockClear();
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    vi.mocked(ipc.listTree).mockResolvedValue(
      fullTree(tree(["Archive/a.md", "Archive/sub/b.md"], ["Archive", "Archive/sub"])),
    );
    vi.mocked(ipc.readNote).mockImplementation(async (p: string) =>
      p === "Archive/a.md" ? "alpha" : p === "Archive/sub/b.md" ? "beta" : "",
    );

    await reg.pull();

    expect(api.updateFolder.mock.calls).toEqual([["f-old", { name: "Archive", path: "Archive", parentId: null }]]);
    expect(vi.mocked(ipc.rebindNoteId).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["Archive/a.md", "n1"],
      ["Archive/sub/b.md", "n2"],
    ]);
    expect(reg.getMapping("Archive/a.md")?.docId).toBe("n1");
    expect(reg.getMapping("Archive/sub/b.md")?.docId).toBe("n2");
    expect(api.createNote).not.toHaveBeenCalled();
    expect(created(api)).toEqual([]);
    expect(ensured()).not.toContain("Old");
    expect(ensured()).not.toContain("Old/sub");
    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0])).not.toContain("Old/a.md");
  });

  it("a folder the SERVER moved meanwhile is the inbound step's business, not a local move", async () => {
    const { api, reg } = await binariesSetup();
    vi.mocked(ipc.listBinaries).mockResolvedValue([
      { relPath: "Examples/qa-moved-folder/moved-1.png", sha256: "sha-1", size: 1 },
      { relPath: "Examples/qa-moved-folder/moved-2.jpeg", sha256: "sha-2", size: 1 },
    ] as never);
    // A teammate moved the same folder elsewhere while this device was closed.
    api.listFolderRegistry.mockResolvedValue({
      folders: [
        { id: "f-ex", path: "Examples" },
        { id: "f-qa", path: "Elsewhere" },
      ],
      tombstones: [],
    });

    await reg.pull();

    expect(api.updateFolder).not.toHaveBeenCalled();
  });
});
