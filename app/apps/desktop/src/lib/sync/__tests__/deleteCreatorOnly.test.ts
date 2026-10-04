// Creator-only delete (desktop side): a plain member may delete only the
// notes, files and folders they created; owners/admins anything. The server
// answers 403 `delete_not_creator` / `folder_has_others_items`; the sidebar
// disables Delete up front, and a DISK delete the server refuses is put back
// instead of leaving the file gone on this device only.
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
vi.mock("../../vault/seed", () => ({
  seedWelcomeContent: vi.fn(async () => {}),
}));

import { ApiError, type ApiClient } from "../../api";
import type { NoteDeleteResult } from "../bulkTypes";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";
import { reconcileReport } from "../reconcileReport";
import { summarizeReconcile } from "../../reconcileSummary";
import { SyncManager } from "../docSession";
import {
  NOT_CREATOR_DETAIL,
  NOT_CREATOR_MESSAGE,
  canDeleteItem,
} from "../deletePolicy";

const ORG = "org-1";
const VAULT = "v-1";
const ME = "user-me";
const MINE = "Mine.md";
const THEIRS = "Theirs.md";
const ORPHAN = "Orphan.md";
const serverId = (relPath: string) => `srv-${relPath}`;

function tree(paths: string[]): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: paths.map((p) => {
      const parts = p.split("/");
      if (parts.length === 1) return { id: p, name: p, path: p, isDir: false };
      return {
        id: parts[0],
        name: parts[0],
        path: parts[0],
        isDir: true,
        children: [{ id: p, name: parts[1], path: p, isDir: false }],
      };
    }),
  };
}

const creatorRefusal = () =>
  new ApiError(403, "forbidden", { code: "delete_not_creator", error: "not the creator" });

