// UI view-state only. The filesystem is never the store's truth — Rust owns
// disk, and the file↔CRDT bridge owns the open note's buffer, echo suppression,
// and autosave. Phase 2/3 adds auth, vault (org), and sync view-state; the
// heavy lifting lives in lib/auth, lib/sync — the store just mirrors it for React.

import { create } from "zustand";
import * as ipc from "./lib/ipc";
import { bridgeManager } from "./lib/bridge";
import { readItemColors, writeItemColors } from "./lib/appearance";
import { readItemOrder, writeItemOrder, type ItemOrder } from "./lib/ordering";
import {
  ApiError,
  type BillingConfig,
  type Invitation,
  type Member,
  type OrgBilling,
  type Organization,
  type SessionInfo,
  type Share,
} from "./lib/api";
import { authManager } from "./lib/auth/authManager";
import { syncManager } from "./lib/sync/docSession";
import type { SyncStatus } from "./lib/sync/syncManager";
import type { VaultPeer } from "./lib/sync/vaultSyncEngine";
import { createWithUniqueSlug, slugifyName } from "./lib/orgSlug";
import {
  type ActivityStatus,
  readActivityStatus,
  readMentionSound,
  writeActivityStatus,
  writeMentionSound,
} from "./lib/prefs";
import { seedWelcomeContent, vaultIsEmpty, WELCOME_NOTE_PATH } from "./lib/vault/seed";
import { playJoinChime } from "./lib/celebrate/celebrate";

export interface OpenNote {
  path: string;
  /** doc_id from the index — the stable Yjs document id for this note. */
  id: string | null;
  title: string;
}

export type AuthStatus = "unknown" | "signed-out" | "signed-in";

/**
 * A vault was made active but has no local folder yet. The UI prompts the
 * user to choose one (or start empty) rather than silently reusing whatever
 * folder happened to be open.
 */
export interface PendingVaultFolder {
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

  // ---- Auth / vault / sync ----
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
  /** When the current doc last flushed all changes to the server — drives
   *  "Synced · just now". Bumped on every server ack, not just initial sync. */
  lastSyncedAt: number | null;
  /** True while the open note has local edits not yet acked by the server
   *  (drives the "Saving…" badge state). */
  syncPending: boolean;
  /** Locks (read-only overlays) in the synced vault — drives tree badges. */
  locks: Share[];
  /** Live "who's viewing what" roster (teammates only) — drives the sidebar
   *  presence dots on notes/folders. Empty when sync is off or disconnected. */
  vaultPresence: VaultPeer[];
  /** Per-item accent colors (vault-local preference), path → color id. */
  itemColors: Record<string, string>;
  /** Custom sidebar arrangement (vault-local preference), parent → child order. */
  itemOrder: ItemOrder;
  /** Set when the active vault still needs a local folder chosen. */
  pendingVaultFolder: PendingVaultFolder | null;

  // ---- Billing (subscription) ----
  /** Server billing capability; null until first probed. `enabled === false`
   *  (self-host / older server) means the whole billing UI stays hidden. */
  billingConfig: BillingConfig | null;
  /** The active vault's subscription state + seat usage; null when unknown. */
  orgBilling: OrgBilling | null;

  // ---- Account-level preferences (follow the app, not any vault) ----
  /** The user's chosen activity status; broadcast to teammates via presence. */
  activityStatus: ActivityStatus;
  /** Whether the mention chime plays when someone pings you. */
  mentionSound: boolean;
  /** Set briefly when a teammate joins the vault, to drive the celebration
   *  banner + confetti. `at` changes each time so a repeat join re-triggers it. */
  memberJoined: { name: string; at: number } | null;

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

  // Account profile & preferences
  /** Update display name / avatar (server-backed; refreshes the session). */
  updateProfile: (input: { name?: string; image?: string | null }) => Promise<void>;
  setActivityStatus: (status: ActivityStatus) => void;
  setMentionSound: (enabled: boolean) => void;
  /** A teammate joined — show the celebration (banner + confetti + chime). */
  celebrateMemberJoined: (name: string) => void;
  /** Dismiss the join celebration (auto-fires after a few seconds). */
  dismissMemberJoined: () => void;

