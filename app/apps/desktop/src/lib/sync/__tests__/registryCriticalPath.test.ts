// What a reconcile must NOT do on an ordinary relaunch.
//
// Both calls pinned here were unconditional and both were pure launch latency
// on a steady-state vault:
//
//   - `api.listNotes` downloaded all 6,282 note rows to answer one boolean
//     ("is the server empty?") that only a JUST-CREATED vault can act on — and
//     `syncStructure` fetches the same endpoint again 90 lines later, so a
//     relaunch paid for the whole note list twice.
//   - `ipc.listNoteTitles` parks on the SQLite index write lock held by the
//     background rebuild (#84), and a vault whose config already maps every
//     note (and whose server knows every note) needs none of its rows.
//
// Neither is removed — both are now asked for only when something actually
// needs the answer, which is what these tests describe.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
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
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  ensureFolder: vi.fn(async () => false),
  readNote: vi.fn(async () => ""),
  renamePath: vi.fn(async (_from: string, to: string) => to),
  writeTrashCopy: vi.fn(async () => "trash"),
  deletePath: vi.fn(async () => {}),
  noteExists: vi.fn(async () => true),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const COLLECTION = "col-1";

/** A vault tree holding exactly these note paths (all at the root). */
function treeWith(paths: string[]): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    childrenLoaded: true,
    children: paths.map((p) => ({ id: p, name: p, path: p, isDir: false })),
  } as TreeNode;
}

/** The config a fully-reconciled folder carries: identity, doc map, baseline. */
function config(docs: Record<string, string>): string {
  const baseline: Record<string, string> = {};
  for (const [rp, id] of Object.entries(docs)) baseline[id] = rp;
  return JSON.stringify({
    organizationId: ORG,
    serverVaultId: COLLECTION,
    docs,
    folders: {},
    pushed: Object.values(docs),
    baseline,
  });
}

function fakeApi(serverNotes: Array<{ id: string; rel_path: string }>) {
  const listNotes = vi.fn(async () => serverNotes);
  const api = {
    listVaults: vi.fn(async () => [
      { id: COLLECTION, name: "vault", organization_id: ORG },
    ]),
    createVault: vi.fn(async () => ({
      id: COLLECTION,
      name: "vault",
      organization_id: ORG,
    })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `f-${input.path}` })),
    listNotes,
    listNoteRegistry: vi.fn(async () => ({ notes: serverNotes, tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: `new-${input.relPath}`,
      rel_path: input.relPath,
    })),
  } as unknown as ApiClient;
  return { api, listNotes };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.listNoteTitles).mockClear().mockResolvedValue([]);
});

describe("reconcile — the server note list is only for seeding", () => {
  it("never downloads it on an ordinary relaunch", async () => {
    const { api, listNotes } = fakeApi([{ id: "n1", rel_path: "a.md" }]);
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config({ "a.md": "n1" }));
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md"]),
    );

    // `syncStructure`'s own `listNoteRegistry` is the list this pass reconciles
    // against; the seed probe adds nothing to it.
    expect(listNotes).not.toHaveBeenCalled();
  });

  it("still downloads it when a just-created vault could seed", async () => {
    // The one flow that seeds: `seedIfEmpty` from vault CREATION, into a folder
    // with nothing in it. Only then is "is the server empty too?" actionable.
    const { api, listNotes } = fakeApi([]);
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault", seedIfEmpty: true },
      treeWith([]),
    );

    expect(listNotes).toHaveBeenCalledTimes(1);
  });

  it("skips it even with seedIfEmpty when the folder already has notes", async () => {
    // Turning on sync for a folder full of files can't seed, so the question
    // never needs asking — and this is the case that scales with the vault.
    const { api, listNotes } = fakeApi([{ id: "n1", rel_path: "a.md" }]);
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config({ "a.md": "n1" }));
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault", seedIfEmpty: true },
      treeWith(["a.md"]),
    );

    expect(listNotes).not.toHaveBeenCalled();
  });
});

describe("reconcile — the index's title rows are read on demand", () => {
  it("not at all when the config maps every local note and the server has them", async () => {
    const { api } = fakeApi([
      { id: "n1", rel_path: "a.md" },
      { id: "n2", rel_path: "b.md" },
    ]);
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      config({ "a.md": "n1", "b.md": "n2" }),
    );
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "b.md"]),
    );

    expect(ipc.listNoteTitles).not.toHaveBeenCalled();
  });

  it("once when a local note is missing from the server (it needs its doc_id)", async () => {
    // `new.md` has to be CREATED server-side, and it must be created under the
    // local index's doc_id — otherwise the server mints a different one and the
    // note forks (bridge writes under the local id, sync under the server's).
    const { api } = fakeApi([{ id: "n1", rel_path: "a.md" }]);
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config({ "a.md": "n1" }));
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { path: "a.md", id: "n1", title: "A" },
      { path: "new.md", id: "local-new", title: "New" },
    ] as never);
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "new.md"]),
    );

    expect(ipc.listNoteTitles).toHaveBeenCalledTimes(1);
    expect(reg.getMapping("new.md")?.docId).toBe("new-new.md");
  });

  it("once when inbound sees an on-disk note the registry doesn't map", async () => {
    // The fallback identity map: a note whose file is here but whose doc_id this
    // registry hasn't joined yet can only be matched through the index.
    const { api } = fakeApi([
      { id: "n1", rel_path: "a.md" },
      { id: "n2", rel_path: "b.md" },
    ]);
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config({ "a.md": "n1" }));
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { path: "a.md", id: "n1", title: "A" },
      { path: "b.md", id: "n2", title: "B" },
    ] as never);
    const reg = new VaultRegistry(api);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "b.md"]),
    );

    // Once, not twice: the inbound pass and the create-missing pass share the
    // memoized read.
    expect(ipc.listNoteTitles).toHaveBeenCalledTimes(1);
  });
});