function fakeApi(refuse: Set<string>) {
  const state = { singleDeletes: [] as string[], batchIds: [] as string[][] };
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}`, path: input.path })),
    batchCreateFolders: vi.fn(async (_v: string, items: Array<{ path: string }>) =>
      items.map((i) => ({ path: i.path, id: `folder-${i.path}`, status: "created" as const, code: null, error: null })),
    ),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: serverId(input.relPath),
      rel_path: input.relPath,
      title: null,
    })),
    batchCreateNotes: vi.fn(async (_v: string, items: Array<{ relPath: string }>) =>
      items.map((i) => ({
        relPath: i.relPath,
        docId: serverId(i.relPath),
        status: "created" as const,
        folderId: null,
        title: null,
        code: null,
        error: null,
      })),
    ),
    deleteNote: vi.fn(async (id: string) => {
      state.singleDeletes.push(id);
      if (refuse.has(id)) throw creatorRefusal();
    }),
    deleteFolder: vi.fn(async () => {}),
    deleteNotesBatch: vi.fn(async (_vaultId: string, docIds: string[]) => {
      state.batchIds.push([...docIds]);
      return docIds.map(
        (docId): NoteDeleteResult =>
          refuse.has(docId)
            ? { docId, status: "denied", code: "delete_not_creator", error: "not the creator" }
            : { docId, status: "deleted", code: null, error: null },
      );
    }),
  } as unknown as ApiClient;
  return { api, state };
}

/** A registry where THIS user created `MINE`, a teammate `THEIRS`, and `ORPHAN`
 *  has no creator on record. */
async function setup(paths: string[], refuse: Set<string>) {
  const { api, state } = fakeApi(refuse);
  const reg = new VaultRegistry(api);
  const materializeContent = vi.fn(async () => true);
  reg.setInboundHost({ localUserId: () => ME, materializeContent } as unknown as InboundHost);
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(paths));
  for (const m of reg.mappedNotes()) reg.markPushed(m.docId);
  // What a pull learns from the listing's `createdBy`.
  (reg as unknown as { learnAuthorship(n: unknown[]): void }).learnAuthorship(
    paths.map((p) => ({
      id: serverId(p),
      rel_path: p,
      created_by: p.endsWith(MINE) ? ME : p.endsWith(THEIRS) ? "user-teammate" : null,
    })),
  );
  return { reg, api, state, materializeContent };
}

beforeEach(() => {
  vi.clearAllMocks();
  reconcileReport.clear();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(true);
});

describe("row menu / selection bar gating", () => {
  it("a member may delete their own note, not a teammate's or a creator-less one", async () => {
    const { reg } = await setup([MINE, THEIRS, ORPHAN], new Set());
    const can = (path: string) => canDeleteItem("member", () => reg.isAuthoredByMe(path, false));
    expect(can(MINE)).toBe(true);
    expect(can(THEIRS)).toBe(false);
    expect(can(ORPHAN)).toBe(false);
  });

  it("an admin or owner may delete both", async () => {
    const { reg } = await setup([MINE, THEIRS, ORPHAN], new Set());
    for (const role of ["admin", "owner"]) {
      for (const p of [MINE, THEIRS, ORPHAN]) {
        expect(canDeleteItem(role, () => reg.isAuthoredByMe(p, false))).toBe(true);
      }
    }
  });

  it("a folder is a member's to delete only when everything in it is theirs", async () => {
    const { reg } = await setup([`A/${MINE}`, `B/${MINE}`, `B/${THEIRS}`], new Set());
    expect(canDeleteItem("member", () => reg.isAuthoredByMe("A", true))).toBe(true);
    expect(canDeleteItem("member", () => reg.isAuthoredByMe("B", true))).toBe(false);
  });

  it("a note this user just registered is theirs before any pull", async () => {
    const { reg } = await setup([], new Set());
    await reg.registerNote("Fresh.md", null);
    expect(reg.isAuthoredByMe("Fresh.md", false)).toBe(true);
  });
});

describe("registry — creator refusals", () => {
  it("deletePath rethrows a 403 delete_not_creator with the plain sentence and keeps the mapping", async () => {
    const { reg } = await setup([MINE, THEIRS], new Set([serverId(THEIRS)]));
    const err = await reg.deletePath(THEIRS).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(NOT_CREATOR_MESSAGE);
    expect(((err as ApiError).body as { code: string }).code).toBe("delete_not_creator");
    expect(reg.getMapping(THEIRS)?.docId).toBe(serverId(THEIRS));
  });

  it("a batch with one refused item keeps only that item's mapping", async () => {
    const { reg } = await setup([MINE, THEIRS, "Other.md"], new Set([serverId(THEIRS)]));
    const out = await reg.deletePaths([MINE, THEIRS, "Other.md"]);
    const by = new Map(out.map((o) => [o.path, o]));
    expect(by.get(MINE)?.status).toBe("deleted");
    expect(by.get("Other.md")?.status).toBe("deleted");
    expect(by.get(THEIRS)).toMatchObject({ status: "denied", code: "delete_not_creator", reason: NOT_CREATOR_MESSAGE });
    expect(reg.getMapping(THEIRS)).toBeTruthy();
    expect(reg.getMapping(MINE)).toBeFalsy();
  });
});

describe("disk deletes — a refused delete is put back", () => {
  type Drain = (
    this: unknown,
    deleted: ReadonlyArray<{ docId: string; relPath: string }>,
    scope: { isCurrent(): boolean },
  ) => Promise<Array<{ docId: string; relPath: string }>>;
  const propagate = (SyncManager.prototype as unknown as { propagateDiskDeletes: Drain }).propagateDiskDeletes;
  const scope = { isCurrent: () => true };
  const host = (reg: VaultRegistry) => ({
    registry: reg,
    note: vi.fn(),
    putBackNotCreator: (SyncManager.prototype as unknown as { putBackNotCreator: unknown }).putBackNotCreator,
  });

  it("a member's disk delete of a teammate's note: 403, restored with content, one entry, no retry", async () => {
    const { reg, state, materializeContent } = await setup([MINE, THEIRS], new Set([serverId(THEIRS)]));
    const d = { docId: serverId(THEIRS), relPath: THEIRS };
    const propagated = await propagate.call(host(reg), [d], scope);

    expect(propagated).toEqual([]);
    expect(ipc.writeNoteIfMissing).toHaveBeenCalledWith(THEIRS, "", null);
    expect(materializeContent).toHaveBeenCalledWith(serverId(THEIRS), THEIRS);
    // Its placeholder's watcher echo is ours, owed exactly once.
    expect(reg.consumeMaterialized(THEIRS)).toBe(true);
    expect(reg.consumeMaterialized(THEIRS)).toBe(false);
    expect(reg.getMapping(THEIRS)?.docId).toBe(serverId(THEIRS));
    // One request: the delete is not retried.
    expect(state.singleDeletes).toEqual([serverId(THEIRS)]);
    const items = reconcileReport.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "restoredFromServer", path: THEIRS, detail: NOT_CREATOR_DETAIL });
    expect(summarizeReconcile(items)[0].text).toBe(
      "Theirs.md was put back: only the person who created it, or an admin, can delete it.",
    );
    // A second refusal of the same note in this session does not re-announce it.
    await reg.restoreRefusedDelete(THEIRS, serverId(THEIRS));
    expect(reconcileReport.items()).toHaveLength(1);
  });

  it("the member's own note still propagates", async () => {
    const { reg, state } = await setup([MINE, THEIRS], new Set([serverId(THEIRS)]));
    const d = { docId: serverId(MINE), relPath: MINE };
    const propagated = await propagate.call(host(reg), [d], scope);
    expect(propagated).toEqual([d]);
    expect(state.singleDeletes).toEqual([serverId(MINE)]);
    expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
    expect(reconcileReport.items()).toEqual([]);
  });

  it("a bulk disk delete with one refused item restores only that item", async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `N${i}.md`).concat([THEIRS]);
    const { reg, state } = await setup(paths, new Set([serverId(THEIRS)]));
    const deleted = paths.map((p) => ({ docId: serverId(p), relPath: p }));
    const propagated = await propagate.call(host(reg), deleted, scope);

    expect(state.batchIds.length).toBeGreaterThan(0);
    expect(propagated.map((d) => d.relPath).sort()).toEqual(paths.filter((p) => p !== THEIRS).sort());
    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0])).toEqual([THEIRS]);
    expect(reconcileReport.items().map((i) => i.path)).toEqual([THEIRS]);
  });
});

describe("files — creator learned from GET /api/files", () => {
  it("a member's own file, mapped by a download that carried no creator, is theirs once the files listing names them", async () => {
    const { reg, api } = await setup([MINE], new Set());
    // The server's real row shape: raw columns, snake_case `created_by`.
    (api as unknown as Record<string, unknown>).listFiles = vi.fn(async () => [
      { id: "file-mine", vault_id: VAULT, folder_id: null, path: "mine.png", created_by: ME, created_at: "2026-10-01T00:00:00Z" },
      { id: "file-theirs", vault_id: VAULT, folder_id: null, path: "theirs.png", created_by: "user-teammate", created_at: "2026-10-01T00:00:00Z" },
    ]);
    // A download: the blob listing has no creator, so nothing is claimed here.
    reg.setFileId("mine.png", "file-mine", { createdBy: null });
    reg.setFileId("theirs.png", "file-theirs", { createdBy: null });
    expect(reg.isAuthoredByMe("mine.png", false)).toBe(false);
    await (reg as unknown as { learnFileAuthorship(v: string): Promise<void> }).learnFileAuthorship(VAULT);
    expect(reg.isAuthoredByMe("mine.png", false)).toBe(true);
    expect(reg.isAuthoredByMe("theirs.png", false)).toBe(false);
  });
});