  // Vault actions
  refreshVault: () => Promise<void>;
  createOrganization: (name: string) => Promise<void>;
  /** Promote the currently-open local folder into a synced vault, adopting
   *  the files already in it (no new empty folder). This is "Turn on sync". */
  turnOnSyncForCurrentVault: (name?: string) => Promise<void>;
  setActiveOrganization: (organizationId: string) => Promise<void>;
  inviteMember: (email: string, role: "member" | "admin") => Promise<void>;
  /** Remove a member from the active vault (owner/admin), then refresh. */
  removeMember: (userId: string) => Promise<void>;
  acceptInvitation: (invitationId: string) => Promise<void>;
  joinVault: (code: string) => Promise<void>;
  /** Detach a vault from THIS device (forget its folder, stop syncing it).
   *  Server data and membership are untouched — it can be re-opened later. */
  removeVaultLocally: (organizationId: string) => Promise<void>;
  /** Permanently delete a vault everywhere (owner only), then detach it. */
  deleteRemoteVault: (organizationId: string) => Promise<void>;

  /** Open a plain local folder as the current (unsynced) vault — leaving any
   *  synced vault's sync context behind. Used by the switcher's local rows
   *  and "Open a folder…". */
  openLocalVault: (path: string) => Promise<void>;
  /** Forget a local vault from this device's list. The folder and its `.md`
   *  files stay on disk — it can be re-opened later. */
  removeLocalVault: (path: string) => Promise<void>;
  /** Move a local vault's folder (and all its notes) to the OS trash, then
   *  forget it. Destructive — there's no server copy, the on-disk files are the
   *  only copy. */
  deleteLocalVault: (path: string) => Promise<void>;
  /** Detach from the open local folder and drop to the empty/welcome state. */
  closeLocalVault: () => void;

  // Resolving a vault's local folder (when none is bound yet)
  /** Bind `path` to `orgId`, open it, and enable sync. */
  applyVaultFolder: (orgId: string, path: string) => Promise<void>;
  /** Native-pick a folder for the pending vault. */
  chooseVaultFolder: () => Promise<void>;
  /** Create a fresh empty folder under the managed root for the pending vault. */
  startEmptyVault: () => Promise<void>;
  /** Abandon the pending switch; revert to the previous vault if any. */
  cancelVaultFolder: () => Promise<void>;

  // Locks (RBAC deny overlay)
  refreshLocks: () => Promise<void>;
  createLock: (
    resourceType: "folder" | "file",
    resourceId: string,
    principalId: string | null,
  ) => Promise<void>;
  removeLock: (shareId: string) => Promise<void>;

  // Billing
  /** Re-probe server billing capability (on start/sign-in/server change). */
  refreshBillingConfig: () => Promise<void>;
  /** Refresh the active vault's subscription state + seats. */
  refreshOrgBilling: () => Promise<void>;

  // Sync
  setSyncStatus: (status: SyncStatus) => void;
  setSyncPending: (pending: boolean) => void;
  markSynced: () => void;
  enableSyncForVault: () => Promise<void>;
}

// Slug derivation for local folder naming reuses the org slug rules.
const slugify = slugifyName;

// Each vault has its own notes, so remember which local folder was last
// used with each vault and swap to it on switch.
const ORG_VAULTS_KEY = "context.orgVaults";

/** Persisted { orgId → absolute local folder path } binding, one folder per vault. */
export function readOrgVaults(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ORG_VAULTS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * A folder name for a vault that won't collide with a folder already bound
 * to another vault under the managed root. Deterministic-ish for the MVP.
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
  // A local folder backs exactly ONE vault. Claiming it for `orgId` evicts
  // any other vault previously bound to the same folder — this is what
  // keeps every vault showing its own notes (and heals legacy state where
  // several vaults were collapsed onto one folder).
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

/** Drop a vault's remembered local folder (used when removing/deleting it). */
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

// A locally-cached list of the vaults (orgs) this account belongs to, so the
// signed-out welcome screen can still list your *remote* vaults (with the
// folder to reopen + resync) instead of only local folders. Refreshed on every
// refreshVault and — deliberately — KEPT across sign-out (that's the whole
// point: you can pick a synced vault to sign back into).
const KNOWN_VAULTS_KEY = "context.knownVaults";

export interface KnownVault {
  id: string;
  name: string;
}

export function readKnownVaults(): KnownVault[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KNOWN_VAULTS_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as KnownVault[]) : [];
  } catch {
    return [];
  }
}

