// The boot contract, at the store level: what may run detached, what must not
// land late, and what a click during the window is allowed to do.
//
// The launch used to be one serial chain with the whole UI behind it. Now the
// tree paints first and `initAuth` runs detached, which creates two hazards this
// suite pins:
//
//   1. a session restore that finishes AFTER the user signed out (or in as
//      someone else) must drop its state instead of re-landing it;
//   2. a note clicked before sync has primed must WAIT for the prime rather than
//      opening a mapped note with no provider (which seeds it from disk — the
//      split-brain reversal `decideSeed` forbids).
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `versionStore.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(async () => [] as unknown[]),
  setActiveOrganization: vi.fn(async () => {}),
  listMembers: vi.fn(async () => [] as unknown[]),
  listInvitations: vi.fn(async () => [] as unknown[]),
  listUserInvitations: vi.fn(async () => [] as unknown[]),
  getBillingConfig: vi.fn(async () => ({ enabled: false })),
  getOrgBilling: vi.fn(async () => null),
  listVaults: vi.fn(async () => [] as unknown[]),
  listVaultLocks: vi.fn(async () => [] as unknown[]),
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
  registry: {
    vaultId: null as string | null,
    getMapping: () => null,
    registerNote: vi.fn(async () => null),
  },
  /** What `openNoteByPath`'s gate consults. */
  syncable: false,
  isSyncable: vi.fn(() => sync.syncable),
  enable: vi.fn(
    async (
      _session: unknown,
      _vault: unknown,
      hooks?: { onPrimed?: () => void },
    ): Promise<{ ok: boolean }> => {
      hooks?.onPrimed?.();
      return { ok: true };
    },
  ),
  disable: vi.fn(),
  setViewing: vi.fn(),
  setPresenceStatus: vi.fn(),
  handleRegistryChanged: vi.fn(),
  setStatusListener: vi.fn(),
  setActivityListeners: vi.fn(),
  setRegistryListener: vi.fn(),
  setAclListener: vi.fn(),
  setInboundListeners: vi.fn(),
  setMemberJoinedListener: vi.fn(),
  setVaultPresenceListener: vi.fn(),
  setVoiceListener: vi.fn(),
  setSyncProgressListener: vi.fn(),
  setDocStateListener: vi.fn(),
  setRegistryMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
  setColorListener: vi.fn(),
  announcePresence: vi.fn(),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

vi.mock("../lib/bridge", () => ({
  bridgeManager: { currentBridge: () => null },
}));

vi.mock("../lib/ipc", () => ({
  isVaultMismatch: () => false,
  peekVaultStamp: vi.fn(async () => null),
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
  listNoteTitles: vi.fn(async () => []),
  clearLastVault: vi.fn(async () => {}),
  getVaultEpoch: vi.fn(async () => 1),
}));

import type { VaultInfo } from "../lib/ipc";
import { useStore } from "../store";

const ORG = "org-a";

function session(orgId: string | null = ORG) {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: orgId,
  } as never;
}

function vault(): VaultInfo {
  return { path: "/vaults/a", name: "a", epoch: 1 } as VaultInfo;
}

/** A deferred promise, to park an async step mid-flight. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncable = false;
  sync.isSyncable.mockImplementation(() => sync.syncable);
  sync.enable.mockImplementation(async (_s, _v, hooks) => {
    hooks?.onPrimed?.();
    return { ok: true };
  });
  authManager.init.mockResolvedValue(null);
  api.listOrganizations.mockResolvedValue([]);
  api.getBillingConfig.mockResolvedValue({ enabled: false });
  useStore.setState({
    vault: null,
    session: null,
    authStatus: "unknown",
    authError: null,
    syncEnabled: false,
    organizations: [],
    openNote: null,
    openingNotePath: null,
    openFolderIsSynced: null,
    tree: null,
  });
});

describe("initAuth — detached, so it must never land late", () => {
  it("drops its restore when the user has signed out meanwhile", async () => {
    // The launch fires `initAuth` without awaiting it. A user who hits Sign out
    // during the restore owns the resulting state; the restore landing on top
    // would silently sign them back in.
    const held = gate();
    authManager.init.mockImplementation(async () => {
      await held.waited;
      return session();
    });
    api.listOrganizations.mockResolvedValue([{ id: ORG, name: "A" }]);

    const restoring = useStore.getState().initAuth();
    await flush();

    await useStore.getState().signOut();
    expect(useStore.getState().authStatus).toBe("signed-out");

    held.open();
    await restoring;
    await flush();

    expect(useStore.getState().session).toBeNull();
    expect(useStore.getState().authStatus).toBe("signed-out");
    expect(useStore.getState().organizations).toEqual([]);
  });
});

describe("enableSyncForVault — background returns at the prime", () => {
  it("resolves as soon as sync primes, with syncEnabled on", async () => {
    // This is what un-gates the landing: `enable` runs the reconcile (minutes on
    // a large vault) but the caller only needs the prime to consider the vault
    // usable.
    const held = gate();
    sync.enable.mockImplementation(async (_s, _v, hooks) => {
      hooks?.onPrimed?.();
      await held.waited;
      return { ok: true };
    });
    useStore.setState({ session: session(), vault: vault() });

    await useStore.getState().enableSyncForVault({ background: true });

    // Returned while `enable` is still parked in the reconcile.
    expect(useStore.getState().syncEnabled).toBe(true);
    held.open();
    await flush();
  });

  it("waits for the whole enable when NOT in background (turn-on-sync)", async () => {
    // `turnOnSyncForCurrentVault` reads `syncEnabled` the moment this resolves,
    // and a brand-new vault has no config to prime from — so the foreground
    // contract has to stay "resolves when the enable settles".
    const held = gate();
    let settled = false;
    sync.enable.mockImplementation(async (_s, _v, hooks) => {
      hooks?.onPrimed?.();
      await held.waited;
      settled = true;
      return { ok: true };
    });
    useStore.setState({ session: session(), vault: vault() });

    let returned = false;
    const enabling = useStore
      .getState()
      .enableSyncForVault()
      .then(() => {
        returned = true;
      });
    await flush();
    expect(returned).toBe(false);

    held.open();
    await enabling;
    expect(settled).toBe(true);
    expect(useStore.getState().syncEnabled).toBe(true);
  });
});

describe("openNoteByPath — the gate that keeps a first click safe", () => {
  it("waits for the prime on a folder known to be synced", async () => {
    // The hazard: no provider + `seedFromFile: true` on a note the server has.
    // The click is acknowledged immediately (the row highlights), but the open
    // itself holds until sync can map the note.
    useStore.setState({ session: session(), authStatus: "signed-in" });
    // Through `setVault`, because that is what ARMS the gate — opening a folder
    // is the moment we stop knowing anything about its sync.
    useStore.getState().setVault(vault());
    useStore.setState({ openFolderIsSynced: true });

    const opening = useStore.getState().openNoteByPath("a.md");
    await flush();

    // Acknowledged, not yet open.
    expect(useStore.getState().openingNotePath).toBe("a.md");
    expect(useStore.getState().openNote).toBeNull();

    // The prime lands (this is what `onPrimed` does in `enableSyncForVault`).
    sync.syncable = true;
    await useStore.getState().enableSyncForVault({ background: true });
    await opening;

    expect(useStore.getState().openNote?.path).toBe("a.md");
    expect(useStore.getState().openingNotePath).toBeNull();
  });

  it("opens immediately in a folder that is not synced", async () => {
    useStore.setState({
      session: null,
      vault: vault(),
      authStatus: "signed-out",
      openFolderIsSynced: false,
    });

    await useStore.getState().openNoteByPath("a.md");

    expect(useStore.getState().openNote?.path).toBe("a.md");
  });
});
