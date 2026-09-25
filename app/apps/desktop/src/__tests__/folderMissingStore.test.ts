// The open vault's folder is missing (#228), at the store level.
//
// One recovery path: the in-vault banner, the Settings → Vaults row and the
// Set-up prompt all call `restoreVaultFolder` / `locateVaultFolder`, and both
// end in the same `applyVaultFolder` / `openLocalVault` a vault switch uses.
// Reset local copy is that same Restore here, preceded by a guarded delete.
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `unsyncStore.test.ts`; `applyVaultFolder` / `openLocalVault` are replaced on
// the store so the tests pin WHICH folder each action binds, and how.

import { beforeEach, describe, expect, it, vi } from "vitest";

const authManager = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  init: vi.fn(async () => null as unknown),
  currentSession: vi.fn(async () => null as unknown),
  signOut: vi.fn(async () => {}),
  getServerUrl: () => "http://localhost:3010",
}));

vi.mock("../lib/auth/authManager", () => ({ authManager, api: authManager.api }));

const calls = vi.hoisted(() => [] as string[]);

const sync = vi.hoisted(() => ({
  registry: { vaultId: null as string | null, getMapping: () => null },
  disable: vi.fn(() => {
    calls.push("disable");
  }),
  setViewing: vi.fn(),
  withDeliberateRootChange: vi.fn(async (fn: () => Promise<unknown>) => {
    calls.push("deliberate:start");
    try {
      return await fn();
    } finally {
      calls.push("deliberate:end");
    }
  }),
  unsyncedNotePaths: vi.fn(() => [] as string[]),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));
vi.mock("../lib/bridge", () => ({ bridgeManager: { currentBridge: () => null } }));
vi.mock("../lib/toast", () => ({ toast: vi.fn(), dismissToast: vi.fn() }));

const ipcMock = vi.hoisted(() => ({
  isVaultMismatch: () => false,
  pickFolder: vi.fn(async () => "/moved/a" as string | null),
  resetVaultLocalCopy: vi.fn(async () => {
    calls.push("delete");
  }),
  deleteVault: vi.fn(async () => {}),
  deletePath: vi.fn(async () => {}),
  getVaultsRoot: vi.fn(async () => "/root"),
  listVaultsRootDirs: vi.fn(async () => [] as string[]),
}));

vi.mock("../lib/ipc", () => ipcMock);

import type { VaultInfo } from "../lib/ipc";
import { useStore } from "../store";

const ORG = "org-a";
const PATH = "/vaults/a";

function installStorage() {
  const data: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

const vault = (): VaultInfo => ({ path: PATH, name: "a", epoch: 1 }) as VaultInfo;
const missing = { rootMissing: true, pendingDelete: null, closedAppChanges: false };
const present = { rootMissing: false, pendingDelete: null, closedAppChanges: false };

let applyVaultFolder: ReturnType<typeof vi.fn>;
let openLocalVault: ReturnType<typeof vi.fn>;

function synced() {
  useStore.setState({
    session: {
      user: { id: "u1", name: "Ann", email: "ann@example.com" },
      activeOrganizationId: ORG,
    } as never,
    syncEnabled: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  installStorage();
  applyVaultFolder = vi.fn(async () => {
    calls.push("restore");
  });
  openLocalVault = vi.fn(async () => {});
  ipcMock.pickFolder.mockResolvedValue("/moved/a");
  useStore.setState({
    vault: vault(),
    session: null,
    syncEnabled: false,
    pendingVaultFolder: null,
    structureNotice: missing,
    openTabs: [],
    openNote: null,
    applyVaultFolder: applyVaultFolder as never,
    openLocalVault: openLocalVault as never,
  });
});

describe("the folder going missing", () => {
  it("closes every open tab the moment it is reported, and mirrors the notice", () => {
    useStore.setState({ structureNotice: present, openTabs: ["a.md", "b/c.md"] });
    useStore.getState().applyStructureNotice(missing);
    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().structureNotice.rootMissing).toBe(true);
  });

  it("leaves tabs alone for any other notice", () => {
    useStore.setState({ structureNotice: present, openTabs: ["a.md"] });
    useStore.getState().applyStructureNotice({ ...present, closedAppChanges: true });
    expect(useStore.getState().openTabs).toEqual(["a.md"]);
  });
});

describe("Restore here", () => {
  it("recreates the folder at its old path and syncs it down (the empty-folder path)", async () => {
    synced();
    await useStore.getState().restoreVaultFolder();
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, PATH, { create: true, seedIfEmpty: undefined });
  });

  it("refuses for a local-only vault: there is nothing to restore from", async () => {
    await expect(useStore.getState().restoreVaultFolder()).rejects.toThrow(/isn't synced/);
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });

  it("does nothing when the folder is not missing", async () => {
    synced();
    useStore.setState({ structureNotice: present });
    await useStore.getState().restoreVaultFolder();
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });

  it("is what the Set-up prompt's Restore here runs for a missing folder", async () => {
    useStore.setState({
      vault: null,
      structureNotice: present,
      pendingVaultFolder: {
        orgId: ORG,
        orgName: "A",
        previousOrgId: null,
        reason: { text: "gone", path: "/old/A", missing: true },
      },
    });
    await useStore.getState().startEmptyVault();
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, "/old/A", { create: true, seedIfEmpty: undefined });
  });

  it("keeps Start with an empty folder a fresh folder under the vaults root", async () => {
    useStore.setState({
      vault: null,
      structureNotice: present,
      pendingVaultFolder: { orgId: ORG, orgName: "Team", previousOrgId: null, reason: null },
    });
    await useStore.getState().startEmptyVault();
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, "/root/team", {
      create: true,
      seedIfEmpty: undefined,
    });
  });
});