function writeKnownVaults(list: KnownVault[]): void {
  try {
    localStorage.setItem(KNOWN_VAULTS_KEY, JSON.stringify(list));
  } catch {
    /* quota/unavailable — the cache is a convenience only */
  }
}

// A vault the user asked to open from the signed-out welcome screen but must
// sign in for first. Consumed by landInLastVault right after auth so we land
// in exactly that vault instead of the session's last-active one.
let pendingOpenOrgId: string | null = null;
export function requestOpenVault(orgId: string | null): void {
  pendingOpenOrgId = orgId;
}
function takePendingOpenVault(): string | null {
  const id = pendingOpenOrgId;
  pendingOpenOrgId = null;
  return id;
}

// The vault the user was last actually working in (folder + org resolved
// together). The server session carries an `activeOrganizationId`, but it can be
// null (fresh session, 2+ orgs) and it doesn't know which *folder* to open — so
// we persist the last opened vault locally and reopen it on launch instead
// of dumping the user on the picker every time.
const LAST_VAULT_KEY = "context.lastVault";

export function readLastVault(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

function rememberLastVault(orgId: string): void {
  try {
    localStorage.setItem(LAST_VAULT_KEY, orgId);
  } catch {
    /* quota/unavailable — convenience only */
  }
}

function forgetLastVault(orgId?: string): void {
  try {
    // With no id, clear unconditionally; with one, only clear if it still points
    // at the vault being removed (don't clobber a newer pointer).
    if (orgId && readLastVault() !== orgId) return;
    localStorage.removeItem(LAST_VAULT_KEY);
  } catch {
    /* quota/unavailable — convenience only */
  }
}

/**
 * After a session is (re)established, land the user in the vault they were
 * last using — preferring the session's active org, then the last vault we
 * opened on this device — instead of leaving them on whatever local folder
 * happened to be open. Restores only vaults we're still a member of; falls
 * back to syncing the open local vault when there's nothing to restore.
 */
async function landInLastVault(get: () => AppStore): Promise<void> {
  const orgs = get().organizations;
  // An explicit "open this vault" request (a remote vault clicked on the
  // signed-out welcome screen, which routed through sign-in) wins over every
  // other heuristic — that's the vault the user just asked for.
  const requested = takePendingOpenVault();
  if (requested && orgs.some((o) => o.id === requested)) {
    await get().setActiveOrganization(requested);
    return;
  }
  // The folder that's already open (App.tsx reopens the last one at launch) is
  // the strongest signal for "the vault I was last in" — it unifies local
  // and synced vaults under one recency signal.
  const openPath = get().vault?.path ?? null;
  const boundOrgOfOpen = openPath
    ? (Object.entries(readOrgVaults()).find(([, p]) => p === openPath)?.[0] ?? null)
    : null;

  // 1) The open folder belongs to a synced vault → make it active + sync.
  if (openPath && boundOrgOfOpen && orgs.some((o) => o.id === boundOrgOfOpen)) {
    if (get().session?.activeOrganizationId === boundOrgOfOpen) {
      await get().enableSyncForVault();
    } else {
      await get().setActiveOrganization(boundOrgOfOpen);
    }
    return;
  }

  // 2) A local (unsynced) folder is open → keep it local. Don't pull the user
  //    into a different vault just because they happen to be signed in.
  if (openPath && !boundOrgOfOpen) return;

  // 3) Nothing open → restore the session's active org, else the last vault
  //    we used on this device (only if we're still a member).
  const active = get().session?.activeOrganizationId ?? null;
  const remembered = readLastVault();
  const target =
    (active && orgs.some((o) => o.id === active) ? active : null) ??
    (remembered && orgs.some((o) => o.id === remembered) ? remembered : null);
  if (target) await get().setActiveOrganization(target);
}

/** Auto-dismiss timer for the member-joined celebration (module-scoped so a
 *  repeat join resets it rather than stacking). */
let memberJoinedTimer: ReturnType<typeof setTimeout> | null = null;

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
  syncPending: false,
  locks: [],
  vaultPresence: [],
  itemColors: {},
  itemOrder: {},
  pendingVaultFolder: null,
  billingConfig: null,
  orgBilling: null,
  activityStatus: readActivityStatus(),
  mentionSound: readMentionSound(),
  memberJoined: null,

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
        // Pass the local index doc_id so the server adopts the SAME id — the
        // editor's bridge and the sync provider must key the note identically.
        await syncManager.registry.registerNote(path, title, meta?.id);
      } catch (e) {
        console.warn("[sync] registerNote failed", e);
      }
    }
    set({
      openNote: { path, id: meta?.id ?? null, title },
      noteRemoved: false,
    });
    // Tell teammates which note we're now viewing (drives their sidebar dots).
    syncManager.setViewing(meta?.id ?? null);
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

  closeNote: () => {
    syncManager.setViewing(null);
    set({ openNote: null, backlinks: [], noteRemoved: false });
  },

  // ---- Auth ----

  initAuth: async () => {
    syncManager.setStatusListener((status) => get().setSyncStatus(status));
    syncManager.setActivityListeners({
      onPending: (pending) => get().setSyncPending(pending),
      onFlushed: () => get().markSynced(),
    });
    // A teammate's folder/note change has been pulled into the registry — reflect
    // it in the sidebar tree + title index live.
    syncManager.setRegistryListener(() => {
      void get().refreshTree();
      void get().refreshTitles();
    });
    // A teammate joined the vault — refresh the roster live (no reload) and
    // celebrate. Fires for everyone already connected; the joiner celebrates
    // locally in joinVault/acceptInvitation (they connect after the push).
    syncManager.setMemberJoinedListener((name) => {
      void get().refreshVault();
      get().celebrateMemberJoined(name);
    });
    // Live sidebar presence — the vault channel tells us which teammate is
    // viewing which note; mirror the roster into the store for FileTree.
    syncManager.setVaultPresenceListener((peers) => set({ vaultPresence: peers }));
    try {
      const session = await authManager.init();
      set({ serverUrl: authManager.getServerUrl() });
      if (session) {
        set({ session, authStatus: "signed-in", authError: null });
        await get().refreshVault();
        await get().refreshBillingConfig();
        await landInLastVault(get);
        await get().refreshOrgBilling();
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
        await get().refreshVault();
        await get().refreshBillingConfig();
        // Open the vault they last used, rather than making them pick one.
        await landInLastVault(get);
        await get().refreshOrgBilling();
        await get().openWelcomeIfPresent();
      }
    } catch (e) {
      set({ authError: errMsg(e) });
      throw e;
    }
  },

  signInWithGoogle: async () => {
    set({ authError: null });
    // Errors (incl. the loopback timeout on an abandoned flow) propagate to the
    // caller, which decides whether to surface them — a cancelled/superseded flow
    // must NOT flash a late error. See AuthDialog.googleSignIn.
    await authManager.signInWithGoogle();
    const session = await authManager.currentSession();
    set({ session, authStatus: session ? "signed-in" : "signed-out" });
    if (session) {
      await get().refreshVault();
      await get().refreshBillingConfig();
      // Open the vault they last used, rather than making them pick one.
      await landInLastVault(get);
      await get().refreshOrgBilling();
      await get().openWelcomeIfPresent();
    }
  },

  signUp: async (name, email, password) => {
    set({ authError: null });
    try {
      await authManager.signUp({ name, email, password });
      const session = await authManager.currentSession();
      set({ session, authStatus: session ? "signed-in" : "signed-out" });
      if (session) {
        await get().refreshVault();
        await get().refreshBillingConfig();
        await get().refreshOrgBilling();
      }
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
      syncPending: false,
      locks: [],
      pendingVaultFolder: null,
      billingConfig: null,
      orgBilling: null,
      // Close the open vault so the app returns to the VaultPicker "home" screen
      // (choose / reopen a vault) instead of leaving the old vault's files
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
      await get().refreshVault();
      await get().refreshBillingConfig();
      await get().refreshOrgBilling();
      await get().enableSyncForVault();
    } else {
      syncManager.disable();
      set({ syncEnabled: false, billingConfig: null, orgBilling: null });
    }
  },

  updateProfile: async ({ name, image }) => {
    await authManager.api.updateUser({ name, image });
    // Better Auth's update-user returns a status flag, not the user — re-fetch
    // the session so the store (and every avatar/name in the UI) updates.
    const session = await authManager.currentSession();
    set({ session });
  },

  setActivityStatus: (status) => {
    writeActivityStatus(status);
    set({ activityStatus: status });
    // Re-broadcast immediately on any live note presence.
    syncManager.setPresenceStatus(status);
  },

  setMentionSound: (enabled) => {
    writeMentionSound(enabled);
    set({ mentionSound: enabled });
  },

  celebrateMemberJoined: (name) => {
    const who = name?.trim() || "A new teammate";
    set({ memberJoined: { name: who, at: Date.now() } });
    // Reuse the app's sound preference so a muted user stays muted.
    if (get().mentionSound) playJoinChime();
    if (memberJoinedTimer) clearTimeout(memberJoinedTimer);
    memberJoinedTimer = setTimeout(() => {
      memberJoinedTimer = null;
      set({ memberJoined: null });
    }, 6000);
  },

  dismissMemberJoined: () => {
    if (memberJoinedTimer) {
      clearTimeout(memberJoinedTimer);
      memberJoinedTimer = null;
    }
    set({ memberJoined: null });
  },

  // ---- Vault ----

  refreshVault: async () => {
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
      // Cache the vault list locally so the signed-out welcome screen can
      // still offer them (kept across sign-out; refreshed here while signed in).
      writeKnownVaults(organizations.map((o) => ({ id: o.id, name: o.name })));
    } catch (e) {
      set({ authError: errMsg(e) });
    }
  },

  createOrganization: async (name) => {
    const org = await createWithUniqueSlug(name, (input) =>
      authManager.api.createOrganization(input),
    );
    // Route through the switch path so a brand-new vault prompts for its
    // own folder instead of adopting whatever folder is currently open.
    await get().setActiveOrganization(org.id);
  },

  turnOnSyncForCurrentVault: async (name) => {
    const vault = get().vault;
    if (!vault) throw new Error("Open a vault first.");
    // Unlike createOrganization (which prompts for a fresh folder), this binds
    // the folder you're already in and syncs its existing files up. Create the
    // org directly, bind THIS folder, then let enableSyncForVault reconcile the
    // current tree into the new server vault.
    const org = await createWithUniqueSlug(name?.trim() || vault.name, (input) =>
      authManager.api.createOrganization(input),
    );
    await authManager.api.setActiveOrganization(org.id);
    const session = await authManager.currentSession();
    set({ session });
    await get().refreshVault();
    rememberOrgVault(org.id, vault.path);
    rememberLastVault(org.id);
    await get().enableSyncForVault();
    await get().refreshOrgBilling();
  },

  setActiveOrganization: async (organizationId) => {
    const previousOrgId = get().session?.activeOrganizationId ?? null;

    // Re-assert that the vault we're leaving solely owns its open folder,
    // evicting any other vault still bound to it (this is what heals legacy
    // state where several vaults collapsed onto one folder). Only do this
    // when that vault ACTUALLY owns the open folder — if we're leaving a
    // vault that never got its own folder (still on the pending prompt),
    // the visible folder belongs to a *different* vault, so touching the
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
    await get().refreshVault();
    // Seat usage + plan are per-vault, so refresh on every switch.
    await get().refreshOrgBilling();

    // Each vault owns its own local folder. If one is already bound, swap
    // to it. If not, do NOT reuse the folder that's currently open — ask the
    // user to choose one (or start empty) via the pending-folder prompt.
    const path = readOrgVaults()[organizationId];
    if (path) {
      try {
        await get().applyVaultFolder(organizationId, path);
      } catch (e) {
        console.warn("[vault] folder swap failed", e);
      }
      return;
    }
    const org = get().organizations.find((o) => o.id === organizationId);
    set({
      syncEnabled: false,
      pendingVaultFolder: {
        orgId: organizationId,
        orgName: org?.name ?? "New vault",
        previousOrgId: previousOrgId === organizationId ? null : previousOrgId,
      },
    });
  },

  inviteMember: async (email, role) => {
    const activeOrgId = get().session?.activeOrganizationId ?? undefined;
    await authManager.api.inviteMember({ email, role, organizationId: activeOrgId });
    await get().refreshVault();
  },

  removeMember: async (userId) => {
    const activeOrgId = get().session?.activeOrganizationId;
    if (!activeOrgId) throw new Error("No active vault");
    await authManager.api.removeMember(activeOrgId, userId);
    await get().refreshVault();
  },

  acceptInvitation: async (invitationId) => {
    const inv = get().userInvitations.find((i) => i.id === invitationId);
    await authManager.api.acceptInvitation(invitationId);
    // Make the joined vault active through the switch path so it gets its
    // own folder (prompted) rather than adopting the currently-open folder.
    if (inv?.organizationId) {
      await get().setActiveOrganization(inv.organizationId);
    } else {
      const session = await authManager.currentSession();
      set({ session });
      await get().refreshVault();
    }
    // The joiner celebrates locally too (they connect after the server push).
    const me = get().session?.user;
    get().celebrateMemberJoined(me?.name || me?.email || "You");
  },

  joinVault: async (code) => {
    const joined = await authManager.api.joinVault(code.trim());
    await get().setActiveOrganization(joined.organizationId);
    // The joiner sees the celebration too (their vault channel connects after
    // the server broadcast, so they'd otherwise miss the live push).
    if (!joined.alreadyMember) {
      const me = get().session?.user;
      get().celebrateMemberJoined(me?.name || me?.email || "You");
    }
  },

  removeVaultLocally: async (organizationId) => {
    // Forget this vault's local folder so it won't auto-open here again.
    forgetOrgVault(organizationId);
    forgetLastVault(organizationId);
    // If we're removing the vault that's currently open, move off it: swap
    // to another vault if one exists, otherwise close the vault and stop
    // syncing (the vault itself stays on the server — this device just
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
          syncPending: false,
          pendingVaultFolder: null,
        });
      }
    }
    await get().refreshVault();
  },

  deleteRemoteVault: async (organizationId) => {
    // Permanent, server-side, owner-only. 403s here if the caller isn't owner.
    await authManager.api.deleteRemoteVault(organizationId);
    // Then tear down the same local state as a device-level removal.
    await get().removeVaultLocally(organizationId);
  },

  // ---- Vault folder resolution ----

  openLocalVault: async (path) => {
    // A local vault is a plain folder that isn't syncing to an org. Opening
    // one tears down any active vault sync (we're no longer in that org's
    // folder) and leaves sync off until the user explicitly turns it on.
    const info = await ipc.openVault(path);
    syncManager.disable();
    get().closeNote();
    set({
      vault: info,
      locks: [],
      syncEnabled: false,
      syncStatus: "offline",
      syncPending: false,
      itemColors: readItemColors(info.path),
      itemOrder: readItemOrder(info.path),
      pendingVaultFolder: null,
    });
    await get().refreshTree();
    await get().refreshTitles();
    // Give a brand-new empty folder its first-run welcome content.
    await get().seedLocalVaultIfEmpty();
  },

  removeLocalVault: async (path) => {
    // Forget it from this device's recents; the folder and its files stay on
    // disk. If it's the one open now, close it and drop to the empty state —
    // there's no server copy to fall back to, so we don't auto-switch elsewhere.
    await ipc.removeRecentVault(path);
    if (!get().syncEnabled && get().vault?.path === path) {
      get().closeLocalVault();
    }
  },

  deleteLocalVault: async (path) => {
    // Tear down open state FIRST if this is the current folder, so nothing keeps
    // reading from it while it's moved to the trash.
    if (!get().syncEnabled && get().vault?.path === path) {
      get().closeLocalVault();
    }
    // Move the folder (and all its notes) to the OS trash; this also forgets it
    // from recents. Destructive — the UI gates it behind a two-click confirm.
    await ipc.deleteVault(path);
  },

  closeLocalVault: () => {
    // Detach from the open local folder and drop to the welcome/empty state.
    syncManager.disable();
    get().closeNote();
    set({
      vault: null,
      locks: [],
      syncEnabled: false,
      syncStatus: "offline",
      syncPending: false,
      pendingVaultFolder: null,
    });
  },

  applyVaultFolder: async (orgId, path) => {
    const v = await ipc.openVaultInRoot(path);
    get().closeNote();
    set({
      vault: v,
      locks: [],
      itemColors: readItemColors(v.path),
      itemOrder: readItemOrder(v.path),
      pendingVaultFolder: null,
    });
    rememberOrgVault(orgId, v.path);
    rememberLastVault(orgId);
    await get().refreshTree();
    await get().refreshTitles();
    await get().enableSyncForVault();
  },

  chooseVaultFolder: async () => {
    const pending = get().pendingVaultFolder;
    if (!pending) return;
    const picked = await ipc.pickFolder();
    if (!picked) return; // cancelled the native dialog — keep the prompt up
    await get().applyVaultFolder(pending.orgId, picked);
  },

  startEmptyVault: async () => {
    const pending = get().pendingVaultFolder;
    if (!pending) return;
    const root = await ipc.getVaultsRoot();
    const slug = uniqueFolderSlug(pending.orgName, readOrgVaults());
    await get().applyVaultFolder(pending.orgId, `${root}/${slug}`);
  },

  cancelVaultFolder: async () => {
    const pending = get().pendingVaultFolder;
    set({ pendingVaultFolder: null });
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

  // ---- Billing ----

  refreshBillingConfig: async () => {
    // getBillingConfig never throws — it returns { enabled: false } on any
    // failure (older/self-hosted server), so the billing UI simply stays hidden.
    const billingConfig = await authManager.api.getBillingConfig();
    set({ billingConfig });
  },

  refreshOrgBilling: async () => {
    const orgId = get().session?.activeOrganizationId;
    if (!orgId || !get().billingConfig?.enabled) {
      set({ orgBilling: null });
      return;
    }
    try {
      const orgBilling = await authManager.api.getOrgBilling(orgId);
      set({ orgBilling });
    } catch (e) {
      console.warn("[billing] refresh failed", e);
      set({ orgBilling: null });
    }
  },

  // ---- Sync ----

  setSyncStatus: (status) =>
    set(
      status === "synced"
        ? { syncStatus: status, lastSyncedAt: Date.now() }
        : // Leaving "synced" (new doc connecting, offline, error…) clears any
          // stale "Saving…" — pending only makes sense while connected.
          { syncStatus: status, syncPending: false },
    ),

  setSyncPending: (pending) => set({ syncPending: pending }),

  // A server ack of all pending changes: this is the real "synced just now".
  markSynced: () => set({ lastSyncedAt: Date.now(), syncPending: false }),

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
      // Broadcast the user's current activity status on this session's presence.
      syncManager.setPresenceStatus(get().activityStatus);
      // This folder is now the one this vault opens with.
      if (session.activeOrganizationId) {
        rememberOrgVault(session.activeOrganizationId, vault.path);
        rememberLastVault(session.activeOrganizationId);
      }
      // Reconcile may have materialized server-only notes onto disk; refresh so
      // the sidebar reflects the full vault, not just what was already local.
      await get().refreshTree();
      await get().refreshTitles();
      await get().refreshLocks();
      // A brand-new vault was just seeded with welcome content — greet the
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
