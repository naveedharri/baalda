// "Last edited by" reaches the UI on the registry pull, not on a channel of its
// own (the server already re-triggers that pull when it stamps an edit). These
// tests pin the two halves of that: the registry publishes a docId-keyed map
// from the note rows it just fetched, and it publishes the FINAL list.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
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
}));
vi.mock("../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient, NoteLastEdited, RegisteredNote } from "../api";
import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";
import { VaultRegistry } from "../sync/registry";

const ORG = "org-1";
const VAULT = { id: "vault-1", name: "V", organization_id: ORG };

const AT = "2026-08-11T10:00:00.000Z";

function fakeApi(notes: RegisteredNote[]) {
  return {
    listVaults: vi.fn(async () => [VAULT]),
    createVault: vi.fn(async () => VAULT),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes, tombstones: [] as string[] })),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: `note-${input.relPath}`,
      rel_path: input.relPath,
    })),
  } as unknown as ApiClient;
}

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [], childrenLoaded: true };
}

beforeEach(() => {
  vi.mocked(ipc.listTree).mockResolvedValue(emptyTree());
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
});

describe("VaultRegistry — note last-edit metadata", () => {
  it("publishes a docId-keyed map from the pulled note rows", async () => {
    const api = fakeApi([
      {
        id: "doc-a",
        title: "A",
        rel_path: "A.md",
        last_edited_by: "u1",
        last_edited_by_name: "Ada",
        last_edited_at: AT,
      },
    ]);
    const reg = new VaultRegistry(api);
    const seen: Array<Record<string, NoteLastEdited>> = [];
    reg.setNoteMetaListener((meta) => seen.push(meta));

    await reg.reconcile({ organizationId: ORG, vaultName: "V" });

    expect(seen).toHaveLength(1);
    // Keyed by doc_id — never by path, which renames and collides across vaults.
    expect(seen[0]).toEqual({ "doc-a": { userId: "u1", name: "Ada", at: AT } });
  });

  it("omits notes the server has no stamp for, rather than inventing one", async () => {
    const api = fakeApi([
      { id: "doc-a", title: "A", rel_path: "A.md", last_edited_at: AT },
      { id: "doc-b", title: "B", rel_path: "B.md" },
    ]);
    const reg = new VaultRegistry(api);
    let meta: Record<string, NoteLastEdited> = {};
    reg.setNoteMetaListener((m) => {
      meta = m;
    });

    await reg.reconcile({ organizationId: ORG, vaultName: "V" });

    expect(Object.keys(meta)).toEqual(["doc-a"]);
    expect(meta["doc-a"].name).toBeNull();
  });

  it("re-publishes on every pull, so an edit converges on the existing round trip", async () => {
    const notes: RegisteredNote[] = [{ id: "doc-a", title: "A", rel_path: "A.md" }];
    const api = fakeApi(notes);
    const reg = new VaultRegistry(api);
    const seen: Array<Record<string, NoteLastEdited>> = [];
    reg.setNoteMetaListener((meta) => seen.push(meta));

    await reg.reconcile({ organizationId: ORG, vaultName: "V" });
    expect(seen[0]).toEqual({});

    // A teammate edits the note; the server stamps it and pings `registry`.
    notes[0].last_edited_by = "u2";
    notes[0].last_edited_by_name = "Grace";
    notes[0].last_edited_at = AT;
    await reg.pull();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ "doc-a": { userId: "u2", name: "Grace", at: AT } });
  });

  it("survives having no listener at all (unit tests, teardown)", async () => {
    const reg = new VaultRegistry(fakeApi([{ id: "doc-a", title: "A", rel_path: "A.md" }]));
    await expect(reg.reconcile({ organizationId: ORG, vaultName: "V" })).resolves.toBeDefined();
  });
});
