// A rename/move the SERVER refuses has to reach the user.
//
// `VaultRegistry.renamePath` is the outbound half of an external rename: the
// watcher saw a file move on disk, `docSession.applyDiskRename` decided it was a
// rename rather than a delete, and this is what moves the server row to match.
// The server can say no on the merits — dragging something out to a frozen root
// is the everyday case — and both branches used to answer that 403 with a
// `console.error` and a bare `return`.
//
// That was invisible twice over. The directory or file has ALREADY moved on
// disk by the time this runs, so the refusal leaves the two sides disagreeing;
// and `applyDiskRename` reads the silent return as success and carries on to
// rebind the note's id and push its content. Nothing anywhere told the user why
// their note quietly reappeared in its old folder.
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
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import { ApiError, type ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";

/** The server's answer to a move that would land at a frozen root. */
function rootFrozen() {
  return new ApiError(403, "This vault's root is frozen. Create this inside a folder instead.", {
    error: "This vault's root is frozen. Create this inside a folder instead.",
    code: "root_frozen",
  });
}

/** `Docs/` holding `Docs/a.md`, plus the nested `Docs/Specs/` folder. */
function tree(): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: [
      {
        id: "docs",
        name: "Docs",
        path: "Docs",
        isDir: true,
        children: [
          { id: "specs", name: "Specs", path: "Docs/Specs", isDir: true, children: [] },
          { id: "a", name: "a.md", path: "Docs/a.md", isDir: false },
        ],
      },
    ],
  };
}

function fakeApi(refusal: () => Error) {
  const updateNote = vi.fn(async () => {
    throw refusal();
  });
  const updateFolder = vi.fn(async () => {
    throw refusal();
  });
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    // The paged twin the reconciler actually calls; identical answer.
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({
      id: `folder-${input.path}`,
      path: input.path,
    })),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: `srv-${input.relPath}`,
      rel_path: input.relPath,
      title: null,
    })),
    updateNote,
    updateFolder,
  } as unknown as ApiClient;
  return { api, updateNote, updateFolder };
}

/** A registry with `Docs`, `Docs/Specs` and `Docs/a.md` already mapped. */
async function registered(refusal: () => Error) {
  const fake = fakeApi(refusal);
  const reg = new VaultRegistry(fake.api);
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree());
  return { reg, ...fake };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
});

describe("VaultRegistry.renamePath — a refused move is reported, not swallowed", () => {
  it("reports a note the server refused to move out to a frozen root", async () => {
    const { reg, updateNote } = await registered(rootFrozen);
    expect(reg.getMapping("Docs/a.md")).toEqual({ vaultId: VAULT, docId: "srv-Docs/a.md" });

    await reg.renamePath("Docs/a.md", "a.md");

    expect(updateNote).toHaveBeenCalledWith("srv-Docs/a.md", {
      relPath: "a.md",
      folderId: null,
    });
    expect(reg.hasFailures()).toBe(true);
    // Keyed by the DESTINATION path and the note's own doc id: that is the file
    // the user is looking at, and the id the badge hangs off.
    expect(reg.failures()).toContainEqual(
      expect.objectContaining({
        kind: "note",
        path: "a.md",
        docId: "srv-Docs/a.md",
        code: "root_frozen",
      }),
    );
  });

  it("reports a folder the server refused to move out to a frozen root", async () => {
    const { reg, updateFolder } = await registered(rootFrozen);

    await reg.renamePath("Docs/Specs", "Specs");

    expect(updateFolder).toHaveBeenCalled();
    expect(reg.failures()).toContainEqual(
      expect.objectContaining({ kind: "folder", path: "Specs", code: "root_frozen" }),
    );
  });

  it("leaves the path maps on the OLD path, so the next pull can reconcile them", async () => {
    const { reg } = await registered(rootFrozen);

    await reg.renamePath("Docs/a.md", "a.md");

    // The server row never moved, so the map must not pretend it did — the
    // mapping still names the path the server knows about.
    expect(reg.getMapping("Docs/a.md")).toEqual({ vaultId: VAULT, docId: "srv-Docs/a.md" });
    expect(reg.getMapping("a.md")).toBeNull();
  });

  it("reports an ordinary failure too, with no code to explain it", async () => {
    // Not every refusal is the freeze latch. A 500 has no `code`, and the
    // failure must still be counted rather than vanishing into the console.
    const { reg } = await registered(() => new ApiError(500, "boom"));

    await reg.renamePath("Docs/a.md", "Renamed.md");

    expect(reg.failures()).toContainEqual(
      expect.objectContaining({ kind: "note", path: "Renamed.md", code: null }),
    );
  });

  it("records nothing when the move succeeds", async () => {
    const fake = fakeApi(rootFrozen);
    (fake.api as unknown as { updateNote: unknown }).updateNote = vi.fn(async () => ({}));
    const reg = new VaultRegistry(fake.api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree());

    await reg.renamePath("Docs/a.md", "Docs/b.md");

    expect(reg.hasFailures()).toBe(false);
    expect(reg.getMapping("Docs/b.md")).toEqual({ vaultId: VAULT, docId: "srv-Docs/a.md" });
    expect(reg.getMapping("Docs/a.md")).toBeNull();
  });
});