describe("Locate folder…", () => {
  it("binds the picked folder to the synced vault (the open-folder path)", async () => {
    synced();
    await useStore.getState().locateVaultFolder();
    expect(ipcMock.pickFolder).toHaveBeenCalled();
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, "/moved/a");
    expect(openLocalVault).not.toHaveBeenCalled();
  });

  it("reopens a local-only vault from the picked folder", async () => {
    await useStore.getState().locateVaultFolder();
    expect(openLocalVault).toHaveBeenCalledWith("/moved/a");
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled", async () => {
    synced();
    ipcMock.pickFolder.mockResolvedValue(null);
    await useStore.getState().locateVaultFolder();
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });

  it("is what the Set-up prompt's Locate folder… runs", async () => {
    useStore.setState({
      vault: null,
      structureNotice: present,
      pendingVaultFolder: {
        orgId: ORG,
        orgName: "A",
        previousOrgId: null,
        reason: { text: "gone", path: "/old/A", missing: true },
      },
    });
    await useStore.getState().chooseVaultFolder();
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, "/moved/a");
  });
});

describe("Reset local copy", () => {
  it("stops sync, deletes the folder, then runs Restore here — in that order", async () => {
    synced();
    useStore.setState({ structureNotice: present, openTabs: ["a.md"] });
    await useStore.getState().resetLocalVaultCopy();
    expect(calls).toEqual(["deliberate:start", "disable", "delete", "restore", "deliberate:end"]);
    expect(ipcMock.resetVaultLocalCopy).toHaveBeenCalledWith(PATH, 1);
    expect(applyVaultFolder).toHaveBeenCalledWith(ORG, PATH, { create: true });
    expect(useStore.getState().openTabs).toEqual([]);
    // Never the Trash path, never the sidebar's recursive delete.
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(ipcMock.deletePath).not.toHaveBeenCalled();
  });

  it("never deletes anything for a local-only vault", async () => {
    useStore.setState({ structureNotice: present });
    await expect(useStore.getState().resetLocalVaultCopy()).rejects.toThrow(/synced vault/);
    expect(ipcMock.resetVaultLocalCopy).not.toHaveBeenCalled();
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });

  it("does not recreate the folder when the delete is refused", async () => {
    synced();
    useStore.setState({ structureNotice: present });
    ipcMock.resetVaultLocalCopy.mockRejectedValueOnce(new Error("Refusing to reset"));
    await expect(useStore.getState().resetLocalVaultCopy()).rejects.toThrow("Refusing");
    expect(applyVaultFolder).not.toHaveBeenCalled();
  });
});
