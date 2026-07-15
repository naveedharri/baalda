// UI view-state only. The filesystem is never the store's truth — Rust owns
// disk, and the file↔CRDT bridge owns the open note's buffer, echo suppression,
// and autosave. Phase 2/3 adds auth, workspace (org), and sync view-state; the
// heavy lifting lives in lib/auth, lib/sync — the store just mirrors it for React.

import { create } from "zustand";
import * as ipc from "./lib/ipc";
import { bridgeManager } from "./lib/bridge";
import { readItemColors, writeItemColors } from "./lib/appearance";
import { readItemOrder, writeItemOrder, type ItemOrder } from "./lib/ordering";
import {
  ApiError,
  type Invitation,
  type Member,
  type Organization,
  type SessionInfo,
  type Share,
} from "./lib/api";
import { authManager } from "./lib/auth/authManager";
import { syncManager } from "./lib/sync/docSession";
import type { SyncStatus } from "./lib/sync/syncManager";
import { seedWelcomeContent, vaultIsEmpty, WELCOME_NOTE_PATH } from "./lib/vault/seed";

export interface OpenNote {
  path: string;
  /** doc_id from the index — the stable Yjs document id for this note. */
  id: string | null;
  title: string;
}

export type AuthStatus = "unknown" | "signed-out" | "signed-in";

/**
 * A workspace was made active but has no local folder yet. The UI prompts the
 * user to choose one (or start empty) rather than silently reusing whatever
 * folder happened to be open.
 */
export interface PendingWorkspaceFolder {
  orgId: string;
  orgName: string;
  /** Where to switch back to if the user cancels (null if there's nowhere). */
  previousOrgId: string | null;
}

interface AppStore {
  vault: ipc.VaultInfo | null;
  tree: ipc.TreeNode | null;
  openNote: OpenNote | null;
  /** True when the open note's file was deleted out from under us. */
  noteRemoved: boolean;
  backlinks: ipc.Backlink[];
  titles: ipc.NoteTitle[];

  // ---- Auth / workspace / sync ----
  authStatus: AuthStatus;
  session: SessionInfo | null;
  serverUrl: string;
  authError: string | null;
  organizations: Organization[];
  members: Member[];
  pendingInvitations: Invitation[];
  userInvitations: Invitation[];
  syncEnabled: boolean;
  syncStatus: SyncStatus;
  /** When the current doc last reached "synced" — drives "last synced Xm ago". */
  lastSyncedAt: number | null;
  /** Locks (read-only overlays) in the synced vault — drives tree badges. */
  locks: Share[];
  /** Per-item accent colors (vault-local preference), path → color id. */
  itemColors: Record<string, string>;
  /** Custom sidebar arrangement (vault-local preference), parent → child order. */
  itemOrder: ItemOrder;
  /** Set when the active workspace still needs a local folder chosen. */
  pendingWorkspaceFolder: PendingWorkspaceFolder | null;

  setVault: (v: ipc.VaultInfo | null) => void;
  setItemColor: (path: string, colorId: string | null) => void;
  setItemOrder: (order: ItemOrder) => void;
  refreshTree: () => Promise<void>;
  refreshTitles: () => Promise<void>;
  /** First-run seeding for a local (not-yet-synced) empty vault. */
  seedLocalVaultIfEmpty: () => Promise<void>;
  /** Open the root Welcome note if it exists and nothing else is open. */
  openWelcomeIfPresent: () => Promise<void>;

  openNoteByPath: (path: string) => Promise<void>;
  refreshBacklinks: () => Promise<void>;
  setNoteRemoved: (removed: boolean) => void;
  closeNote: () => void;

  // Auth actions
  initAuth: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;

  // Workspace actions
  refreshWorkspace: () => Promise<void>;
  createOrganization: (name: string) => Promise<void>;
  setActiveOrganization: (organizationId: string) => Promise<void>;
  inviteMember: (email: string, role: "member" | "admin") => Promise<void>;
  acceptInvitation: (invitationId: string) => Promise<void>;
  joinWorkspace: (code: string) => Promise<void>;
  /** Detach a workspace from THIS device (forget its folder, stop syncing it).
   *  Server data and membership are untouched — it can be re-opened later. */
  removeWorkspaceLocally: (organizationId: string) => Promise<void>;
  /** Permanently delete a workspace everywhere (owner only), then detach it. */
  deleteWorkspace: (organizationId: string) => Promise<void>;

