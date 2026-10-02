// Creates the server refuses for ACCESS (`no_write_access`, `root_frozen`) while
// edits to existing notes keep syncing: a script writing new files into a
// view-only folder stranded every one of them, silently, for days. These pin
// the registry's side — the refusal is held across passes (so the vault never
// reads "Synced"), it is NOT re-sent on every pull, and an access change
// re-asks so the files register by themselves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../toast", () => ({ toast: vi.fn() }));

import { ApiError, type ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { HELD_REFUSAL_RETRY_MS, VaultRegistry } from "../registry";
import { fullTree, reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";

function tree(paths: string[]): TreeNode {
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
  for (const f of paths) {
    const i = f.lastIndexOf("/");
    ensure(i === -1 ? "" : f.slice(0, i)).children!.push({ id: f, name: f, path: f, isDir: false });
  }
  return root;
}

/** A server where `Reports/` is already registered but this user may not add to it. */
function fakeApi() {
  const notes: Array<{ id: string; rel_path: string }> = [];
  const folders = [{ id: "f-reports", path: "Reports" }];
  let writable = false;
  const api = {
    listVaults: vi.fn(async () => [{ id: "v1", name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => folders),
    listFolderRegistry: vi.fn(async () => ({ folders, tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => {
      if (!writable && input.path.startsWith("Reports/")) {
        throw new ApiError(403, "Forbidden", { code: "no_write_access" });
      }
      const row = { id: `folder-${input.path}`, path: input.path };
      folders.push(row);
      return row;
    }),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes, tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes, tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string; docId?: string }) => {
      if (!writable && input.relPath.startsWith("Reports/")) {
        throw new ApiError(403, "Forbidden", { code: "no_write_access" });
      }
      const row = { id: input.docId ?? `note-${input.relPath}`, rel_path: input.relPath };
      notes.push(row);
      return row;
    }),
    updateFolder: vi.fn(async () => ({})),
    grant: () => {
      writable = true;
    },
  };
  return api;
}

const reportsCreates = (api: ReturnType<typeof fakeApi>) =>
  api.createNote.mock.calls.filter((c) => c[0].relPath.startsWith("Reports/")).length;

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(paths: string[]) {
  const api = fakeApi();
  const reg = new VaultRegistry(api as unknown as ApiClient);
  vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(paths)));
  await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(paths));
  return { api, reg };
}

describe("VaultRegistry — creates refused for access", () => {
  it("classifies each refusal by code and keeps it across passes", async () => {
    const { reg } = await setup(["Reports/a.md", "Reports/b.md", "ok.md"]);
    const held = reg.heldRefusals();
    expect(held.map((f) => [f.path, f.code]).sort()).toEqual([
      ["Reports/a.md", "no_write_access"],
      ["Reports/b.md", "no_write_access"],
    ]);
    expect(reg.getMapping("ok.md")).not.toBeNull();

    // The next pull does not ask again, but the vault still is not clean.
    await reg.pull();
    expect(reg.hasFailures()).toBe(true);
    expect(reg.failures().filter((f) => f.code === "no_write_access")).toHaveLength(2);
  });

  it("does not re-send a refused create on every pull (no retry loop)", async () => {
    const { api, reg } = await setup(["Reports/a.md"]);
    expect(reportsCreates(api)).toBe(1);
    for (let i = 0; i < 5; i++) await reg.pull();
    expect(reportsCreates(api)).toBe(1);
  });

  it("re-asks on its own only after the slow backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { api, reg } = await setup(["Reports/a.md"]);
    vi.setSystemTime(Date.now() + HELD_REFUSAL_RETRY_MS - 1000);
    await reg.pull();
    expect(reportsCreates(api)).toBe(1);
    vi.setSystemTime(Date.now() + 2000);
    await reg.pull();
    expect(reportsCreates(api)).toBe(2);
    // Refused again: held again, backoff restarted.
    await reg.pull();
    expect(reportsCreates(api)).toBe(2);
    expect(reg.heldRefusals()).toHaveLength(1);
  });

  it("registers by itself once access changes", async () => {
    const { api, reg } = await setup(["Reports/a.md", "Reports/b.md"]);
    api.grant();
    // Granting alone changes nothing until something says access moved…
    await reg.pull();
    expect(reg.getMapping("Reports/a.md")).toBeNull();
    // …then the reauth / Access-panel path re-asks.
    expect(reg.retryHeldRefusals()).toBe(true);
    await reg.pull();
    expect(reg.getMapping("Reports/a.md")).not.toBeNull();
    expect(reg.getMapping("Reports/b.md")).not.toBeNull();
    expect(reg.heldRefusals()).toEqual([]);
    expect(reg.hasFailures()).toBe(false);
  });

  it("forgets a held refusal whose file left the disk", async () => {
    const { reg } = await setup(["Reports/a.md"]);
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree([])));
    await reg.pull();
    expect(reg.heldRefusals()).toEqual([]);
  });

  it("registers a held note once it is moved to a folder this user can edit", async () => {
    const { api, reg } = await setup(["Reports/a.md", "Reports/pic.png"]);
    vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree(["Mine/a.md", "Reports/pic.png"])));
    await reg.pull();
    expect(reg.getMapping("Mine/a.md")).not.toBeNull();
    expect(reg.heldRefusals()).toEqual([]);
    expect(reg.hasFailures()).toBe(false);
    expect(reportsCreates(api)).toBe(1);
  });

  it("holds a refused folder's notes with it instead of sending each one", async () => {
    const { api, reg } = await setup(["Reports/New/a.md", "Reports/New/b.md", "Reports/New/Deep/c.md"]);
    expect(reg.heldRefusals().map((f) => f.path).sort()).toEqual(["Reports/New"]);
    // Nothing inside it was sent: without the folder's id each would be refused.
    expect(api.createNote).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await reg.pull();
    expect(api.createFolder.mock.calls.filter((c) => c[0].path.startsWith("Reports/New"))).toHaveLength(1);
    expect(api.createNote).not.toHaveBeenCalled();

    api.grant();
    reg.retryHeldRefusals();
    await reg.pull();
    // The folder registers on the re-ask; its notes follow on the next pass.
    await reg.pull();
    expect(reg.getMapping("Reports/New/a.md")).not.toBeNull();
    expect(reg.getMapping("Reports/New/Deep/c.md")).not.toBeNull();
    expect(reg.heldRefusals()).toEqual([]);
  });

  it("forgets a held note or folder the moment it leaves the disk", async () => {
    const { reg } = await setup(["Reports/a.md", "Reports/New/b.md"]);
    expect(reg.heldRefusals()).toHaveLength(2);
    expect(reg.forgetHeldRefusal("reports/A.md")).toBe(true);
    expect(reg.forgetHeldRefusal("Reports/New")).toBe(true);
    expect(reg.heldRefusals()).toEqual([]);
    expect(reg.forgetHeldRefusal("Reports/a.md")).toBe(false);
  });

  it("retryHeldRefusals reports nothing to re-ask when nothing is held", async () => {
    const { reg } = await setup(["ok.md"]);
    expect(reg.retryHeldRefusals()).toBe(false);
  });

  it("clears held refusals on reset (vault switch)", async () => {
    const { reg } = await setup(["Reports/a.md"]);
    reg.reset();
    expect(reg.heldRefusals()).toEqual([]);
  });
});
