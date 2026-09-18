// "Make this vault local only", at the store level.
//
// Two rules carry the whole feature, and both are easy to break by reordering
// four lines:
//
//   1. **Server first.** A refusal — 403 `owner_only`, a 409 `name_mismatch`, the
//      502 a billing provider produces when it won't cancel, or simply being
//      offline — must leave this device EXACTLY as it was. The vault still
//      exists; pretending otherwise strands a live vault as a local folder.
//   2. **The stamp must be cleared, and nothing on disk may be touched.** Leave
//      `.context/config.json` naming the dead org and `planTurnOnSync` answers
//      `blocked-foreign` forever — the folder can never sync again. Delete
//      anything and the user loses the notes they were promised they'd keep.
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `bootStore.test.ts`.

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
  deleteVault: vi.fn(async () => {}),
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
import { readOrgVaults, useStore } from "../store";

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

function vault(): VaultInfo {
  return { path: PATH, name: "a", epoch: 1 } as VaultInfo;
}

let storage: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  storage = installStorage({
    "context.orgVaults": JSON.stringify({ [ORG]: PATH }),
    "context.lastVault": ORG,
  });
  api.listOrganizations.mockResolvedValue([]);
  api.unsyncVault.mockResolvedValue({
    unsynced: true,
    notes: 12,
    files: 3,
    members: 2,
    subscription: null,
  });
  useStore.setState({
    vault: vault(),
    session: {
      user: { id: "u1", name: "Ann", email: "ann@example.com" },
      activeOrganizationId: ORG,
    } as never,
    authStatus: "signed-in",
    organizations: [{ id: ORG, name: "A" }] as never,
    members: [{ userId: "u1", role: "owner" }] as never,
    syncEnabled: true,
    openFolderIsSynced: true,
    vaultUnsynced: null,
    tree: null,
  });
});

describe("unsyncVault — the server is the gate", () => {
  it("changes NOTHING on this device when the server refuses", async () => {
    // 502 `subscription_cancel_failed` is the real one: the provider wouldn't
    // cancel, so the server deleted nothing at all.
    api.unsyncVault.mockRejectedValue(new Error("subscription_cancel_failed"));

    await expect(useStore.getState().unsyncVault(ORG, "A")).rejects.toThrow(
      "subscription_cancel_failed",
    );

    expect(ipcMock.setVaultConfig).not.toHaveBeenCalled();
    expect(sync.disable).not.toHaveBeenCalled();
    // The binding and the last-vault pointer both survive: the vault is alive.
    expect(readOrgVaults()).toEqual({ [ORG]: PATH });
    expect(storage["context.lastVault"]).toBe(ORG);
    expect(useStore.getState().syncEnabled).toBe(true);
    expect(useStore.getState().openFolderIsSynced).toBe(true);
  });

  it("does not ask the server twice for a name that doesn't match", async () => {
    // The confirm gate is client-side, but the name we send is the vault's own
    // — the server re-checks it and answers 409, which must propagate untouched.
    const err = Object.assign(new Error("name_mismatch"), { status: 409 });
    api.unsyncVault.mockRejectedValue(err);
    await expect(useStore.getState().unsyncVault(ORG, "wrong")).rejects.toThrow(
      "name_mismatch",
    );
    expect(api.unsyncVault).toHaveBeenCalledTimes(1);
    expect(ipcMock.setVaultConfig).not.toHaveBeenCalled();
  });
});

