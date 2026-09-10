// `primeLocal` — adopting this folder's own doc-id map with no round trip, so a
// note that is already mapped can open with a provider while the structural
// reconcile is still running.
//
// It is provisional by construction (the collection id comes from disk), so the
// tests below pin BOTH halves: what it adopts, and the three ways it must refuse
// — no stamp, a foreign stamp, no collection id. Priming a config this account
// does not own is the cross-vault merge every guard in registry.ts exists to
// stop, and it must stay impossible.

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
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  ensureFolder: vi.fn(async () => false),
  readNote: vi.fn(async () => ""),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const COLLECTION = "col-1";

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

/** The config a reconciled folder carries on disk. */
function config(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    organizationId: ORG,
    serverVaultId: COLLECTION,
    docs: { "a.md": "n1", "Sub/b.md": "n2" },
    folders: { Sub: "f1" },
    pushed: ["n1"],
    baseline: { n1: "a.md", n2: "Sub/b.md" },
    ...over,
  });
}

function fakeApi(collectionId = COLLECTION) {
  const notes = [
    { id: "n1", rel_path: "a.md" },
    { id: "n2", rel_path: "Sub/b.md" },
  ];
  const api = {
    listVaults: vi.fn(async () => [
      { id: collectionId, name: "vault", organization_id: ORG },
    ]),
    createVault: vi.fn(async () => ({
      id: collectionId,
      name: "vault",
      organization_id: ORG,
    })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({
      folders: [{ id: "f1", path: "Sub" }],
      tombstones: [],
    })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `f-${input.path}` })),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes, tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: `new-${input.relPath}`,
      rel_path: input.relPath,
    })),
  } as unknown as ApiClient;
  return api;
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockClear().mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockClear();
  vi.mocked(ipc.listNoteTitles).mockClear().mockResolvedValue([]);
});

describe("VaultRegistry.primeLocal", () => {
  it("adopts the doc map, folder ids and pushed set with no server call", async () => {
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config());
    const reg = new VaultRegistry(api);

    expect(await reg.primeLocal(ORG)).toBe(true);

    expect(reg.getMapping("a.md")).toEqual({ vaultId: COLLECTION, docId: "n1" });
    expect(reg.getFolderId("Sub")).toBe("f1");
    expect(reg.isPushed("n1")).toBe(true);
    expect(reg.vaultId).toBe(COLLECTION);
    // The whole point: no round trip. Not the collection list, not the note
    // list, not the folder registry.
    expect(api.listVaults).not.toHaveBeenCalled();
    expect(api.listNotes).not.toHaveBeenCalled();
    expect(api.listFolderRegistry).not.toHaveBeenCalled();
  });

  it("refuses a legacy config with no organizationId stamp", async () => {
    // A pre-stamp config proves nothing about WHOSE folder this is, and the
    // whole safety of priming rests on that proof. The reconcile still adopts
    // it a moment later, through the collection ids the server confirms.
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      config({ organizationId: undefined }),
    );
    const reg = new VaultRegistry(api);

    expect(await reg.primeLocal(ORG)).toBe(false);
    expect(reg.getMapping("a.md")).toBeNull();
  });

  it("refuses a config stamped for a different vault", async () => {
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      config({ organizationId: OTHER_ORG }),
    );
    const reg = new VaultRegistry(api);

    expect(await reg.primeLocal(ORG)).toBe(false);
    expect(reg.getMapping("a.md")).toBeNull();
    expect(reg.vaultId).toBeNull();
  });

  it("refuses a config with no collection id", async () => {
    // Nothing to key a mapping against — a provider needs the collection id as
    // much as the doc id.
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      config({ serverVaultId: undefined }),
    );
    const reg = new VaultRegistry(api);

    expect(await reg.primeLocal(ORG)).toBe(false);
    expect(reg.getMapping("a.md")).toBeNull();
  });
});

describe("VaultRegistry.primeLocal → reconcile handover", () => {
  it("reads config.json exactly once across both", async () => {
    // Three full reads of a 1.85 MB file per boot was the old cost. The prime
    // hands its parse to the reconcile rather than paying again.
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config());
    const reg = new VaultRegistry(api);

    await reg.primeLocal(ORG);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "Sub/b.md"]),
    );

    expect(ipc.getVaultConfig).toHaveBeenCalledTimes(1);
  });

  it("drops provisionally primed mappings when the collection turns out different", async () => {
    // The primed collection id came from disk. If the server resolves another
    // one (the config is stale, or the collection left the vault), the
    // different-collection prune in `syncStructure` must still fire.
    const api = fakeApi("col-other");
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config());
    const reg = new VaultRegistry(api);

    await reg.primeLocal(ORG);
    expect(reg.getMapping("a.md")?.vaultId).toBe(COLLECTION);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "Sub/b.md"]),
    );

    // Re-adopted under the collection the SERVER named, never left keyed to the
    // one the config guessed.
    expect(reg.getMapping("a.md")?.vaultId).toBe("col-other");
  });

  it("keeps the checkpointer across the handover, so a push recorded in the window persists", async () => {
    // `markPushed` during the prime window is a real fact about the server. An
    // unconditional `newCheckpointer()` in `reconcile` disposes the pending
    // flush that holds it, which loses it silently.
    const api = fakeApi();
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(config());
    const reg = new VaultRegistry(api);

    await reg.primeLocal(ORG);
    reg.markPushed("n2"); // a note opened + confirmed during the window

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "vault" },
      treeWith(["a.md", "Sub/b.md"]),
    );
    await reg.flushCheckpoint();

    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    expect(writes.length).toBeGreaterThan(0);
    const last = JSON.parse(writes[writes.length - 1][0] as string) as {
      pushed: string[];
    };
    expect(last.pushed).toContain("n2");
  });
});
