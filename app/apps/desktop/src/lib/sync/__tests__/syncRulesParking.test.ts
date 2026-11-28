// The vault's sync rules (#401): a rule PARKS what it hides. Adding one never
// deletes, revokes, registers or materializes anything; removing it returns the
// same doc_ids; a teammate's move into a hidden folder is followed, then parked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(),
  setVaultConfig: vi.fn(),
  listTree: vi.fn(),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(),
  writeNote: vi.fn(),
  writeNoteIfMissing: vi.fn(),
  readNote: vi.fn(),
  ensureFolder: vi.fn(),
  renamePath: vi.fn(),
  trashNote: vi.fn(),
  deletePath: vi.fn(),
  deleteFile: vi.fn(),
  deleteFilesBatch: vi.fn(),
  deleteFolderIfEmpty: vi.fn(),
  fileStat: vi.fn(),
  binaryExists: vi.fn(),
  getDiskBase: vi.fn(),
  copyToTrash: vi.fn(),
  writeTrashCopy: vi.fn(),
  rebindNoteId: vi.fn(async () => true),
  isVaultMismatch: vi.fn(() => false),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
import { sha256Hex } from "../../bridge/adapter";
import { NO_RULES, SyncRuleSet } from "../../syncRules/match";

const ORG = "org-1";
const VAULT = "vault-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null as never);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined as never);
  vi.mocked(ipc.isVaultMismatch).mockReturnValue(false);
  vi.mocked(ipc.rebindNoteId).mockResolvedValue(true as never);
});
afterEach(() => vi.restoreAllMocks());

class FakeDisk {
  /** relPath → docId, for the notes the local index knows. */
  notes = new Map<string, string>();
  folders = new Set<string>();
  /** relPath → body, for the emptiness check on unconfirmed notes. */
  bodies = new Map<string, string>();
  trashed: Array<{ from: string; to: string }> = [];
  /** Paths removed outright (revocations) — never in the trash. */
  deleted: string[] = [];
  /** Tree binaries on disk (a `.pdf`, a `.docx`). NOT notes: they have no index
   *  row, no CRDT and no `GET /api/notes` entry — their only identity here is
   *  the registry's `files` map. */
  binaries = new Set<string>();
  /** docIds whose file moved on since the last agreed disk base: UNSEEN WORK
   *  (offline reconciliation). Everything else is in sync with its base. */
  unseen = new Set<string>();
  /** Recovery copies made before an inbound removal. */
  copies: Array<{ from: string; to: string }> = [];

  /** What Rust hides (its installed rules). */
  rules: SyncRuleSet = NO_RULES;
  private visible(p: string, dir: boolean) {
    return !this.rules.excludes(p, dir);
  }

  tree(): TreeNode {
    const dirs = [...this.folders].filter((f) => this.visible(f, true)).map((f) => ({
      id: f,
      name: f,
      path: f,
      isDir: true,
      children: [],
      childrenLoaded: true,
    }));
    const files = [...this.notes.keys()].filter((p) => this.visible(p, false)).map((p) => ({
      id: p,
      name: p,
      path: p,
      isDir: false,
    }));
    return {
      id: "root",
      name: "vault",
      path: "",
      isDir: true,
      childrenLoaded: true,
      children: [...dirs, ...files],
    };
  }

  titles() {
    return [...this.notes]
      .filter(([path]) => this.visible(path, false))
      .map(([path, id]) => ({ path, id, title: null }));
  }
}