describe("unsyncVault — the local teardown", () => {
  it("clears the stamp to a config with no sync identity at all", async () => {
    await useStore.getState().unsyncVault(ORG, "A");

    expect(ipcMock.setVaultConfig).toHaveBeenCalledTimes(1);
    const [raw, epoch] = ipcMock.setVaultConfig.mock.calls[0] as unknown as [string, number];
    // Pinned to the vault epoch, like every other write: a stale write must fail
    // rather than land in whatever folder is open by then.
    expect(epoch).toBe(1);
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    // Everything that could re-bind this folder, or confuse a LATER vault about
    // what is already pushed, is gone. `baseline` in particular: a surviving one
    // is exactly the cross-vault confusion `registry.reset()` exists to prevent.
    for (const key of [
      "organizationId",
      "serverVaultId",
      "docs",
      "folders",
      "files",
      "pushed",
      "baseline",
      "authored",
      "bootstrap",
    ]) {
      expect(cfg).not.toHaveProperty(key);
    }
    // What IS left is a tombstone, for support transcripts only.
    expect(cfg.unsyncedFrom).toBe(ORG);
    expect(typeof cfg.unsyncedAt).toBe("string");
  });

  it("stops sync, forgets the binding, and flips the vault to Local", async () => {
    await useStore.getState().unsyncVault(ORG, "A");

    expect(sync.disable).toHaveBeenCalled();
    expect(readOrgVaults()).toEqual({});
    expect(storage["context.lastVault"]).toBeUndefined();

    const s = useStore.getState();
    // Still IN the folder — this is not "remove from device".
    expect(s.vault?.path).toBe(PATH);
    // Not null: we know the answer, and a local folder's gate must not wait.
    expect(s.openFolderIsSynced).toBe(false);
    expect(s.syncEnabled).toBe(false);
    expect(s.members).toEqual([]);
    expect(s.orgBilling).toBeNull();
  });

  it("never touches a single file on disk", async () => {
    await useStore.getState().unsyncVault(ORG, "A");
    // The whole promise of the feature: the notes, `attachments/`, the SQLite
    // index (CRDT log included) and `.context/trash` all stay exactly where the
    // user left them.
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(ipcMock.clearLastVault).not.toHaveBeenCalled();
  });

  it("leaves a vault that is NOT the open folder alone locally", async () => {
    // Unsyncing another vault from the Vaults tab: its stamp lives in ITS
    // folder, so writing this one's config would tombstone the wrong vault, and
    // disabling sync would stop the vault the user is actually working in.
    storage["context.orgVaults"] = JSON.stringify({ [ORG]: PATH, "org-b": "/vaults/b" });
    await useStore.getState().unsyncVault("org-b", "B");

    expect(ipcMock.setVaultConfig).not.toHaveBeenCalled();
    expect(sync.disable).not.toHaveBeenCalled();
    expect(readOrgVaults()).toEqual({ [ORG]: PATH });
    expect(useStore.getState().openFolderIsSynced).toBe(true);
  });
});

describe("checkUnsyncedVaultStamp — the other-device path", () => {
  it("raises the banner when the server says the stamped vault is gone", async () => {
    useStore.setState({ organizations: [] });
    api.getOrgStatus.mockResolvedValue({ kind: "vault-not-found" });

    await useStore.getState().checkUnsyncedVaultStamp();

    expect(useStore.getState().vaultUnsynced).toEqual({
      organizationId: ORG,
      path: PATH,
    });
  });

  it("stays silent when the vault is merely someone else's", async () => {
    useStore.setState({ organizations: [] });
    api.getOrgStatus.mockResolvedValue({ kind: "not-a-member" });

    await useStore.getState().checkUnsyncedVaultStamp();

    expect(useStore.getState().vaultUnsynced).toBeNull();
  });

  it("stays silent, and off the network, for a vault we are still in", async () => {
    await useStore.getState().checkUnsyncedVaultStamp();

    expect(api.getOrgStatus).not.toHaveBeenCalled();
    expect(useStore.getState().vaultUnsynced).toBeNull();
  });

  it("stays silent when the server can't be reached", async () => {
    useStore.setState({ organizations: [] });
    api.getOrgStatus.mockResolvedValue({ kind: "unknown" });

    await useStore.getState().checkUnsyncedVaultStamp();

    expect(useStore.getState().vaultUnsynced).toBeNull();
  });
});

describe("keepUnsyncedVaultLocal — the banner's accept", () => {
  it("clears the stamp and the binding without touching a file", async () => {
    useStore.setState({ vaultUnsynced: { organizationId: ORG, path: PATH } });

    await useStore.getState().keepUnsyncedVaultLocal();

    expect(ipcMock.setVaultConfig).toHaveBeenCalledTimes(1);
    expect(ipcMock.deleteVault).not.toHaveBeenCalled();
    expect(readOrgVaults()).toEqual({});
    expect(useStore.getState().vaultUnsynced).toBeNull();
    expect(useStore.getState().openFolderIsSynced).toBe(false);
  });
});
