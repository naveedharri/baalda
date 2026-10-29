// Vault keys: when membership ends or the vault is gone (a DEFINITIVE server
// answer), this device deletes that vault's key + provisional marker from the
// keychain, and never the account key, the device-link key or teammate pins.
// A network error, or a vault the account still lists, deletes nothing. The
// local files' fate is unchanged (asserted beside each case).
// Harness copied from `deleteVaultStore.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(async () => [] as unknown[]),
  setActiveOrganization: vi.fn(async () => {}),
  listMembers: vi.fn(async () => [] as unknown[]),
  listInvitations: vi.fn(async () => [] as unknown[]),
  listUserInvitations: vi.fn(async () => [] as unknown[]),
  getBillingConfig: vi.fn(async () => ({ enabled: false })),
  getOrgBilling: vi.fn(async () => null),
  unsyncVault: vi.fn(async () => ({ unsynced: true, notes: 1, files: 0, members: 2, subscription: null })),
  deleteRemoteVault: vi.fn(async () => ({ deleted: true, vaults: 1, subscription: null }) as unknown),
  getOrgStatus: vi.fn(async () => ({ kind: "vault-not-found" }) as unknown),
  leaveVault: vi.fn(async () => {}),
  membershipCheck: vi.fn(async (_ids: string[]) => ({ member: [] as string[], notMember: [] as string[], unknown: [] as string[] })),
  getBaseUrl: () => "http://localhost:3010",
  setVaultKeyResolver: vi.fn(),
  setKeyRequiredHandler: vi.fn(),
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
  peekVaultStamp: vi.fn(
    async (_path: string) =>
      ({ organizationId: "org-a", serverVaultId: "v1" }) as { organizationId: string | null; serverVaultId: string | null } | null,
  ),
  setVaultConfig: vi.fn(async () => {}),
  deleteVault: vi.fn(async (_path: string) => {}),
  deleteDepartedVault: vi.fn(async (_path: string, _orgId: string) => {}),
  vaultSecretGet: vi.fn(),
  vaultSecretSet: vi.fn(),
  vaultSecretDelete: vi.fn(),
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
import { useStore } from "../store";
import { rememberOrgVault, vaultIdsForOrg } from "../lib/vaultKeys/forget";
import { setSecretIoForTests } from "../lib/vaultKeys/store";

const ORG = "org-a";
const PATH = "/vaults/a";
const SERVER = "http://localhost:3010";
const VK = `vk:${SERVER}:v1`;
const PROVISIONAL = `vk:${SERVER}:v1|provisional`;
const ACCOUNT = `baalda.keys:${SERVER}|u1`;
const LINK = `baalda.keys:link|${SERVER}|u1`;
const PIN = `baalda.keys:pin|${SERVER}|u1|u2`;
const OTHER_VK = `vk:${SERVER}:v-other`;
let secrets: Map<string, string>;

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
  ipcMock.peekVaultStamp.mockResolvedValue({ organizationId: ORG, serverVaultId: "v1" });
  api.listOrganizations.mockResolvedValue([]);
  secrets = new Map([
    [VK, "AAAA"],
    [PROVISIONAL, "AQ=="],
    [ACCOUNT, "BBBB"],
    [LINK, "CCCC"],
    [PIN, "fp"],
    [OTHER_VK, "DDDD"],
  ]);
  setSecretIoForTests({
    get: async (k) => secrets.get(k) ?? null,
    set: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  });
  useStore.setState({
    vault: { path: PATH, name: "a", epoch: 1 } as VaultInfo,
    session: {
      user: { id: "u1", name: "Ann", email: "ann@example.com" },
      activeOrganizationId: ORG,
    } as never,
    authStatus: "signed-in",
    serverUrl: SERVER,
    organizations: [{ id: ORG, name: "A" }] as never,
    members: [{ userId: "u1", role: "owner" }] as never,
    syncEnabled: true,
    tree: null,
    recentsVersion: 0,
  });
});