  // Resolving a workspace's local folder (when none is bound yet)
  /** Bind `path` to `orgId`, open it, and enable sync. */
  applyWorkspaceFolder: (orgId: string, path: string) => Promise<void>;
  /** Native-pick a folder for the pending workspace. */
  chooseWorkspaceFolder: () => Promise<void>;
  /** Create a fresh empty folder under the managed root for the pending workspace. */
  startEmptyWorkspace: () => Promise<void>;
  /** Abandon the pending switch; revert to the previous workspace if any. */
  cancelWorkspaceFolder: () => Promise<void>;

  // Locks (RBAC deny overlay)
  refreshLocks: () => Promise<void>;
  createLock: (
    resourceType: "folder" | "file",
    resourceId: string,
    principalId: string | null,
  ) => Promise<void>;
  removeLock: (shareId: string) => Promise<void>;

  // Sync
  setSyncStatus: (status: SyncStatus) => void;
  enableSyncForVault: () => Promise<void>;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Keep it unique-ish without Date.now (deterministic enough for MVP).
  return base || "workspace";
}

// Each workspace has its own notes, so remember which local folder was last
// used with each workspace and swap to it on switch.
const ORG_VAULTS_KEY = "context.orgVaults";
const LEGACY_ORG_VAULTS_KEY = "opencontext.orgVaults";

/**
 * One-time migration from the old key. The managed root folder was renamed
 * on disk (~/OpenContext → ~/Baalda), so remembered paths pointing at the
 * old root are rewritten to match.
 */
function migrateOrgVaults(): void {
  try {
    if (localStorage.getItem(ORG_VAULTS_KEY) !== null) return;
    const legacy = localStorage.getItem(LEGACY_ORG_VAULTS_KEY);
    if (legacy === null) return;
    const map = JSON.parse(legacy) as Record<string, string>;
    for (const [id, p] of Object.entries(map)) {
      map[id] = p.replace(/\/OpenContext(\/|$)/, "/Baalda$1");
    }
    localStorage.setItem(ORG_VAULTS_KEY, JSON.stringify(map));
    localStorage.removeItem(LEGACY_ORG_VAULTS_KEY);
  } catch {
    /* quota/unavailable — mapping is a convenience only */
  }
}

