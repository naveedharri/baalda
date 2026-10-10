// Deleting a vault forgets it everywhere on this device and never reopens it.
//
// Owner report 2026-10-09: deleting the open LOCAL vault left the welcome
// screen listing it under Recent vaults and showing "Couldn't open the folder
// …: it isn't a folder". Deleting a SYNCED vault left this device's folder
// behind. Harness copied from `unsyncStore.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(async () => [] as unknown[]),
  setActiveOrganization: vi.fn(async () => {}),
  listMembers: vi.fn(async () => [] as unknown[]),
  listInvitations: vi.fn(async () => [] as unknown[]),
  listUserInvitations: vi.fn(async () => [] as unknown[]),
  getBillingConfig: vi.fn(async () => ({ enabled: false })),
  getOrgBilling: vi.fn(async () => null),
  unsyncVault: vi.fn(async () => ({
    unsynced: true,
    notes: 12,
    files: 3,
    members: 2,
    subscription: null,
  })),
  deleteRemoteVault: vi.fn(async () => ({ deleted: true, vaults: 1, subscription: null }) as unknown),
  getOrgStatus: vi.fn(async () => ({ kind: "vault-not-found" }) as unknown),
}));

const authManager = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  init: vi.fn(async () => null as unknown),
  currentSession: vi.fn(async () => null as unknown),
  signOut: vi.fn(async () => {}),
  getServerUrl: () => "http://localhost:3010",
}));

vi.mock("../lib/auth/authManager", () => {
  authManager.api = api as unknown as Record<string, unknown>;
  return { authManager, api };
});

const sync = vi.hoisted(() => ({
  registry: { vaultId: null as string | null, getMapping: () => null },
  isSyncable: vi.fn(() => false),
  enable: vi.fn(async () => ({ ok: true })),
  disable: vi.fn(),
  setViewing: vi.fn(),
  setPresenceStatus: vi.fn(),
  handleRegistryChanged: vi.fn(),
  setStatusListener: vi.fn(),
  setSessionRejectedListener: vi.fn(),
  setActivityListeners: vi.fn(),
  setRegistryListener: vi.fn(),
  setAclListener: vi.fn(),
  setInboundListeners: vi.fn(),
  setMemberJoinedListener: vi.fn(),
  setVaultPresenceListener: vi.fn(),
  setVoiceListener: vi.fn(),
  setSyncProgressListener: vi.fn(),
  setDocStateListener: vi.fn(),
  setFileStateListener: vi.fn(),
  setRegistryMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
  setColorListener: vi.fn(),
  setFailureListener: vi.fn(),
  announcePresence: vi.fn(),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));
vi.mock("../lib/bridge", () => ({ bridgeManager: { currentBridge: () => null } }));
vi.mock("../lib/toast", () => ({ toast: vi.fn(), dismissToast: vi.fn() }));

const ipcMock = vi.hoisted(() => ({
  isVaultMismatch: () => false,
  peekVaultStamp: vi.fn(async () => ({ organizationId: "org-a", serverVaultId: "v1" })),
  setVaultConfig: vi.fn(async () => {}),
  deleteVault: vi.fn(async (_path: string) => {}),
  openVault: vi.fn(async (_path: string) => ({}) as unknown),
  openVaultInRoot: vi.fn(async (_path: string) => ({}) as unknown),
  clearLastVault: vi.fn(async () => {}),
  getVaultEpoch: vi.fn(async () => 1),
  getNoteMeta: vi.fn(async (path: string) => ({ path, id: `local-${path}`, title: path })),
  getBacklinks: vi.fn(async () => []),
  listChildren: vi.fn(async () => []),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
}));

vi.mock("../lib/ipc", () => ipcMock);

import type { VaultInfo } from "../lib/ipc";
import { readLastVault, readOrgVaults, useStore } from "../store";
import { toast } from "../lib/toast";

const ORG = "org-a";
const PATH = "/vaults/a";

/** A `localStorage` the node env doesn't have — the bindings live in it. */
function installStorage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: () => null,
    length: 0,
  };
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  installStorage({
    "context.orgVaults": JSON.stringify({ [ORG]: PATH }),
    "context.lastVault": ORG,
  });
  api.listOrganizations.mockResolvedValue([]);
  useStore.setState({
    vault: { path: PATH, name: "a", epoch: 1 } as VaultInfo,
    session: {
      user: { id: "u1", name: "Ann", email: "ann@example.com" },
      activeOrganizationId: ORG,
    } as never,
    authStatus: "signed-in",
    organizations: [{ id: ORG, name: "A" }] as never,
    members: [{ userId: "u1", role: "owner" }] as never,
    // Signed in with sync on: the case the old `!syncEnabled` guard skipped.
    syncEnabled: true,
    tree: null,
    recentsVersion: 0,
  });
});

describe("deleteLocalVault", () => {
  it("closes the open vault, forgets its binding and never reopens the path", async () => {
    await useStore.getState().deleteLocalVault(PATH);
    expect(useStore.getState().vault).toBeNull();
    expect(ipcMock.deleteVault).toHaveBeenCalledWith(PATH);
    expect(readOrgVaults()[ORG]).toBeUndefined();
    expect(readLastVault()).toBeNull();
    expect(ipcMock.clearLastVault).toHaveBeenCalled();
    expect(ipcMock.openVault).not.toHaveBeenCalledWith(PATH);
    expect(ipcMock.openVaultInRoot).not.toHaveBeenCalled();
    // Recents lists re-read after the folder is gone.
    expect(useStore.getState().recentsVersion).toBe(1);
  });

  it("keeps the binding when the folder could not be trashed", async () => {
    ipcMock.deleteVault.mockRejectedValueOnce(new Error("Couldn't move the folder to the Trash."));
    await expect(useStore.getState().deleteLocalVault(PATH)).rejects.toThrow();
    expect(readOrgVaults()[ORG]).toBe(PATH);
    expect(useStore.getState().recentsVersion).toBe(1);
  });
});

describe("deleteRemoteVault", () => {
  it("moves this device's folder to the Trash after the server delete", async () => {
    await useStore.getState().deleteRemoteVault(ORG);
    expect(api.deleteRemoteVault).toHaveBeenCalledWith(ORG);
    expect(ipcMock.deleteVault).toHaveBeenCalledWith(PATH);
    expect(useStore.getState().vault).toBeNull();
    expect(readOrgVaults()[ORG]).toBeUndefined();
    expect(readLastVault()).toBeNull();
    expect(ipcMock.openVault).not.toHaveBeenCalledWith(PATH);
    expect(useStore.getState().recentsVersion).toBe(1);
  });

  it("touches nothing on this device when the server refuses", async () => {
    api.deleteRemoteVault.mockRejectedValueOnce(new Error("forbidden"));
    await expect(useStore.getState().deleteRemoteVault(ORG)).rejects.toThrow();
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(readOrgVaults()[ORG]).toBe(PATH);
  });

  it("still counts the delete when the trash fails, and says so", async () => {
    ipcMock.deleteVault.mockRejectedValueOnce(new Error("Couldn't move the folder to the Trash."));
    const result = await useStore.getState().deleteRemoteVault(ORG);
    expect(result).toMatchObject({ deleted: true });
    expect(toast).toHaveBeenCalledWith("Couldn't move the folder to the Trash.", "error");
    expect(readOrgVaults()[ORG]).toBeUndefined();
  });
});