const kept = () => [ACCOUNT, LINK, PIN, OTHER_VK].every((k) => secrets.has(k));
const vkGone = () => !secrets.has(VK) && !secrets.has(PROVISIONAL);

describe("membership ended", () => {
  it("a confirmed removal deletes the vault key + marker, nothing else; folder delete unchanged", async () => {
    await useStore.getState().handleMembershipLost(ORG, "removed");
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
    expect(ipcMock.deleteDepartedVault).toHaveBeenCalledWith(PATH, ORG);
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
  });

  it("finds the key through the org→vault map when the folder has no stamp", async () => {
    ipcMock.peekVaultStamp.mockResolvedValue(null);
    rememberOrgVault(SERVER, "u1", ORG, "v1");
    await useStore.getState().handleMembershipLost(ORG, "removed");
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
    expect(vaultIdsForOrg(SERVER, "u1", ORG)).toEqual([]);
  });

  it("ignores a stamp naming another org", async () => {
    ipcMock.peekVaultStamp.mockResolvedValue({ organizationId: "org-x", serverVaultId: "v1" });
    await useStore.getState().handleMembershipLost(ORG, "removed");
    expect(secrets.has(VK)).toBe(true);
  });

  it("a vault the account still lists keeps its key (and folder)", async () => {
    api.listOrganizations.mockResolvedValue([{ id: ORG, name: "A" }]);
    await useStore.getState().handleMembershipLost(ORG, "removed");
    expect(secrets.has(VK)).toBe(true);
    expect(ipcMock.deleteDepartedVault).not.toHaveBeenCalled();
  });

  it("a network error on the re-list deletes nothing", async () => {
    api.listOrganizations.mockRejectedValue(new Error("offline"));
    await useStore.getState().handleMembershipLost(ORG, "removed");
    expect(secrets.has(VK)).toBe(true);
    expect(ipcMock.deleteDepartedVault).not.toHaveBeenCalled();
  });

  it("a failed membership-check deletes nothing; a notMember answer does", async () => {
    useStore.setState({ organizations: [] as never });
    localStorage.setItem("context.knownMemberships", JSON.stringify({ [`${SERVER}|u1`]: [ORG] }));
    api.membershipCheck.mockRejectedValueOnce(new Error("offline"));
    await useStore.getState().checkLostMemberships();
    expect(secrets.has(VK)).toBe(true);
    api.membershipCheck.mockResolvedValueOnce({ member: [], notMember: [ORG], unknown: [] });
    await useStore.getState().checkLostMemberships();
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
  });

  it("leave: a refused leave keeps the key; a confirmed one deletes it", async () => {
    api.leaveVault.mockRejectedValueOnce(new Error("409"));
    await expect(useStore.getState().leaveVault(ORG)).rejects.toThrow();
    expect(secrets.has(VK)).toBe(true);
    await useStore.getState().leaveVault(ORG);
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
  });
});

describe("vault gone", () => {
  it("owner delete: key goes only after the server confirms; folder to Trash as before", async () => {
    api.deleteRemoteVault.mockRejectedValueOnce(new Error("forbidden"));
    await expect(useStore.getState().deleteRemoteVault(ORG)).rejects.toThrow();
    expect(secrets.has(VK)).toBe(true);
    await useStore.getState().deleteRemoteVault(ORG);
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
    expect(ipcMock.deleteVault).toHaveBeenCalledWith(PATH);
  });

  it("unsync (make local only): key goes after the server confirms; files untouched", async () => {
    api.unsyncVault.mockRejectedValueOnce(new Error("offline"));
    await expect(useStore.getState().unsyncVault(ORG, "A")).rejects.toThrow();
    expect(secrets.has(VK)).toBe(true);
    await useStore.getState().unsyncVault(ORG, "A");
    expect(vkGone()).toBe(true);
    expect(kept()).toBe(true);
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(ipcMock.deleteDepartedVault).not.toHaveBeenCalled();
  });
});