describe("VaultRegistry.renamePath — a move into a brand-new folder (#410)", () => {
  it("registers the missing folders first, then moves the note into them", async () => {
    const { reg, api, updateNote } = await registered(rootFrozen);
    updateNote.mockReset().mockResolvedValue({} as never);
    const createFolder = vi.mocked(api.createFolder);
    createFolder.mockClear();

    expect(await reg.renamePath("Docs/a.md", "Docs/done/old/a.md")).toBe(true);

    expect(createFolder.mock.calls.map(([f]) => (f as { path: string }).path)).toEqual([
      "Docs/done",
      "Docs/done/old",
    ]);
    expect(updateNote).toHaveBeenCalledWith("srv-Docs/a.md", {
      relPath: "Docs/done/old/a.md",
      folderId: "folder-Docs/done/old",
    });
    expect(reg.getMapping("Docs/done/old/a.md")?.docId).toBe("srv-Docs/a.md");
  });
});

describe("VaultRegistry.renamePath — a rename racing a teammate's folder move", () => {
  const mismatch = () =>
    new ApiError(400, '"Docs/b.md" is not inside folder "Moved"', {
      error: '"Docs/b.md" is not inside folder "Moved"',
      code: "path_folder_mismatch",
    });

  it("renames under the folder's CURRENT server path, keeping the new name", async () => {
    const { reg, api, updateNote } = await registered(mismatch);
    updateNote.mockReset().mockRejectedValueOnce(mismatch()).mockResolvedValue({} as never);
    vi.mocked(api.listFolderRegistry).mockResolvedValue({
      folders: [{ id: "folder-Docs", path: "Moved" }] as never,
      tombstones: [],
    });

    expect(await reg.renamePath("Docs/a.md", "Docs/b.md")).toBe(true);

    expect(updateNote).toHaveBeenLastCalledWith("srv-Docs/a.md", {
      relPath: "Moved/b.md",
      folderId: "folder-Docs",
    });
    expect(reg.hasFailures()).toBe(false);
    // Locally the file is still under the old directory until the pull follows
    // the folder move, so the map names where it is on THIS disk.
    expect(reg.getMapping("Docs/b.md")?.docId).toBe("srv-Docs/a.md");
  });

  it("a move to ANOTHER folder is not retried (the mismatch is about the destination)", async () => {
    const { reg, api, updateNote } = await registered(mismatch);
    updateNote.mockClear();
    vi.mocked(api.listFolderRegistry).mockClear();
    await reg.renamePath("Docs/a.md", "Docs/Specs/a.md");
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(api.listFolderRegistry).not.toHaveBeenCalled();
    expect(reg.failures()).toContainEqual(expect.objectContaining({ code: "path_folder_mismatch" }));
  });

  it("a folder that did not move is not retried either", async () => {
    const { reg, api, updateNote } = await registered(mismatch);
    updateNote.mockClear();
    vi.mocked(api.listFolderRegistry).mockResolvedValue({
      folders: [{ id: "folder-Docs", path: "Docs" }] as never,
      tombstones: [],
    });
    await reg.renamePath("Docs/a.md", "Docs/b.md");
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(reg.failures()).toContainEqual(expect.objectContaining({ code: "path_folder_mismatch" }));
  });
});