function install(disk: FakeDisk) {
  vi.mocked(ipc.binaryExists).mockImplementation(async (path) => disk.binaries.has(path));
  vi.mocked(ipc.deleteFilesBatch).mockImplementation(async (items) => Promise.all(items.map(async (item) => {
    try {
      await ipc.deleteFile(item.path);
      return { path: item.path, error: null };
    } catch (e) {
      return { path: item.path, error: String(e) };
    }
  })));

  vi.mocked(ipc.listTree).mockImplementation((async () => disk.tree()) as never);
  vi.mocked(ipc.listNoteTitles).mockImplementation((async () => disk.titles()) as never);
  vi.mocked(ipc.readNote).mockImplementation((async (p: string) =>
    disk.bodies.get(p) ?? "") as never);
  vi.mocked(ipc.ensureFolder).mockImplementation((async (p: string) => {
    if (disk.folders.has(p)) return false; // already there — not a disk change
    disk.folders.add(p);
    return true;
  }) as never);
  vi.mocked(ipc.writeNoteIfMissing).mockImplementation((async (p: string) => {
    if (disk.notes.has(p)) return false;
    disk.notes.set(p, `local-${p}`);
    return true;
  }) as never);
  vi.mocked(ipc.renamePath).mockImplementation((async (
    from: string,
    to: string,
    _epoch?: unknown,
    opts?: { allowExcludedTarget?: boolean },
  ) => {
    if (disk.rules.excludes(to, false) && !opts?.allowExcludedTarget) {
      throw new Error("This path is excluded by the vault's sync rules.");
    }
    const docId = disk.notes.get(from);
    if (docId === undefined) throw new Error("source path does not exist");
    if (disk.notes.has(to)) throw new Error("destination already exists");
    disk.notes.delete(from);
    disk.notes.set(to, docId);
    const body = disk.bodies.get(from);
    if (body !== undefined) {
      disk.bodies.delete(from);
      disk.bodies.set(to, body);
    }
    return to;
  }) as never);
  vi.mocked(ipc.deleteFolderIfEmpty).mockImplementation((async (p: string) => {
    if (!disk.folders.has(p)) return false; // already gone — nothing removed
    const prefix = p + "/";
    const occupied =
      [...disk.notes.keys()].some((n) => n.startsWith(prefix)) ||
      [...disk.folders].some((f) => f.startsWith(prefix));
    if (occupied) return false;
    disk.folders.delete(p);
    return true;
  }) as never);
  vi.mocked(ipc.deletePath).mockImplementation((async (p: string) => {
    if (!disk.notes.has(p)) throw new Error("path does not exist");
    disk.notes.delete(p);
    disk.bodies.delete(p);
    disk.deleted.push(p);
  }) as never);
  // The revocation removal's own call: single file, never a directory (Rust
  // refuses one). Same book-keeping so the assertions below read the same.
  // Matches `notefile.rs delete_file`, which returns Ok for a path that is
  // already gone. A mock that threw instead would make the reconciler look
  // broken on the one case Rust deliberately makes idempotent.
  vi.mocked(ipc.deleteFile).mockImplementation((async (p: string) => {
    if (disk.binaries.delete(p)) {
      disk.deleted.push(p);
      return;
    }
    if (!disk.notes.has(p)) return;
    disk.notes.delete(p);
    disk.bodies.delete(p);
    disk.deleted.push(p);
  }) as never);
  vi.mocked(ipc.fileStat).mockImplementation((async (p: string) => {
    if (!disk.notes.has(p) && !disk.binaries.has(p)) throw new Error("no such file");
    return { size: 1 };
  }) as never);
  vi.mocked(ipc.getDiskBase).mockImplementation((async (docId: string) => {
    if (disk.unseen.has(docId)) return "base-before-the-offline-edit";
    const path = [...disk.notes].find(([, id]) => id === docId)?.[0];
    return path === undefined ? null : sha256Hex(disk.bodies.get(path) ?? "");
  }) as never);
  vi.mocked(ipc.copyToTrash).mockImplementation((async (p: string, stamp: string) => {
    if (!disk.notes.has(p) && !disk.binaries.has(p)) throw new Error("path does not exist");
    const dest = `.context/trash/${stamp}/${p}`;
    disk.copies.push({ from: p, to: dest });
    return dest;
  }) as never);
  vi.mocked(ipc.trashNote).mockImplementation((async (p: string, stamp: string) => {
    // `trash_note` is a rename, so it moves any bytes — a binary needs no twin.
    const isBinary = disk.binaries.delete(p);
    if (!isBinary) {
      if (!disk.notes.has(p)) throw new Error("path does not exist");
      disk.notes.delete(p);
      disk.bodies.delete(p);
    }
    const dest = `.context/trash/${stamp}/${p}`;
    disk.trashed.push({ from: p, to: dest });
    return dest;
  }) as never);
}


function fakeApi(state: { notes: Array<{ id: string; rel_path: string }> }) {
  const list = async () => ({ notes: state.notes, tombstones: [] });
  return {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (i: { path: string }) => ({ id: `folder-${i.path}`, path: i.path })),
    listNotes: vi.fn(async () => state.notes),
    listNoteRegistry: vi.fn(list),
    listNoteRegistryPaged: vi.fn(list),
    createNote: vi.fn(async (i: { relPath: string; docId?: string }) => ({
      id: i.docId ?? `note-${i.relPath}`,
      rel_path: i.relPath,
    })),
  } as unknown as ApiClient;
}