/** Persisted { orgId → absolute local folder path } binding, one folder per workspace. */
export function readOrgVaults(): Record<string, string> {
  migrateOrgVaults();
  try {
    return JSON.parse(localStorage.getItem(ORG_VAULTS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * A folder name for a workspace that won't collide with a folder already bound
 * to another workspace under the managed root. Deterministic-ish for the MVP.
 */
function uniqueFolderSlug(name: string, bound: Record<string, string>): string {
  const base = slugify(name);
  const taken = new Set(
    Object.values(bound).map((p) => (p.split("/").pop() ?? "").toLowerCase()),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return base;
}

function rememberOrgVault(orgId: string, vaultPath: string): void {
  const map = readOrgVaults();
  // A local folder backs exactly ONE workspace. Claiming it for `orgId` evicts
  // any other workspace previously bound to the same folder — this is what
  // keeps every workspace showing its own notes (and heals legacy state where
  // several workspaces were collapsed onto one folder).
  let changed = false;
  for (const [id, p] of Object.entries(map)) {
    if (id !== orgId && p === vaultPath) {
      delete map[id];
      changed = true;
    }
  }
  if (map[orgId] === vaultPath && !changed) return;
  map[orgId] = vaultPath;
  try {
    localStorage.setItem(ORG_VAULTS_KEY, JSON.stringify(map));
  } catch {
    /* quota/unavailable — mapping is a convenience only */
  }
}

/** Drop a workspace's remembered local folder (used when removing/deleting it). */
function forgetOrgVault(orgId: string): void {
  const map = readOrgVaults();
  if (!(orgId in map)) return;
  delete map[orgId];
  try {
    localStorage.setItem(ORG_VAULTS_KEY, JSON.stringify(map));
  } catch {
    /* quota/unavailable — mapping is a convenience only */
  }
}

export const useStore = create<AppStore>((set, get) => ({
  vault: null,
  tree: null,
  openNote: null,
  noteRemoved: false,
  backlinks: [],
  titles: [],

  authStatus: "unknown",
  session: null,
  serverUrl: authManager.getServerUrl(),
  authError: null,
  organizations: [],
  members: [],
  pendingInvitations: [],
  userInvitations: [],
  syncEnabled: false,
  syncStatus: "offline",
  lastSyncedAt: null,
  locks: [],
  itemColors: {},
  itemOrder: {},
  pendingWorkspaceFolder: null,

  setVault: (v) =>
    set({
      vault: v,
      itemColors: readItemColors(v?.path),
      itemOrder: readItemOrder(v?.path),
    }),

  setItemColor: (path, colorId) => {
    const vault = get().vault;
    if (!vault) return;
    const next = { ...get().itemColors };
    if (colorId) next[path] = colorId;
    else delete next[path];
    writeItemColors(vault.path, next);
    set({ itemColors: next });
  },

  setItemOrder: (order) => {
    const vault = get().vault;
    if (!vault) return;
    writeItemOrder(vault.path, order);
    set({ itemOrder: order });
  },

  refreshTree: async () => {
    const tree = await ipc.listTree();
    set({ tree });
  },

  refreshTitles: async () => {
    const titles = await ipc.listNoteTitles();
    set({ titles });
  },

  seedLocalVaultIfEmpty: async () => {
    // First-run welcome content for an empty, local-only vault (opened while
    // signed out, or a folder opened directly without sync). When signed in,
    // the sync reconcile seeds instead — so the notes register on the server —
    // hence the syncEnabled guard here to avoid seeding twice.
    if (get().syncEnabled) return;
    const tree = get().tree;
    if (!tree || !vaultIsEmpty(tree)) return;
    const welcomePath = await seedWelcomeContent();
    await get().refreshTree();
    await get().refreshTitles();
    if (welcomePath) await get().openNoteByPath(welcomePath);
  },

  openWelcomeIfPresent: async () => {
    // Land a freshly signed-in user on the Welcome note — but never yank them
    // away from a note they already have open.
    if (get().openNote) return;
    const hasWelcome = get().titles.some((t) => t.path === WELCOME_NOTE_PATH);
    if (hasWelcome) await get().openNoteByPath(WELCOME_NOTE_PATH);
  },

  openNoteByPath: async (path) => {
    const meta = await ipc.getNoteMeta(path);
    const title = meta?.title ?? path.split("/").pop() ?? path;
    // Ensure the note is registered server-side BEFORE the editor opens it, so
    // its doc_id is known and the sync provider connects on first open.
    // Only markdown notes sync — HTML pages are local files rendered in-app.
    if (get().syncEnabled && path.toLowerCase().endsWith(".md")) {
      try {
        await syncManager.registry.registerNote(path, title);
      } catch (e) {
        console.warn("[sync] registerNote failed", e);
      }
    }
    set({
      openNote: { path, id: meta?.id ?? null, title },
      noteRemoved: false,
    });
    await get().refreshBacklinks();
  },

  refreshBacklinks: async () => {
    const note = get().openNote;
    if (!note?.id) {
      set({ backlinks: [] });
      return;
    }
    try {
      const backlinks = await ipc.getBacklinks(note.id);
      set({ backlinks });
    } catch {
      set({ backlinks: [] });
    }
  },

  setNoteRemoved: (removed) => set({ noteRemoved: removed }),

  closeNote: () => set({ openNote: null, backlinks: [], noteRemoved: false }),

  // ---- Auth ----

  initAuth: async () => {
    syncManager.setStatusListener((status) => get().setSyncStatus(status));
    try {
      const session = await authManager.init();
      set({ serverUrl: authManager.getServerUrl() });
      if (session) {
        set({ session, authStatus: "signed-in", authError: null });
        await get().refreshWorkspace();
        await get().enableSyncForVault();
      } else {
        set({ session: null, authStatus: "signed-out" });
      }
    } catch (e) {
      set({ authStatus: "signed-out", authError: errMsg(e) });
    }
  },

  signIn: async (email, password) => {
    set({ authError: null });
    try {
      await authManager.signIn({ email, password });
      const session = await authManager.currentSession();
      set({ session, authStatus: session ? "signed-in" : "signed-out" });
      if (session) {
        await get().refreshWorkspace();
        await get().enableSyncForVault();
        await get().openWelcomeIfPresent();
      }
    } catch (e) {
      set({ authError: errMsg(e) });
      throw e;
    }
  },

  signInWithGoogle: async () => {
    set({ authError: null });
    try {
      await authManager.signInWithGoogle();
      const session = await authManager.currentSession();
      set({ session, authStatus: session ? "signed-in" : "signed-out" });
      if (session) {
        await get().refreshWorkspace();
        await get().enableSyncForVault();
        await get().openWelcomeIfPresent();
      }
    } catch (e) {
      set({ authError: errMsg(e) });
      throw e;
    }
  },

  signUp: async (name, email, password) => {
    set({ authError: null });
    try {
      await authManager.signUp({ name, email, password });
      const session = await authManager.currentSession();
      set({ session, authStatus: session ? "signed-in" : "signed-out" });
      if (session) await get().refreshWorkspace();
    } catch (e) {
      set({ authError: errMsg(e) });
      throw e;
    }
  },

  signOut: async () => {
    // Flush any debounced local write first so tearing down the view can't drop
    // an in-flight edit (the .md files stay on disk regardless of the account).
    try {
      await bridgeManager.currentBridge()?.flushEgest();
    } catch (err) {
      console.error("flush before sign-out failed", err);
    }
    await authManager.signOut();
    syncManager.disable();
    set({
      session: null,
      authStatus: "signed-out",
      organizations: [],
      members: [],
      pendingInvitations: [],
      userInvitations: [],
      syncEnabled: false,
      syncStatus: "offline",
      locks: [],
      pendingWorkspaceFolder: null,
      // Close the open vault so the app returns to the VaultPicker "home" screen
      // (choose / reopen a vault) instead of leaving the old workspace's files
      // on screen after sign-out.
      vault: null,
      tree: null,
      openNote: null,
      backlinks: [],
      noteRemoved: false,
      itemColors: readItemColors(undefined),
      itemOrder: readItemOrder(undefined),
    });
  },

  setServerUrl: async (url) => {
    set({ authError: null });
    const session = await authManager.setServerUrl(url);
    set({
      serverUrl: authManager.getServerUrl(),
      session,
      authStatus: session ? "signed-in" : "signed-out",
    });
    if (session) {
      await get().refreshWorkspace();
      await get().enableSyncForVault();
    } else {
      syncManager.disable();
      set({ syncEnabled: false });
    }
  },

  // ---- Workspace ----

  refreshWorkspace: async () => {
    const { api } = authManager;
    try {
      const organizations = await api.listOrganizations();
      const session = get().session;
      let activeOrgId = session?.activeOrganizationId ?? null;
      // Auto-activate the sole org so vault creation + sync work out of the box.
      if (!activeOrgId && organizations.length === 1) {
        await api.setActiveOrganization(organizations[0].id);
        activeOrgId = organizations[0].id;
        const refreshed = await authManager.currentSession();
        if (refreshed) set({ session: refreshed });
      }
      let members: Member[] = [];
      let pendingInvitations: Invitation[] = [];
      if (activeOrgId) {
        members = await api.listMembers(activeOrgId).catch(() => []);
        pendingInvitations = await api
          .listInvitations(activeOrgId)
          .then((invs) => invs.filter((i) => i.status === "pending"))
          .catch(() => []);
      }
      const userInvitations = await api
        .listUserInvitations()
        .then((invs) => invs.filter((i) => i.status === "pending"))
        .catch(() => []);
      set({ organizations, members, pendingInvitations, userInvitations });
    } catch (e) {
      set({ authError: errMsg(e) });
    }
  },

  createOrganization: async (name) => {
    const org = await authManager.api.createOrganization({ name, slug: slugify(name) });
    // Route through the switch path so a brand-new workspace prompts for its
    // own folder instead of adopting whatever folder is currently open.
    await get().setActiveOrganization(org.id);
  },

  setActiveOrganization: async (organizationId) => {
    const previousOrgId = get().session?.activeOrganizationId ?? null;

    // Re-assert that the workspace we're leaving solely owns its open folder,
    // evicting any other workspace still bound to it (this is what heals legacy
    // state where several workspaces collapsed onto one folder). Only do this
    // when that workspace ACTUALLY owns the open folder — if we're leaving a
    // workspace that never got its own folder (still on the pending prompt),
    // the visible folder belongs to a *different* workspace, so touching the
    // binding here would wrongly steal it (and break Cancel → previous).
    const currentVaultPath = get().vault?.path ?? null;
    if (
      previousOrgId &&
      currentVaultPath &&
      previousOrgId !== organizationId &&
      readOrgVaults()[previousOrgId] === currentVaultPath
    ) {
      rememberOrgVault(previousOrgId, currentVaultPath);
    }

    await authManager.api.setActiveOrganization(organizationId);
    const session = await authManager.currentSession();
    set({ session });
    await get().refreshWorkspace();

    // Each workspace owns its own local folder. If one is already bound, swap
    // to it. If not, do NOT reuse the folder that's currently open — ask the
    // user to choose one (or start empty) via the pending-folder prompt.
    const path = readOrgVaults()[organizationId];
    if (path) {
      try {
        await get().applyWorkspaceFolder(organizationId, path);
      } catch (e) {
        console.warn("[workspace] folder swap failed", e);
      }
      return;
    }
    const org = get().organizations.find((o) => o.id === organizationId);
    set({
      syncEnabled: false,
      pendingWorkspaceFolder: {
        orgId: organizationId,
        orgName: org?.name ?? "New workspace",
        previousOrgId: previousOrgId === organizationId ? null : previousOrgId,
      },
    });
  },

  inviteMember: async (email, role) => {
    const activeOrgId = get().session?.activeOrganizationId ?? undefined;
    await authManager.api.inviteMember({ email, role, organizationId: activeOrgId });
    await get().refreshWorkspace();
  },

  acceptInvitation: async (invitationId) => {
    const inv = get().userInvitations.find((i) => i.id === invitationId);
    await authManager.api.acceptInvitation(invitationId);
    // Make the joined workspace active through the switch path so it gets its
    // own folder (prompted) rather than adopting the currently-open folder.
    if (inv?.organizationId) {
      await get().setActiveOrganization(inv.organizationId);
    } else {
      const session = await authManager.currentSession();
      set({ session });
      await get().refreshWorkspace();
    }
  },

  joinWorkspace: async (code) => {
    const joined = await authManager.api.joinWorkspace(code.trim());
    await get().setActiveOrganization(joined.organizationId);
  },

  removeWorkspaceLocally: async (organizationId) => {
    // Forget this workspace's local folder so it won't auto-open here again.
    forgetOrgVault(organizationId);
    // If we're removing the workspace that's currently open, move off it: swap
    // to another workspace if one exists, otherwise close the vault and stop
    // syncing (the workspace itself stays on the server — this device just
    // detaches from it).
    if (get().session?.activeOrganizationId === organizationId) {
      const next = get().organizations.find((o) => o.id !== organizationId);
      if (next) {
        await get().setActiveOrganization(next.id);
      } else {
        syncManager.disable();
        get().closeNote();
        set({
          vault: null,
          locks: [],
          syncEnabled: false,
          syncStatus: "offline",
          pendingWorkspaceFolder: null,
        });
      }
    }
    await get().refreshWorkspace();
  },

  deleteWorkspace: async (organizationId) => {
    // Permanent, server-side, owner-only. 403s here if the caller isn't owner.
    await authManager.api.deleteWorkspace(organizationId);
    // Then tear down the same local state as a device-level removal.
    await get().removeWorkspaceLocally(organizationId);
  },

  // ---- Workspace folder resolution ----

  applyWorkspaceFolder: async (orgId, path) => {
    const v = await ipc.openWorkspaceFolder(path);
    get().closeNote();
    set({
      vault: v,
      locks: [],
      itemColors: readItemColors(v.path),
      itemOrder: readItemOrder(v.path),
      pendingWorkspaceFolder: null,
    });
    rememberOrgVault(orgId, v.path);
    await get().refreshTree();
    await get().refreshTitles();
    await get().enableSyncForVault();
  },

  chooseWorkspaceFolder: async () => {
    const pending = get().pendingWorkspaceFolder;
    if (!pending) return;
    const picked = await ipc.pickFolder();
    if (!picked) return; // cancelled the native dialog — keep the prompt up
    await get().applyWorkspaceFolder(pending.orgId, picked);
  },

  startEmptyWorkspace: async () => {
    const pending = get().pendingWorkspaceFolder;
    if (!pending) return;
    const root = await ipc.getWorkspaceRoot();
    const slug = uniqueFolderSlug(pending.orgName, readOrgVaults());
    await get().applyWorkspaceFolder(pending.orgId, `${root}/${slug}`);
  },

  cancelWorkspaceFolder: async () => {
    const pending = get().pendingWorkspaceFolder;
    set({ pendingWorkspaceFolder: null });
    if (pending?.previousOrgId) {
      await get().setActiveOrganization(pending.previousOrgId);
    }
  },

  // ---- Locks ----

  refreshLocks: async () => {
    const vaultId = syncManager.registry.vaultId;
    if (!vaultId || !get().syncEnabled) {
      set({ locks: [] });
      return;
    }
    try {
      const locks = await authManager.api.listVaultLocks(vaultId);
      set({ locks });
    } catch (e) {
      console.warn("[locks] refresh failed", e);
      set({ locks: [] });
    }
  },

  createLock: async (resourceType, resourceId, principalId) => {
    await authManager.api.createShare({
      resourceType,
      resourceId,
      permission: "locked",
      ...(principalId
        ? { principalType: "user" as const, principalId }
        : { principalType: "org" as const }),
    });
    await get().refreshLocks();
  },

  removeLock: async (shareId) => {
    await authManager.api.revokeShare(shareId);
    await get().refreshLocks();
  },

  // ---- Sync ----

  setSyncStatus: (status) =>
    set(
      status === "synced"
        ? { syncStatus: status, lastSyncedAt: Date.now() }
        : { syncStatus: status },
    ),

  enableSyncForVault: async () => {
    const { session, vault } = get();
    if (!session || !vault) {
      set({ syncEnabled: false });
      return;
    }
    if (!session.activeOrganizationId) {
      set({ syncEnabled: false });
      return;
    }
    // Registry reconcile needs the tree; make sure it's loaded.
    let tree = get().tree;
    if (!tree) {
      await get().refreshTree();
      tree = get().tree;
    }
    if (!tree) {
      set({ syncEnabled: false });
      return;
    }
    const result = await syncManager.enable(session, tree, vault.name);
    set({ syncEnabled: result.ok });
    if (result.ok) {
      // This folder is now the one this workspace opens with.
      if (session.activeOrganizationId) {
        rememberOrgVault(session.activeOrganizationId, vault.path);
      }
      // Reconcile may have materialized server-only notes onto disk; refresh so
      // the sidebar reflects the full workspace, not just what was already local.
      await get().refreshTree();
      await get().refreshTitles();
      await get().refreshLocks();
      // A brand-new workspace was just seeded with welcome content — greet the
      // user with the welcome note if nothing else is open.
      if (result.seeded && !get().openNote) {
        await get().openNoteByPath(WELCOME_NOTE_PATH);
      }
    } else {
      set({ locks: [] });
      if (result.reason) console.warn("[sync] not enabled:", result.reason);
    }
  },
}));

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
