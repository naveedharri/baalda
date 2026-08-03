// Vault isolation. Rust holds ONE global vault slot and the whole sync layer
// (registry, doc store, attachments, debounced timers) is a set of process
// singletons — so anything still in flight for vault A when the user switches to
// vault B used to land on B's folder with A's server ids: A's folders/notes
// created under A's `vaultId` from B's tree, A's doc map written into B's
// `.context/config.json`, A's note paths materialized as empty files inside B.
// Switching back merged the other direction.
//
// These tests pin the two guards that make that impossible:
//   1. VaultScope — capture the scope you began under, bail when it's stale.
//   2. The vault epoch passed to Rust — a write that slips past guard 1 is
//      refused at the IPC boundary instead of hitting the wrong folder.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [] })),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  listAttachments: vi.fn(async () => []),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => null) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { VaultScopeManager } from "../vaultScope";

const ORG_A = "org-a";
const ORG_B = "org-b";

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [] };
}

function treeWith(...paths: string[]): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: paths.map((p) => ({ id: p, name: p, path: p, isDir: false })),
  };
}

/** A deferred promise, to hold an async step open across a vault switch. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockClear().mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockClear();
  vi.mocked(ipc.writeNote).mockClear();
  vi.mocked(ipc.listTree)
    .mockClear()
    .mockResolvedValue(emptyTree());
  vi.mocked(ipc.listNoteTitles).mockClear().mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// The scope primitive
// ---------------------------------------------------------------------------

describe("VaultScopeManager", () => {
  it("retires the previous scope on every switch, and bumps the generation", () => {
    const scopes = new VaultScopeManager();
    const a = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    expect(a.isCurrent()).toBe(true);
    expect(a.signal.aborted).toBe(false);

    const b = scopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });
    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true); // anything awaiting the scope unblocks
    expect(b.isCurrent()).toBe(true);
    expect(b.generation).toBeGreaterThan(a.generation);
  });

  it("end() leaves no current scope and retires the one it had", () => {
    const scopes = new VaultScopeManager();
    const a = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    scopes.end();
    expect(scopes.current()).toBeNull();
    expect(scopes.currentEpoch()).toBeNull();
    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true);
  });

  it("re-opening the SAME folder is still a new generation (paths repeat, epochs don't)", () => {
    const scopes = new VaultScopeManager();
    const first = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    const second = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 2 });
    expect(first.isCurrent()).toBe(false);
    expect(second.vaultEpoch).toBe(2);
  });

  // One vault open signals twice (Rust's `vault-opened` event AND the `open_vault`
  // response, in an order Tauri doesn't guarantee), so the store uses `ensure`.
  it("ensure() keeps the existing scope for the same folder+epoch, org-binding included", () => {
    const scopes = new VaultScopeManager();
    // What `syncManager.enable` produces: a scope bound to an org.
    const bound = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    bound.serverVaultId = "vault-a";

    // The late duplicate signal, which knows the folder but not the org.
    const same = scopes.ensure({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 1 });

    // Re-beginning here would retire the org-bound scope and leave every sync
    // guard reading stale — sync would go silently inert.
    expect(same).toBe(bound);
    expect(bound.isCurrent()).toBe(true);
    expect(bound.signal.aborted).toBe(false);
    expect(same.orgId).toBe(ORG_A);
    expect(same.serverVaultId).toBe("vault-a");
  });

  it("ensure() DOES begin a new scope for a different folder or a new epoch", () => {
    const scopes = new VaultScopeManager();
    const a = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });

    const b = scopes.ensure({ orgId: null, vaultPath: "/vaults/b", vaultEpoch: 1 });
    expect(b).not.toBe(a);
    expect(a.isCurrent()).toBe(false);

    // Same folder reopened → new epoch → genuinely a new scope.
    const reopened = scopes.ensure({ orgId: null, vaultPath: "/vaults/b", vaultEpoch: 2 });
    expect(reopened).not.toBe(b);
    expect(b.isCurrent()).toBe(false);
    expect(reopened.vaultEpoch).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (b) An in-flight reconcile that spans a vault switch
// ---------------------------------------------------------------------------

describe("VaultRegistry.reconcile across a vault switch", () => {
  it("writes NOTHING to the new vault when the switch lands mid-reconcile", async () => {
    const scopes = new VaultScopeManager();
    scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });

    const held = gate();
    const createFolder = vi.fn(async (i: { path: string }) => ({ id: `f-${i.path}` }));
    const createNote = vi.fn(async (i: { relPath: string }) => ({
      id: `n-${i.relPath}`,
      rel_path: i.relPath,
    }));
    const api = {
      listVaults: vi.fn(async () => [
        { id: "vault-a", name: "a", organization_id: ORG_A },
      ]),
      createVault: vi.fn(),
      // Hold the reconcile open here, then switch vaults underneath it. Every
      // structural write happens AFTER this await.
      listNotes: vi.fn(async () => {
        await held.waited;
        return [{ id: "server-only", rel_path: "FromA.md" }];
      }),
      listFolders: vi.fn(async () => []),
      createFolder,
      createNote,
    } as unknown as ApiClient;

    const reg = new VaultRegistry(api, scopes);
    const running = reg.reconcile(
      { organizationId: ORG_A, vaultName: "a" },
      treeWith("Notes/OnlyInA.md"),
    );

    // The user switches to vault B while the reconcile is parked.
    scopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });
    held.open();
    await expect(running).resolves.toEqual({ seeded: false });

    // Not one write escaped into vault B: no server rows created from B's tree…
    expect(createFolder).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    // …vault A's doc map was not written into B's .context/config.json…
    expect(ipc.setVaultConfig).not.toHaveBeenCalled();
    // …and A's server-only note was not materialized inside B's folder.
    expect(ipc.writeNote).not.toHaveBeenCalled();
  });

  it("still completes normally when no switch happens (the guard is not a stall)", async () => {
    const scopes = new VaultScopeManager();
    const scope = scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const createNote = vi.fn(async (i: { relPath: string }) => ({
      id: `n-${i.relPath}`,
      rel_path: i.relPath,
    }));
    const api = {
      listVaults: vi.fn(async () => [
        { id: "vault-a", name: "a", organization_id: ORG_A },
      ]),
      createVault: vi.fn(),
      listNotes: vi.fn(async () => [{ id: "server-only", rel_path: "FromServer.md" }]),
      listFolders: vi.fn(async () => []),
      createFolder: vi.fn(async (i: { path: string }) => ({ id: `f-${i.path}` })),
      createNote,
    } as unknown as ApiClient;

    const reg = new VaultRegistry(api, scopes);
    await reg.reconcile({ organizationId: ORG_A, vaultName: "a" }, treeWith("Mine.md"));

    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ relPath: "Mine.md" }));
    expect(reg.vaultId).toBe("vault-a");
    // The resolved server vault id is published on the scope for later phases.
    expect(scope.serverVaultId).toBe("vault-a");
    // Every vault-relative write carries this scope's epoch, so Rust refuses it
    // if the vault changes before the call lands.
    expect(ipc.writeNote).toHaveBeenCalledWith("FromServer.md", "", 7);
    expect(ipc.setVaultConfig).toHaveBeenCalledWith(expect.any(String), 7);
  });

  it("a stale pull() is a no-op: no tree read, no server writes, no config write", async () => {
    const scopes = new VaultScopeManager();
    scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    const api = {
      listVaults: vi.fn(async () => [
        { id: "vault-a", name: "a", organization_id: ORG_A },
      ]),
      createVault: vi.fn(),
      listNotes: vi.fn(async () => []),
      listFolders: vi.fn(async () => []),
      createFolder: vi.fn(),
      createNote: vi.fn(),
    } as unknown as ApiClient;
    const reg = new VaultRegistry(api, scopes);
    await reg.reconcile({ organizationId: ORG_A, vaultName: "a" }, emptyTree());

    vi.mocked(ipc.listTree).mockClear();
    vi.mocked(ipc.setVaultConfig).mockClear();
    // Switch vaults, then let the pull run — this is the exact corruption path:
    // `serverVaultId` is still A's while `listTree()` would return B's tree.
    scopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });
    await reg.pull();

    expect(ipc.listTree).not.toHaveBeenCalled();
    expect(ipc.setVaultConfig).not.toHaveBeenCalled();
  });

  it("reset() forgets the vault, so nothing can be applied to the next one", async () => {
    const scopes = new VaultScopeManager();
    scopes.begin({ orgId: ORG_A, vaultPath: "/vaults/a", vaultEpoch: 1 });
    const api = {
      listVaults: vi.fn(async () => [
        { id: "vault-a", name: "a", organization_id: ORG_A },
      ]),
      createVault: vi.fn(),
      listNotes: vi.fn(async () => [{ id: "n1", rel_path: "Kept.md" }]),
      listFolders: vi.fn(async () => [{ id: "f1", path: "Docs" }]),
      createFolder: vi.fn(),
      createNote: vi.fn(),
    } as unknown as ApiClient;
    const reg = new VaultRegistry(api, scopes);
    await reg.reconcile({ organizationId: ORG_A, vaultName: "a" }, emptyTree());
    expect(reg.vaultId).toBe("vault-a");
    expect(reg.getMapping("Kept.md")).not.toBeNull();

    reg.reset();
    vi.mocked(ipc.setVaultConfig).mockClear();
    vi.mocked(ipc.listTree).mockClear();

    expect(reg.vaultId).toBeNull();
    expect(reg.getMapping("Kept.md")).toBeNull();
    expect(reg.pathForDocId("n1")).toBeNull();
    expect(reg.getFolderId("Docs")).toBeNull();
    // With no vault, an on-demand register is refused rather than guessed.
    expect(await reg.registerNote("New.md", "New")).toBeNull();
    await reg.pull(); // and a pull does nothing at all
    expect(ipc.listTree).not.toHaveBeenCalled();
    expect(ipc.setVaultConfig).not.toHaveBeenCalled();
  });
});