function host(): InboundHost {
  return {
    releaseDoc: async () => {},
    notePathChanged: () => {},
    noteRemoved: () => {},
    materializeContent: async () => false,
    revocationAuthority: () => false,
    authoritativeRevoked: () => null,
    revocationRefused: () => {},
    localUserId: () => "user-me",
    suppressBinaryDelete: () => {},
    fileRemoved: () => {},
  } as InboundHost;
}


const CODE = "projects/app/code";
const RULE = new SyncRuleSet("code/\n");

function lastRawConfig() {
  const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
  return writes[writes.length - 1]?.[0];
}
function lastConfig(): Record<string, unknown> {
  const raw = lastRawConfig() as unknown;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

/** A vault synced once with no rules: context.md beside a code/ checkout. */
async function syncedVault() {
  const disk = new FakeDisk();
  disk.folders.add("projects");
  disk.folders.add("projects/app");
  disk.folders.add(CODE);
  disk.notes.set("projects/app/context.md", "d1");
  disk.notes.set(`${CODE}/README.md`, "d2");
  disk.bodies.set(`${CODE}/README.md`, "# code");
  install(disk);
  const state = {
    notes: [
      { id: "d1", rel_path: "projects/app/context.md" },
      { id: "d2", rel_path: `${CODE}/README.md` },
    ],
  };
  const api = fakeApi(state);
  vi.mocked(api.listFolderRegistry).mockResolvedValue({
    folders: [
      { id: "f-p", path: "projects", name: "projects", parent_id: null },
      { id: "f-a", path: "projects/app", name: "app", parent_id: "f-p" },
      { id: "f-c", path: CODE, name: "code", parent_id: "f-a" },
    ],
    tombstones: [],
  } as never);
  const first = new VaultRegistry(api);
  first.setInboundHost(host());
  await first.reconcile({ organizationId: ORG, vaultName: "v" });
  // Relaunch from what the first run wrote.
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(lastRawConfig() as never);
  const reg = new VaultRegistry(api);
  const parkedSeen: string[] = [];
  const returned: string[] = [];
  reg.setInboundHost({
    ...host(),
    noteParked: (docId: string) => parkedSeen.push(docId),
    parkedReturned: (docId: string) => returned.push(docId),
  } as InboundHost);
  await reg.reconcile({ organizationId: ORG, vaultName: "v" });
  vi.mocked(api.createNote).mockClear();
  vi.mocked(api.createFolder).mockClear();
  vi.mocked(ipc.writeNoteIfMissing).mockClear();
  return { disk, state, api, reg, parkedSeen, returned };
}

/** What docSession.applySyncRules does: TS parks first, then Rust hides, then a pull. */
async function applyRules(ctx: Awaited<ReturnType<typeof syncedVault>>, rules: SyncRuleSet) {
  ctx.reg.setSyncRules(rules);
  ctx.reg.parkExcluded();
  ctx.disk.rules = rules;
  await ctx.reg.pull();
  await ctx.reg.pull();
}

function destructiveCalls(api: ApiClient) {
  const a = api as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>;
  return {
    deleteFile: vi.mocked(ipc.deleteFile).mock.calls.length,
    deletePath: vi.mocked(ipc.deletePath).mock.calls.length,
    deleteBatch: vi.mocked(ipc.deleteFilesBatch).mock.calls.length,
    trash: vi.mocked(ipc.trashNote).mock.calls.length,
    createNote: vi.mocked(api.createNote).mock.calls.length,
    createFolder: vi.mocked(api.createFolder).mock.calls.length,
    materialize: vi.mocked(ipc.writeNoteIfMissing).mock.calls.length,
    deleteNote: a.deleteNote?.mock?.calls.length ?? 0,
  };
}

describe("sync rules park, never delete (#401)", () => {
  it("adding a rule sends nothing to the server and removes nothing from disk", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);

    expect(destructiveCalls(ctx.api)).toEqual({
      deleteFile: 0, deletePath: 0, deleteBatch: 0, trash: 0,
      createNote: 0, createFolder: 0, materialize: 0, deleteNote: 0,
    });
    expect(ctx.disk.notes.get(`${CODE}/README.md`)).toBe("d2");
    expect(ctx.reg.isParked("d2")).toBe(true);
    expect(ctx.reg.pathForDocId("d2")).toBeNull();
    expect(ctx.reg.getMapping("projects/app/context.md")?.docId).toBe("d1");
    expect(ctx.reg.failures()).toEqual([]);
    expect(ctx.parkedSeen).toEqual(["d2"]);
    const cfg = lastConfig();
    expect((cfg.baseline as Record<string, string>).d2).toBeUndefined();
    expect((cfg.parked as { docs: Record<string, string> }).docs).toEqual({ d2: `${CODE}/README.md` });
  });

  it("a hidden note keeps its local history through the CRDT sweep", async () => {
    // The sweep keeps only what it is told is live. A hidden note has no index
    // row, so it must be on this list, or its history and disk base go and the
    // server's text is later written over what was typed into it meanwhile.
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    expect(ctx.reg.allDocIds()).not.toContain("d2");
    expect(ctx.reg.crdtKeepIds()).toEqual(expect.arrayContaining(["d1", "d2"]));
  });

  it("switching dot folders off again parks what synced under them", () => {
    const reg = new VaultRegistry({} as ApiClient);
    reg.setSyncRules(new SyncRuleSet("", undefined, { hidden: true, build: false }));
    expect(reg.isExcludedPath(".github/ci.yml")).toBe(false);
    expect(reg.isExcludedPath("app/node_modules/x/index.json")).toBe(true);
    reg.setSyncRules(NO_RULES);
    expect(reg.isExcludedPath(".github/ci.yml")).toBe(true);
    expect(reg.isExcludedPath("notes/plan.md")).toBe(false);
  });

  it("a teammate deleting a hidden note leaves this disk alone", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    ctx.state.notes = ctx.state.notes.filter((n) => n.id !== "d2");
    vi.mocked(ctx.api.listNoteRegistryPaged).mockResolvedValue({ notes: ctx.state.notes, tombstones: ["d2"] } as never);
    await ctx.reg.pull();
    expect(ctx.disk.notes.has(`${CODE}/README.md`)).toBe(true);
    expect(ctx.disk.deleted).toEqual([]);
  });

  it("No access removes a rule-hidden team note once the server confirms it", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    // Access ended: the listing drops d2, the change is fresh, and the
    // server's resolver answers `none` for it.
    ctx.reg.setInboundHost({ ...host(), revocationAuthority: () => true } as InboundHost);
    const accessCheck = vi.fn(async (_v: string, ids: string[]) => ids.filter((id) => id === "d2"));
    (ctx.api as unknown as { accessCheck: typeof accessCheck }).accessCheck = accessCheck;
    ctx.state.notes = ctx.state.notes.filter((n) => n.id !== "d2");
    await ctx.reg.pull();

    expect(accessCheck).toHaveBeenCalledWith(VAULT, ["d2"]);
    expect(ipc.deleteFilesBatch).toHaveBeenCalledWith(
      [{ path: `${CODE}/README.md`, docId: "d2" }],
      null,
      { allowExcluded: true },
    );
    expect(ctx.disk.notes.has(`${CODE}/README.md`)).toBe(false);
    // The hidden folder it emptied goes too; the folder holding a visible note stays.
    expect(ipc.deleteFolderIfEmpty).toHaveBeenCalledWith(CODE, null, { allowExcluded: true });
    expect(ctx.disk.folders.has(CODE)).toBe(false);
    expect(ctx.disk.folders.has("projects/app")).toBe(true);
    expect(ctx.reg.isParked("d2")).toBe(false);
    expect(lastConfig().parked).toBeUndefined();
    // The visible note is untouched.
    expect(ctx.disk.notes.get("projects/app/context.md")).toBe("d1");
  });

  it("keeps a rule-hidden note when access comes back within the settle window", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    ctx.reg.setInboundHost({ ...host(), revocationAuthority: () => true } as InboundHost);
    ctx.state.notes = ctx.state.notes.filter((n) => n.id !== "d2");
    let calls = 0;
    (ctx.api as unknown as { accessCheck: (v: string, ids: string[]) => Promise<string[]> }).accessCheck =
      vi.fn(async (_v: string, ids: string[]) => (++calls === 1 ? ids : []));
    await ctx.reg.pull();

    expect(calls).toBe(2);
    expect(ipc.deleteFilesBatch).not.toHaveBeenCalled();
    expect(ctx.disk.notes.has(`${CODE}/README.md`)).toBe(true);
    expect(ctx.reg.isParked("d2")).toBe(true);
  });

  it("keeps a rule-hidden note when the access check fails or says it is readable", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    ctx.reg.setInboundHost({ ...host(), revocationAuthority: () => true } as InboundHost);
    ctx.state.notes = ctx.state.notes.filter((n) => n.id !== "d2");
    const api = ctx.api as unknown as { accessCheck: (v: string, ids: string[]) => Promise<string[]> };
    api.accessCheck = vi.fn(async () => {
      throw new Error("offline");
    });
    await ctx.reg.pull();
    api.accessCheck = vi.fn(async () => []);
    await ctx.reg.pull();

    expect(ipc.deleteFilesBatch).not.toHaveBeenCalled();
    expect(ctx.disk.notes.has(`${CODE}/README.md`)).toBe(true);
    expect(ctx.reg.isParked("d2")).toBe(true);
  });

  it("removing the rule returns the same doc_id and touches no bytes", async () => {
    const ctx = await syncedVault();
    await applyRules(ctx, RULE);
    vi.mocked(ipc.renamePath).mockClear();
    await applyRules(ctx, NO_RULES);

    expect(ipc.rebindNoteId).toHaveBeenCalledWith(`${CODE}/README.md`, "d2", null);
    expect(ctx.reg.getMapping(`${CODE}/README.md`)?.docId).toBe("d2");
    expect(ctx.reg.isParked("d2")).toBe(false);
    expect(ctx.returned).toEqual(["d2"]);
    expect(ipc.renamePath).not.toHaveBeenCalled();
    expect(destructiveCalls(ctx.api).createNote).toBe(0);
    expect(destructiveCalls(ctx.api).materialize).toBe(0);
    expect(ctx.disk.bodies.get(`${CODE}/README.md`)).toBe("# code");
    expect(lastConfig().parked).toBeUndefined();
  });

  it("a teammate's move into a hidden folder is followed, then parked — no duplicate", async () => {
    const ctx = await syncedVault();
    ctx.reg.setSyncRules(RULE);
    ctx.reg.parkExcluded();
    ctx.disk.rules = RULE;
    ctx.state.notes = [
      { id: "d1", rel_path: `${CODE}/context.md` },
      { id: "d2", rel_path: `${CODE}/README.md` },
    ];
    await ctx.reg.pull();
    await ctx.reg.pull();

    expect(ipc.renamePath).toHaveBeenCalledWith(
      "projects/app/context.md",
      `${CODE}/context.md`,
      null,
      { allowExcludedTarget: true },
    );
    expect(ctx.disk.notes.get(`${CODE}/context.md`)).toBe("d1");
    expect(ctx.reg.isParked("d1")).toBe(true);
    expect(destructiveCalls(ctx.api)).toMatchObject({ createNote: 0, materialize: 0, deleteFile: 0, deletePath: 0 });
  });

  it("a device that never had the hidden notes never downloads them", async () => {
    const disk = new FakeDisk();
    disk.rules = RULE;
    install(disk);
    const api = fakeApi({
      notes: [
        { id: "d1", rel_path: "projects/app/context.md" },
        { id: "d2", rel_path: `${CODE}/README.md` },
      ],
    });
    const reg = new VaultRegistry(api);
    reg.setSyncRules(RULE);
    reg.setInboundHost(host());
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });
    const written = vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0]);
    expect(written).not.toContain(`${CODE}/README.md`);
    expect(reg.pathForDocId("d2")).toBeNull();
  });

  it("changeRules parks before installing, and puts the old rules back if Rust refuses", async () => {
    const ctx = await syncedVault();
    const seen: boolean[] = [];
    await expect(
      ctx.reg.changeRules(RULE, async () => {
        // Rust is asked only after TS already parked what it hides.
        seen.push(ctx.reg.isParked("d2"));
        throw new Error("rust said no");
      }),
    ).rejects.toThrow("rust said no");
    expect(seen).toEqual([true]);
    expect(ctx.reg.syncRules().source).toBe("");
    await ctx.reg.changeRules(RULE, async () => {
      ctx.disk.rules = RULE;
    });
    expect(ctx.reg.syncRules().source).toBe("code/\n");
    await ctx.reg.pull();
    expect(destructiveCalls(ctx.api)).toMatchObject({ createNote: 0, materialize: 0, deleteFile: 0, deletePath: 0 });
  });

  it("a note moved into a hidden folder on this disk is parked at its new path", async () => {
    const ctx = await syncedVault();
    ctx.reg.setSyncRules(RULE);
    ctx.reg.parkExcluded();
    ctx.disk.rules = RULE;
    // Finder: context.md now lives inside code/.
    ctx.disk.notes.delete("projects/app/context.md");
    ctx.disk.notes.set(`${CODE}/context.md`, "d1");
    ctx.reg.parkMovedOut("d1", "projects/app/context.md", `${CODE}/context.md`);
    expect(ctx.reg.isParked("d1")).toBe(true);
    expect(ctx.reg.getMapping("projects/app/context.md")).toBeNull();
    await ctx.reg.pull();
    await ctx.reg.pull();
    // The server still lists it at the old path: never materialized back, never deleted.
    expect(destructiveCalls(ctx.api)).toMatchObject({ createNote: 0, materialize: 0, deleteFile: 0, deletePath: 0 });
    expect((lastConfig().parked as { docs: Record<string, string> }).docs.d1).toBe(`${CODE}/context.md`);
  });

  it("a binary moved into a hidden folder on this disk is parked, not deleted", () => {
    const reg = new VaultRegistry(fakeApi({ notes: [] }));
    reg.setFileId("docs/a.pdf", "file-1");
    reg.setSyncRules(RULE);
    expect(reg.parkMovedFile("docs/a.pdf", `${CODE}/a.pdf`)).toBe(true);
    expect(reg.getFileId("docs/a.pdf")).toBeNull();
    expect(reg.isParked("file-1")).toBe(true);
    expect(reg.parkMovedFile("docs/none.pdf", `${CODE}/none.pdf`)).toBe(false);
    // The listing no longer offers it to download or delete.
    expect(reg.filterBlobListing([{ id: "b1", sha256: "s", relPath: "docs/a.pdf", docId: "file-1" }])).toEqual([]);
  });

  it("switching a file-type group off parks what synced under it, never deletes", () => {
    const reg = new VaultRegistry(fakeApi({ notes: [] }));
    reg.setSyncRules(new SyncRuleSet("", { code: true, extra: false }));
    reg.setFileId("src/app.ts", "file-ts");
    reg.setFileId("docs/a.pdf", "file-pdf");
    reg.setFileId("attachments/abc.ts", "file-att");
    expect(reg.isExcludedPath("src/app.ts")).toBe(false);
    reg.setSyncRules(NO_RULES);
    reg.parkExcluded();
    expect(reg.isParked("file-ts")).toBe(true);
    expect(reg.getFileId("docs/a.pdf")).toBe("file-pdf");
    // The embed store is never a type rule's business.
    expect(reg.getFileId("attachments/abc.ts")).toBe("file-att");
    expect(
      reg.filterBlobListing([
        { id: "b1", sha256: "s", relPath: "src/app.ts", docId: "file-ts" },
        { id: "b2", sha256: "t", relPath: "docs/a.pdf", docId: "file-pdf" },
      ]).map((b) => b.id),
    ).toEqual(["b2"]);
  });

  it("the blob listing freezes a binary a teammate moved into a hidden folder", () => {
    const reg = new VaultRegistry(fakeApi({ notes: [] }));
    reg.setFileId("docs/a.pdf", "file-1");
    reg.setSyncRules(RULE);
    const out = reg.filterBlobListing([
      { id: "b1", sha256: "s", relPath: `${CODE}/a.pdf`, docId: "file-1" },
      { id: "b2", sha256: "t", relPath: "docs/b.pdf", docId: "file-2" },
    ]);
    expect(out.map((b) => b.id)).toEqual(["b2"]);
    expect(reg.getFileId("docs/a.pdf")).toBeNull();
    expect(reg.frozenFilePaths()).toEqual(["docs/a.pdf"]);
    expect(reg.isFrozenPath("docs/a.pdf")).toBe(true);
    // The rule goes: it thaws, and the ordinary pass follows the move.
    reg.setSyncRules(NO_RULES);
    const back = reg.filterBlobListing([{ id: "b1", sha256: "s", relPath: `${CODE}/a.pdf`, docId: "file-1" }]);
    expect(back.map((b) => b.id)).toEqual(["b1"]);
    expect(reg.getFileId("docs/a.pdf")).toBe("file-1");
    expect(reg.frozenFilePaths()).toEqual([]);
  });
});
