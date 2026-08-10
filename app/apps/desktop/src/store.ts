// UI view-state only. The filesystem is never the store's truth — Rust owns
// disk, and the file↔CRDT bridge owns the open note's buffer, echo suppression,
// and autosave. Phase 2/3 adds auth, vault (org), and sync view-state; the
// heavy lifting lives in lib/auth, lib/sync — the store just mirrors it for React.

import { create } from "zustand";
import * as ipc from "./lib/ipc";
import { bridgeManager } from "./lib/bridge";
import { readItemColors, writeItemColors } from "./lib/appearance";
import { readItemOrder, writeItemOrder, type ItemOrder } from "./lib/ordering";
import { loadedFolderPaths, setChildrenAt } from "./lib/tree/lazyTree";
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
import { vaultScopes } from "./lib/sync/vaultScope";
import type { SyncStatus } from "./lib/sync/syncManager";
import type { DocSyncState, SyncProgress } from "./lib/sync/vaultScope";
import type { VaultPeer } from "./lib/sync/vaultSyncEngine";
import type { VoiceSpeaker } from "./lib/sync/docSession";
import { MicPermissionError } from "./lib/voice/capture";
import { createWithUniqueSlug, slugifyName } from "./lib/orgSlug";
import {
  type ActivityStatus,
  readActivityStatus,
  readMentionSound,
  readTreeSort,
  writeActivityStatus,
  writeMentionSound,
  writeTreeSort,
} from "./lib/prefs";
import type { TreeSort } from "./lib/tree/sort";
import { seedWelcomeContent, vaultIsEmpty, WELCOME_NOTE_PATH } from "./lib/vault/seed";
import { planLanding } from "./lib/vault/landing";
import { playJoinChime } from "./lib/celebrate/celebrate";
import { viewingDocId } from "./lib/presence/viewingDocId";

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
  /**
   * Set when the note that was open was deleted by a TEAMMATE (or an AI) and we
   * applied that locally: the trash-relative path the local copy was moved to, so
   * the UI can say where it went. Distinct from `noteRemoved`, which means "the
   * file vanished from under us" (a Finder delete) and offers no recovery hint.
   */
  noteRemovedByTeammate: string | null;
  /** Follow an inbound rename: re-point the open note (and its descendants). */
  followNoteRename: (from: string, to: string) => void;
  backlinks: ipc.Backlink[];
  titles: ipc.NoteTitle[];

  // ---- Auth / vault / sync ----
  authStatus: AuthStatus;
  session: SessionInfo | null;
  serverUrl: string;
  authError: string | null;
  /**
   * A sign-in has landed but we're still resolving which vault to open (and
   * possibly creating it, its folder, and its starter notes — a few seconds).
   * Until it clears there is no vault, so `App` still renders the welcome
   * screen; the picker reads this to say so rather than looking like the
   * sign-in did nothing.
   */
  landingVault: boolean;
  /**
   * A vault switch is in flight, with the vault we're heading TO. Set before the
   * first await of `setActiveOrganization` and cleared when it settles, so the
   * chrome can rename itself to the destination immediately instead of showing
   * the outgoing vault until the folder finally swaps.
   */
  switchingVault: { orgId: string; name: string } | null;
  /**
   * The note path currently being opened, if the open hasn't landed yet. Opening
   * a note in a synced vault registers it server-side first (`openNoteByPath`),
   * so a click can sit for a moment with nothing on screen acknowledging it.
   */
  openingNotePath: string | null;
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
  /**
   * Counted progress of the current vault's sync run; null when none is running.
   * Belongs to ONE vault — dropped on every vault switch (see
   * `vaultScopedSyncReset`), because a half-finished count from the vault we
   * left would read as progress on the vault we landed in.
   */
  syncProgress: SyncProgress | null;
  /**
   * Per-doc sync state for the sidebar badge, keyed by **docId, never by path**
   * (paths change on rename and collide across vaults). Dropped on every vault
   * switch alongside `syncProgress`.
   */
  docSyncState: Record<string, DocSyncState>;
  /**
   * Vault-relative note path → that note's **server docId**, mirroring the
   * registry's map for the open vault (empty when sync is off).
   *
   * This is a path *index over* docId identity, never a substitute for it: the
   * sidebar knows its rows by path while every sync fact (`docSyncState`) is
   * keyed by docId, so something has to bridge the two, and the registry is the
   * only thing that can. Dropped on every vault switch — two vaults both have a
   * `Welcome.md`.
   */
  docIdByPath: Record<string, string>;
  /** Locks (read-only overlays) in the synced vault — drives tree badges. */
  locks: Share[];
  /** Live "who's viewing what" roster (teammates only) — drives the sidebar
   *  presence dots on notes/folders. Empty when sync is off or disconnected. */
  vaultPresence: VaultPeer[];
  /** Teammates transmitting right now (push-to-talk). Purely transient — this
   *  is the only record a voice broadcast ever leaves anywhere. */
  voiceSpeakers: VoiceSpeaker[];
  /** True while this user is holding the talk button. */
  broadcasting: boolean;
  /** Set when the mic couldn't be opened, so the UI can say why once. */
  voiceError: string | null;
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
  /** How the sidebar arranges everything the user hasn't arranged by hand.
   *  Layered UNDER `itemOrder`, never replacing it — see `lib/tree/sort`. */
  treeSort: TreeSort;
  /** Set briefly when a teammate joins the vault, to drive the celebration
   *  banner + confetti. `at` changes each time so a repeat join re-triggers it. */
  memberJoined: { name: string; at: number } | null;

  setVault: (v: ipc.VaultInfo | null) => void;
  setItemColor: (path: string, colorId: string | null) => void;
  setItemOrder: (order: ItemOrder) => void;
  setTreeSort: (sort: TreeSort) => void;
  refreshTree: () => Promise<void>;
  /** Lazily load one folder's immediate children into the sidebar tree. */
  loadChildren: (path: string) => Promise<void>;
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
  /**
   * Run the post-sign-in landing on demand, for a flow that deliberately
   * suppressed it and then fell through (abandoning "join a team" after the
   * sign-up it required). Same rules as signing in, `createIfNone` included.
   */
  landAfterAuth: () => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;

  // Account profile & preferences
  /** Update display name / avatar (server-backed; refreshes the session). */
  updateProfile: (input: { name?: string; image?: string | null }) => Promise<void>;
  setActivityStatus: (status: ActivityStatus) => void;
  setMentionSound: (enabled: boolean) => void;
  /** Open the mic and start broadcasting to the vault (button pressed). */
  startBroadcast: () => Promise<void>;
  /** Stop broadcasting and release the mic (button released). */
  stopBroadcast: () => Promise<void>;
  /** Dismiss the transient push-to-talk notice. */
  clearVoiceError: () => void;
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
  /**
   * Adopt a vault Rust has ALREADY opened (the native-picker commands open as
   * part of picking). Retires the previous vault's sync, swaps view state, and
   * reloads the tree. `resync: true` re-enables sync on the new folder for the
   * active vault (the sidebar "Switch" flow); otherwise the folder stays local
   * and gets first-run seeding if it's empty.
   */
  adoptOpenedVault: (
    info: ipc.VaultInfo,
    opts?: { resync?: boolean },
  ) => Promise<void>;
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
  /** Publish the current vault's sync progress (null clears it). */
  setSyncProgress: (progress: SyncProgress | null) => void;
  /** Merge per-doc sync states in. Keys are docIds; `null` drops an entry. */
  patchDocSyncState: (patch: Record<string, DocSyncState | null>) => void;
  /** Replace the path→docId index (the registry mirror; `{}` = nothing synced). */
  setDocIdByPath: (map: Record<string, string>) => void;
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

// A "join a team with a code" flow started from the welcome screen, which runs
// sign-in/sign-up first. While it's armed the post-auth landing must put the
// user NOWHERE: a brand-new account would otherwise be handed an auto-created
// "My Vault" (and an existing account dropped into an old one), unmounting the
// welcome screen and burying the code step the user explicitly asked for. The
// landing is `joinVault` itself — it switches into the vault the code names.
let joiningWithCode = false;
export function requestJoinWithCode(on: boolean): void {
  joiningWithCode = on;
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
 *
 * The choice itself is `planLanding` (pure, unit-tested in `lib/vault/landing`);
 * this is only its dispatcher. Signing in must ALWAYS end somewhere — never
 * back on the signed-out welcome screen — so `createIfNone` is passed by the
 * explicit auth actions (sign-in / sign-up / Google) but NOT by silent session
 * restore at launch: "I just signed in" is a good reason to be given a vault,
 * "the app reopened" is not.
 */
async function landInLastVault(
  get: () => AppStore,
  opts: { createIfNone?: boolean } = {},
): Promise<void> {
  const action = planLanding({
    orgIds: get().organizations.map((o) => o.id),
    // Consumed even when the join flow is about to override it: the join
    // supersedes whatever open-request was pending.
    requestedOrgId: takePendingOpenVault(),
    joiningWithCode,
    openPath: get().vault?.path ?? null,
    orgVaults: readOrgVaults(),
    activeOrganizationId: get().session?.activeOrganizationId ?? null,
    rememberedOrgId: readLastVault(),
    createIfNone: opts.createIfNone ?? false,
  });
  // Only the two actions that end with a vault on screen raise the flag, and
  // only while they run: `stay-local`/`nothing` change nothing, so claiming to
  // be "opening your vault" there would hang a spinner forever.
  if (action.kind === "stay-local" || action.kind === "nothing") return;
  useStore.setState({ landingVault: true });
  try {
    switch (action.kind) {
      case "enable-sync":
        await get().enableSyncForVault();
        return;
      case "switch":
        await get().setActiveOrganization(action.orgId);
        return;
      case "create-first-vault":
        // `createOrganization` routes through the switch path, so the new vault
        // gets a folder under the vaults root, turns sync on, and the reconcile
        // seeds welcome content into it. Failure is not fatal — the vault cap
        // (402) or an offline server just leaves the picker up, where "New vault"
        // still works — so it must never reject out of the sign-in itself.
        try {
          await get().createOrganization(FIRST_VAULT_NAME);
        } catch (e) {
          console.warn("[vault] could not create a first vault on sign-in", e);
        }
        return;
    }
  } finally {
    useStore.setState({ landingVault: false });
  }
}

/**
 * Name for the vault auto-created on a first sign-in. Deliberately not derived
 * from the user's name: the display name becomes the folder slug
 * (`uniqueFolderSlug`), and "Naveed's Vault" lands on disk as `naveed-s-vault`.
 * Renaming a vault is one click in Vault Settings.
 */
const FIRST_VAULT_NAME = "My Vault";

/** Auto-dismiss timer for the member-joined celebration (module-scoped so a
 *  repeat join resets it rather than stacking). */
let memberJoinedTimer: ReturnType<typeof setTimeout> | null = null;

/** The in-flight push-to-talk capture, if the button is down. Module scope
 *  rather than store state because it's a live mic handle, not view state. */
let activeBroadcast: { stop: () => Promise<void> } | null = null;

/** Bumped by every `setActiveOrganization`. A call whose captured generation no
 *  longer matches has been superseded by a newer switch and drops its remaining
 *  work rather than racing it to bind a folder / enable sync. */
let orgSwitchGen = 0;

/**
 * Tear down networked sync for the vault we're leaving. Call this BEFORE any
 * `ipc.openVault*` that swaps the Rust vault slot: Rust holds ONE global vault,
 * so a sync operation still in flight would resolve against the folder we just
 * opened. `disable()` aborts the vault scope, clears every timer it owns, and
 * resets the registry's in-memory maps + serverVaultId.
 */
function leaveVaultSync(): void {
  syncManager.disable();
}

/**
 * Claim the vault that is now open. Rust holds ONE global vault slot, so
 * `info.epoch` is the only unambiguous handle on "the vault this work is for" —
 * pinning IPC to it is what makes a stale write fail instead of silently landing
 * in the wrong folder.
 *
 * Called for EVERY open, including a plain local folder with no sync: two vaults
 * both have a `Welcome.md`, so the open note's debounced egest flushing after a
 * switch would otherwise overwrite the other vault's file at the same path. The
 * bridge picks the epoch up via `currentVaultEpoch()` when it opens a note.
 *
 * `ensure` (not `begin`) because one open signals twice — Rust's `vault-opened`
 * event and the `open_vault` response — and because `syncManager.enable` may
 * already have replaced this scope with an org-bound one worth keeping.
 */
function enterVaultScope(info: ipc.VaultInfo, orgId: string | null): void {
  vaultScopes.ensure({ orgId, vaultPath: info.path, vaultEpoch: info.epoch });
}

/**
 * Is `epoch` still the open vault? Every `set()` that happens after an await in
 * a vault/sync path must be guarded on this, or a slow operation for vault A
 * lands its results (tree, titles, syncEnabled) on vault B's view state.
 * `null`/`undefined` means "the caller had no vault", which only matches the
 * still-no-vault case.
 */
function sameVault(get: () => AppStore, epoch: number | null | undefined): boolean {
  return (get().vault?.epoch ?? null) === (epoch ?? null);
}

/**
 * Sync view-state that belongs to ONE vault and must never survive a switch.
 * Spread into every `set()` on a vault-change path, right after
 * `leaveVaultSync()` has torn the sync layer down.
 *
 * `syncProgress`, `docSyncState` and `docIdByPath` matter most: `docSyncState` is
 * keyed by docId, so leaking it would badge the new vault's rows with the
 * previous vault's results; `docIdByPath` is keyed by path, which two vaults
 * share outright (both have a `Welcome.md`); and a stale `syncProgress` would
 * report the vault we left as still uploading.
 */
function vaultScopedSyncReset() {
  // A fresh object each call: handing out one shared `{}`/`[]` would let any
  // future in-place mutation of `docSyncState`/`locks` leak into every later reset.
  return {
    syncEnabled: false,
    syncStatus: "offline" as SyncStatus,
    syncPending: false,
    syncProgress: null,
    docSyncState: {} as Record<string, DocSyncState>,
    docIdByPath: {} as Record<string, string>,
    locks: [] as Share[],
  } satisfies Partial<AppStore>;
}

export const useStore = create<AppStore>((set, get) => ({
  vault: null,
  tree: null,
  openNote: null,
  noteRemoved: false,
  noteRemovedByTeammate: null,
  backlinks: [],
  titles: [],

  authStatus: "unknown",
  session: null,
  serverUrl: authManager.getServerUrl(),
  authError: null,
  landingVault: false,
  switchingVault: null,
  openingNotePath: null,
  organizations: [],
  members: [],
  pendingInvitations: [],
  userInvitations: [],
  ...vaultScopedSyncReset(),
  lastSyncedAt: null,
  vaultPresence: [],
  voiceSpeakers: [],
  broadcasting: false,
  voiceError: null,
  itemColors: {},
  itemOrder: {},
  pendingVaultFolder: null,
  billingConfig: null,
  orgBilling: null,
  activityStatus: readActivityStatus(),
  mentionSound: readMentionSound(),
  treeSort: readTreeSort(),
  memberJoined: null,

  setVault: (v) => {
    // Also fires from Rust's `vault-opened` event, which is the only signal some
    // opens produce — so this is where a local vault gets its scope.
    if (v) enterVaultScope(v, get().session?.activeOrganizationId ?? null);
    set({
      vault: v,
      itemColors: readItemColors(v?.path),
      itemOrder: readItemOrder(v?.path),
    });
  },

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

  setTreeSort: (sort) => {
    // Deliberately does NOT touch `itemOrder`: the sort is the layer beneath a
    // hand-made arrangement, so switching it rearranges only what the user
    // never arranged. Unlike the vault-scoped prefs above it needs no open
    // vault — it's a device preference.
    writeTreeSort(sort);
    set({ treeSort: sort });
  },

  refreshTree: async () => {
    // Lazy loading: fetch only the vault's top level, not the whole tree.
    // Folders load their children on first expand (see `loadChildren`), so
    // switching a large vault no longer ships/parses the entire node set.
    const vault = get().vault;
    const epoch = vault?.epoch;
    // Which folders were already expanded/listed. This refresh runs on every
    // `file-changed` burst and every sync registry pull — i.e. constantly while
    // you work — and rebuilding from the top level alone would drop each of
    // them back to an unloaded placeholder. That is what made the sidebar fold
    // itself up mid-edit: open a folder, click through its notes, and the
    // write-triggered refresh emptied it under you.
    const loaded = loadedFolderPaths(get().tree);
    let children: ipc.TreeNode[];
    try {
      children = await ipc.listChildren("", epoch);
    } catch (e) {
      // These reads are epoch-pinned, so a vault switch mid-read makes Rust
      // REJECT them. That is the guard working, not a failure — and several call
      // sites fire this without awaiting, where a rejection would surface as an
      // unhandled promise rejection instead of being dropped.
      if (ipc.isVaultMismatch(e)) return;
      throw e;
    }
    // A vault switch during the read would otherwise paint the old vault's
    // children under the new vault's name.
    if (!sameVault(get, epoch)) return;
    let next: ipc.TreeNode = {
      id: "",
      name: vault?.name ?? "vault",
      path: "",
      isDir: true,
      children,
      // The root's own listing IS what we just fetched; only its subfolders
      // are still placeholders (Rust marks those `childrenLoaded: false`).
      childrenLoaded: true,
    };

    // Re-list the expanded folders rather than carrying their old children
    // over: this refresh exists to show what changed on disk, and a folder the
    // user is looking at is the one most likely to have changed. A folder that
    // has since been deleted or renamed simply drops out.
    if (loaded.length > 0) {
      const listings = await Promise.all(
        loaded.map(async (path) => {
          try {
            return { path, kids: await ipc.listChildren(path, epoch) };
          } catch {
            return { path, kids: null };
          }
        }),
      );
      if (!sameVault(get, epoch)) return;
      for (const { path, kids } of listings) {
        if (kids) next = setChildrenAt(next, path, kids);
      }
    }

    set({ tree: next });
  },

  loadChildren: async (path) => {
    const epoch = get().vault?.epoch;
    let kids: ipc.TreeNode[];
    try {
      kids = await ipc.listChildren(path, epoch);
    } catch (e) {
      if (ipc.isVaultMismatch(e)) return; // the vault moved on (see refreshTree)
      throw e;
    }
    if (!sameVault(get, epoch)) return;
    set((s) => ({
      tree: s.tree ? setChildrenAt(s.tree, path, kids) : s.tree,
    }));
  },

  refreshTitles: async () => {
    const epoch = get().vault?.epoch;
    let titles: ipc.NoteTitle[];
    try {
      titles = await ipc.listNoteTitles(epoch);
    } catch (e) {
      if (ipc.isVaultMismatch(e)) return; // the vault moved on (see refreshTree)
      throw e;
    }
    if (!sameVault(get, epoch)) return;
    set({ titles });
  },

  seedLocalVaultIfEmpty: async () => {
    // First-run welcome content for an empty, local-only vault (opened while
    // signed out, or a folder opened directly without sync). When signed in,
    // the sync reconcile seeds instead — so the notes register on the server —
    // hence the syncEnabled guard here to avoid seeding twice.
    if (get().syncEnabled) return;
    const epoch = get().vault?.epoch;
    const tree = get().tree;
    if (!tree || !vaultIsEmpty(tree)) return;
    // Seeding writes ~20 notes; pin them all to this vault so a switch part-way
    // through can't scatter the rest into the folder the user just opened.
    const welcomePath = await seedWelcomeContent(epoch);
    if (!sameVault(get, epoch)) return;
    await get().refreshTree();
    await get().refreshTitles();
    if (!sameVault(get, epoch)) return;
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
    const epoch = get().vault?.epoch;
    // Name the note being opened before the first await. In a synced vault this
    // function makes a network call (`registerNote`) before `openNote` is set,
    // so the row stays unselected and the editor keeps showing the previous note
    // for the whole round trip — a click that visibly does nothing. The sidebar
    // row and the editor both watch this and acknowledge the click at once.
    set({ openingNotePath: path });
    try {
      const meta = await ipc.getNoteMeta(path);
      if (!sameVault(get, epoch)) return; // vault switched mid-open — drop it
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
        if (!sameVault(get, epoch)) return;
      }
      set({
        openNote: { path, id: meta?.id ?? null, title },
        noteRemoved: false,
      });
      // Tell teammates which note we're now viewing (drives their sidebar dots).
      // The announced id must be the SERVER doc_id — see `viewingDocId`, which
      // exists to hold that reasoning and a regression test for it.
      syncManager.setViewing(
        viewingDocId(meta?.id, syncManager.registry.getMapping(path)?.docId),
      );
      await get().refreshBacklinks();
    } finally {
      // Only the newest open clears it: two quick clicks would otherwise have the
      // first one's completion cancel the second one's indicator.
      if (get().openingNotePath === path) set({ openingNotePath: null });
    }
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

  /**
   * A teammate moved the note we have open; the file has already moved on disk.
   *
   * Changing `openNote.path` re-runs the editor's effect, which reopens the bridge
   * at the new path under the SAME docId — and `NoteBridge.hydrate` reads the
   * persisted CRDT keyed by docId, which the file move never touched, so the
   * content is intact. Cursor position and undo history are lost; for a move
   * someone else initiated that's an acceptable trade for not forking the note.
   */
  followNoteRename: (from, to) => {
    const open = get().openNote;
    if (!open) return;
    if (open.path === from) {
      set({ openNote: { ...open, path: to }, noteRemoved: false });
    } else if (open.path.startsWith(from + "/")) {
      // The open note sat inside a folder that moved.
      set({ openNote: { ...open, path: to + open.path.slice(from.length) }, noteRemoved: false });
    }
  },

  closeNote: () => {
    syncManager.setViewing(null);
    set({ openNote: null, backlinks: [], noteRemoved: false, noteRemovedByTeammate: null });
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
    // A teammate renamed/moved or deleted a note we have on disk, and the registry
    // has just applied that to the file. The open editor's bridge was destroyed
    // before the move, so the view MUST be re-pointed or closed — leaving
    // CodeMirror bound to a destroyed Y.Doc throws on the next keystroke.
    syncManager.setInboundListeners({
      onNotePathChanged: (_docId, from, to) => get().followNoteRename(from, to),
      onNoteRemoved: (_docId, path, trashedTo) => {
        const open = get().openNote;
        if (open && (open.path === path || open.path.startsWith(path + "/"))) {
          get().closeNote();
          set({ noteRemovedByTeammate: trashedTo });
        }
      },
    });
    // A teammate joined the vault — refresh the roster live (no reload) and
    // celebrate. Fires for everyone already connected; the joiner celebrates
    // locally in joinVault/acceptInvitation (they connect after the push).
    syncManager.setMemberJoinedListener((name) => {
      void get().refreshVault();
      // Re-announce so the newcomer sees who is already here. Their own first
      // announce asks everyone to reply, but nothing made us speak up if that
      // round was missed, and the roster has no other way to converge.
      syncManager.announcePresence();
      get().celebrateMemberJoined(name);
    });
    // Live sidebar presence — the vault channel tells us which teammate is
    // viewing which note; mirror the roster into the store for FileTree.
    syncManager.setVaultPresenceListener((peers) => set({ vaultPresence: peers }));
    // Who's talking right now. Nothing is stored — this list empties itself as
    // each transmission finishes playing.
    syncManager.setVoiceListener((speaking) => set({ voiceSpeakers: speaking }));
    // Bulk-sync progress for the open vault. Both of these are already throttled
    // (~10 emissions/second) and batched by `SyncProgressReporter`, so a 500-note
    // run costs ~10 store writes per second rather than one per note.
    syncManager.setSyncProgressListener((progress) => get().setSyncProgress(progress));
    syncManager.setDocStateListener((patch) => get().patchDocSyncState(patch));
    // The path→docId index the sidebar needs to attach a docId-keyed sync state
    // to a path-keyed row. Coalesced by SyncManager on the same ~10/second budget.
    syncManager.setRegistryMapListener((map) => get().setDocIdByPath(map));
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
        // Open the vault they last used, rather than making them pick one — and
        // if the account has none yet, make one. Signing in never dead-ends back
        // on the welcome screen.
        await landInLastVault(get, { createIfNone: true });
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
      // Same as email sign-in: land in a vault, creating the first one if the
      // account has none.
      await landInLastVault(get, { createIfNone: true });
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
        // A brand-new account has nothing to restore, so this is what actually
        // creates their first vault and opens it. Sign-up used to skip landing
        // entirely, which is why signing up from the welcome screen returned you
        // to the welcome screen.
        await landInLastVault(get, { createIfNone: true });
        await get().refreshOrgBilling();
        await get().openWelcomeIfPresent();
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
    // Retire the vault scope BEFORE the session goes away, so nothing tries to
    // reconcile/pull with a token that is about to be revoked.
    leaveVaultSync();
    await authManager.signOut();
    set({
      session: null,
      authStatus: "signed-out",
      landingVault: false,
      organizations: [],
      members: [],
      pendingInvitations: [],
      userInvitations: [],
      ...vaultScopedSyncReset(),
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

  landAfterAuth: async () => {
    // Callers reach here only after disarming whatever suppressed the landing
    // in the first place — otherwise planLanding still answers "nothing".
    await landInLastVault(get, { createIfNone: true });
    await get().openWelcomeIfPresent();
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

  startBroadcast: async () => {
    // Re-entrancy guard: key repeat fires press events continuously while held,
    // and a second capture would open the mic twice and double every chunk.
    if (get().broadcasting || activeBroadcast) return;
    // Deliberately NOT gated on the channel being up. Talking to an empty (or
    // disconnected) vault is a no-op, not an error, and refusing to open the mic
    // would make the button feel broken exactly when someone wants to speak.
    set({ broadcasting: true, voiceError: null });
    try {
      activeBroadcast = await syncManager.startBroadcast();
    } catch (err) {
      activeBroadcast = null;
      set({
        broadcasting: false,
        voiceError:
          err instanceof MicPermissionError && err.denied
            ? "Microphone access is blocked. Enable it in your system settings."
            : "Couldn't open the microphone.",
      });
      return;
    }
    // Released before the mic finished opening — don't leave it live.
    if (!get().broadcasting) await get().stopBroadcast();
  },

  stopBroadcast: async () => {
    const handle = activeBroadcast;
    activeBroadcast = null;
    set({ broadcasting: false });
    if (handle) await handle.stop().catch(() => {});
  },

  clearVoiceError: () => set({ voiceError: null }),

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
    // Already a member of an active vault? Then sync is off because enabling it
    // FAILED, not because there's nowhere to sync to — so retry that vault
    // instead of creating a new one.
    //
    // This guard exists because the alternative is the worst bug in the join
    // flow: an invited user whose `enableSyncForVault` fell through one of its
    // stale/error paths sees "Turn on sync", clicks the only affordance
    // offered, and silently lands in a brand-new empty vault of their own
    // rather than the one they were invited to. Creating an org must be a
    // deliberate act, never the recovery path for a failed sync.
    const activeOrgId = get().session?.activeOrganizationId;
    if (activeOrgId && get().organizations.some((o) => o.id === activeOrgId)) {
      await get().enableSyncForVault();
      if (!get().syncEnabled) {
        throw new Error(
          "Couldn't connect to this vault. Check your connection and try again.",
        );
      }
      return;
    }
    // This binds the folder you're ALREADY in, so every step below has to stay
    // about that folder: a vault switch mid-flight would bind the new org to the
    // folder we left and then reconcile the wrong tree into it. Claim the switch
    // generation too, so a concurrent `setActiveOrganization` supersedes us
    // instead of the two fighting over which vault ends up active.
    const epoch = vault.epoch;
    const gen = ++orgSwitchGen;
    const stale = () => orgSwitchGen !== gen || !sameVault(get, epoch);
    // Unlike createOrganization (which prompts for a fresh folder), this binds
    // the folder you're already in and syncs its existing files up. Create the
    // org directly, bind THIS folder, then let enableSyncForVault reconcile the
    // current tree into the new server vault.
    const org = await createWithUniqueSlug(name?.trim() || vault.name, (input) =>
      authManager.api.createOrganization(input),
    );
    if (stale()) return;
    await authManager.api.setActiveOrganization(org.id);
    if (stale()) return;
    const session = await authManager.currentSession();
    if (stale()) return;
    set({ session });
    await get().refreshVault();
    if (stale()) return;
    rememberOrgVault(org.id, vault.path);
    rememberLastVault(org.id);
    await get().enableSyncForVault();
    if (stale()) return;
    await get().refreshOrgBilling();
  },

  setActiveOrganization: async (organizationId) => {
    const previousOrgId = get().session?.activeOrganizationId ?? null;
    // Claim the switch. Everything below awaits the network, so a second switch
    // (impatient double-click, or a join/accept-invite firing while this one is in
    // flight) would otherwise race us: two interleaved switches would both reach
    // `applyVaultFolder`, and the loser would re-point the Rust vault slot and
    // re-enable sync for the vault the user is no longer in. Same generation
    // pattern as `BridgeManager.generation`, at vault-switch granularity.
    const gen = ++orgSwitchGen;
    const superseded = () => orgSwitchGen !== gen;

    // Announce the destination BEFORE the first await. A switch is many round
    // trips (activate org → re-read session → roster → billing → open the folder
    // → re-enable sync → reconcile), and until the folder actually swaps, the
    // sidebar still shows the vault you just left. Clicking a vault and watching
    // the old one sit there is indistinguishable from the click not registering,
    // so the chrome reads this and renames itself to the target at once.
    set({
      switchingVault: {
        orgId: organizationId,
        // Fall back to the locally-cached vault list for one we haven't listed
        // yet (straight after a join): a generic label beats a blank one.
        name:
          get().organizations.find((o) => o.id === organizationId)?.name ??
          readKnownVaults().find((v) => v.id === organizationId)?.name ??
          "vault",
      },
    });
    try {
      await switchToOrg();
    } finally {
      // Only the newest switch may lower the flag. A superseded one landing late
      // would otherwise declare the switch that replaced it finished.
      if (!superseded()) set({ switchingVault: null });
    }
    return;

    // The switch itself. Inlined as a closure rather than hoisted out of the
    // store because it reads `get`/`set`/`previousOrgId`/`superseded` throughout;
    // it exists purely so the `finally` above has a single place to hook, given
    // the many early returns below.
    async function switchToOrg(): Promise<void> {
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

      // Stop syncing the vault we're leaving before anything else. Everything
      // below awaits the network, and one branch swaps the Rust vault slot
      // (applyVaultFolder) while the other leaves the old folder on screen with a
      // different org active — in both cases the old vault's registry, engine and
      // debounced pull must already be gone. `enableSyncForVault` re-arms sync for
      // whatever vault we land in.
      leaveVaultSync();
      set(vaultScopedSyncReset());

      await authManager.api.setActiveOrganization(organizationId);
      if (superseded()) return;
      const session = await authManager.currentSession();
      if (superseded()) return;
      set({ session });
      await get().refreshVault();
      if (superseded()) return;
      // Seat usage + plan are per-vault, so refresh on every switch.
      await get().refreshOrgBilling();
      if (superseded()) return;

      // Each vault owns its own local folder. If one is already bound, swap
      // to it. If not, do NOT reuse the folder that's currently open — ask the
      // user to choose one (or start empty) via the pending-folder prompt.
      const path = readOrgVaults()[organizationId];
      if (path) {
        try {
          await get().applyVaultFolder(organizationId, path);
          return;
        } catch (e) {
          // The bound folder is unusable (moved, deleted, permissions). Don't
          // return here: that left the user in a vault with no folder and sync
          // off, with nothing on screen saying why. Fall through to the
          // auto-folder path below, which re-creates it under the vaults root.
          console.warn("[vault] bound folder unusable, re-creating", e);
        }
      }
      const org = get().organizations.find((o) => o.id === organizationId);
      const orgName = org?.name ?? "New vault";

      // No folder bound yet. Give this vault one automatically and go straight
      // in, rather than stopping on a "choose a folder" prompt.
      //
      // The prompt was a roadblock in the one flow that most needs to be
      // frictionless: a teammate signing in for the first time doesn't yet have
      // an opinion about which directory their shared vault lives in — they just
      // want to be in it. A folder under the vaults root, named after the vault,
      // is the answer they'd have picked anyway, and relocating it later is one
      // item in the vault switcher menu.
      //
      // The prompt survives as the FALLBACK: if we can't create a folder (a bad
      // vaults root, permissions), asking beats failing silently.
      try {
        const root = await ipc.getVaultsRoot();
        if (superseded()) return;
        const slug = uniqueFolderSlug(orgName, readOrgVaults());
        await get().applyVaultFolder(organizationId, `${root}/${slug}`);
        return;
      } catch (e) {
        console.warn("[vault] auto folder failed; asking instead", e);
        if (superseded()) return;
      }
      set({
        syncEnabled: false,
        pendingVaultFolder: {
          orgId: organizationId,
          orgName,
          previousOrgId: previousOrgId === organizationId ? null : previousOrgId,
        },
      });
    }
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
    // own folder and turns sync on. Accepting an invitation IS asking to work
    // in that vault — landing anywhere else is a bug.
    //
    // `inv` is the client's cached invitation list, which can be stale or
    // missing the row entirely (accepted from another surface, refreshed
    // mid-flight). It used to fall through to a plain roster refresh, which
    // left the user a member of a vault they were never switched into and with
    // sync still off — the exact state whose only visible remedy creates a NEW
    // vault. So when the cache can't say, ask the server which orgs we are now
    // in and switch to the one we didn't have before.
    let orgId = inv?.organizationId ?? null;
    if (!orgId) {
      const before = new Set(get().organizations.map((o) => o.id));
      const session = await authManager.currentSession();
      set({ session });
      await get().refreshVault();
      orgId =
        get().organizations.find((o) => !before.has(o.id))?.id ??
        session?.activeOrganizationId ??
        null;
    }
    if (orgId) {
      await get().setActiveOrganization(orgId);
    }
    // The joiner celebrates locally too (they connect after the server push).
    const me = get().session?.user;
    get().celebrateMemberJoined(me?.name || me?.email || "You");
  },

  joinVault: async (code) => {
    const joined = await authManager.api.joinVault(code.trim());
    // The code was good, so the welcome screen's join flow is over: disarm the
    // landing suppression before switching in (it's module state, and leaving it
    // armed would silently strand the NEXT sign-in on the welcome screen).
    requestJoinWithCode(false);
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
        leaveVaultSync();
        get().closeNote();
        set({
          vault: null,
          ...vaultScopedSyncReset(),
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

  adoptOpenedVault: async (info, opts = {}) => {
    // For the picker paths (`pick_vault`, `create_vault`): Rust opens the vault
    // as part of picking it, so we can't tear down first. The vault epoch is what
    // saves us — it changed the instant Rust swapped, so every in-flight write
    // from the previous vault is already being refused. Retire the scope here so
    // the in-memory half (registry maps, timers, engine) goes with it.
    leaveVaultSync();
    enterVaultScope(
      info,
      opts.resync ? (get().session?.activeOrganizationId ?? null) : null,
    );
    get().closeNote();
    set({
      vault: info,
      ...vaultScopedSyncReset(),
      itemColors: readItemColors(info.path),
      itemOrder: readItemOrder(info.path),
      pendingVaultFolder: null,
    });
    await get().refreshTree();
    await get().refreshTitles();
    if (!sameVault(get, info.epoch)) return;
    if (opts.resync && get().session?.activeOrganizationId) {
      await get().enableSyncForVault();
    } else {
      // Give a brand-new empty folder its first-run welcome content.
      await get().seedLocalVaultIfEmpty();
    }
  },

  openLocalVault: async (path) => {
    // A local vault is a plain folder that isn't syncing to an org. Opening
    // one tears down any active vault sync (we're no longer in that org's
    // folder) and leaves sync off until the user explicitly turns it on.
    //
    // ORDER IS LOAD-BEARING: sync must be torn down BEFORE the Rust vault slot
    // is swapped. With the old ordering, the surviving 250ms registry-pull timer
    // fired after `openVault` and pulled with THIS org's serverVaultId against
    // the NEW folder's tree — creating one vault's structure on the other's
    // server rows and merging their doc maps.
    // Prefer this entry point over `adoptOpenedVault` wherever the caller controls
    // the open, precisely because it can tear down first; `adoptOpenedVault` exists
    // for the picker commands, which open the vault themselves as part of picking.
    leaveVaultSync();
    await get().adoptOpenedVault(await ipc.openVault(path));
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
    leaveVaultSync();
    get().closeNote();
    set({
      vault: null,
      ...vaultScopedSyncReset(),
      pendingVaultFolder: null,
    });
  },

  applyVaultFolder: async (orgId, path) => {
    // Same ordering rule as openLocalVault: retire the previous vault's sync
    // (scope, timers, registry maps) before Rust points at the new folder.
    leaveVaultSync();
    const v = await ipc.openVaultInRoot(path);
    enterVaultScope(v, orgId);
    get().closeNote();
    set({
      vault: v,
      ...vaultScopedSyncReset(),
      itemColors: readItemColors(v.path),
      itemOrder: readItemOrder(v.path),
      pendingVaultFolder: null,
    });
    rememberOrgVault(orgId, v.path);
    rememberLastVault(orgId);
    // Turn sync on BEFORE the tree reads. Those two awaits were the window in
    // which another vault switch (or a `vault-opened` event, or StrictMode's
    // double-open in dev) could make this call stale and skip sync entirely,
    // leaving a freshly joined vault sitting there not syncing. The staleness
    // check still guards the call itself — `enableSyncForVault` re-checks the
    // epoch internally — but it is no longer gated behind work it doesn't need.
    if (sameVault(get, v.epoch)) await get().enableSyncForVault();
    await get().refreshTree();
    await get().refreshTitles();
  },

  chooseVaultFolder: async () => {
    const pending = get().pendingVaultFolder;
    if (!pending) return;
    const picked = await ipc.pickFolder();
    if (!picked) return; // cancelled the native dialog — keep the prompt up
    // The native picker is the longest await in the app (the user browsing their
    // filesystem), so the prompt can be superseded or dismissed while it is open.
    // Binding this folder then would point the Rust vault slot at it on behalf of
    // a vault that is no longer the one being resolved. Same guard as
    // `startEmptyVault`, which has a far shorter window.
    if (get().pendingVaultFolder?.orgId !== pending.orgId) return;
    await get().applyVaultFolder(pending.orgId, picked);
  },

  startEmptyVault: async () => {
    const pending = get().pendingVaultFolder;
    if (!pending) return;
    const root = await ipc.getVaultsRoot();
    // A switch during that read would replace the prompt; binding a folder for the
    // superseded vault would point the Rust slot at the wrong folder.
    if (get().pendingVaultFolder?.orgId !== pending.orgId) return;
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
    const epoch = get().vault?.epoch;
    try {
      const locks = await authManager.api.listVaultLocks(vaultId);
      // Locks are per-vault; publishing another vault's set would badge the
      // wrong rows in the sidebar.
      if (!sameVault(get, epoch) || syncManager.registry.vaultId !== vaultId) return;
      set({ locks });
    } catch (e) {
      console.warn("[locks] refresh failed", e);
      if (!sameVault(get, epoch)) return;
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

  setSyncProgress: (progress) => set({ syncProgress: progress }),

  // Merged rather than replaced: per-doc transitions arrive one (or a batch) at a
  // time over a long run, so a writer never has to hold the whole map. Keys are
  // docIds; a `null` value drops the entry (the doc is no longer tracked).
  patchDocSyncState: (patch) =>
    set((s) => {
      const next = { ...s.docSyncState };
      for (const [docId, state] of Object.entries(patch)) {
        if (state === null) delete next[docId];
        else next[docId] = state;
      }
      return { docSyncState: next };
    }),

  // Replaced, not merged: the registry publishes the whole index for the open
  // vault, so a merge would keep rows for notes it has stopped mapping (deleted,
  // renamed, or belonging to the vault we just left).
  setDocIdByPath: (map) => set({ docIdByPath: map }),

  enableSyncForVault: async () => {
    const { session, vault } = get();
    if (!session || !vault) {
      set({ syncEnabled: false });
      return;
    }
    const orgId = session.activeOrganizationId;
    if (!orgId) {
      set({ syncEnabled: false });
      return;
    }
    // The vault this call is FOR. `reconcile` can take many seconds on a large
    // vault, and the user can switch vaults during it — every `set()` past an
    // await below is gated on this still being the open vault. Without the gate,
    // a finished reconcile for vault A flipped `syncEnabled` back on while vault
    // B was on screen, with the vault engine started for A's server ids.
    const epoch = vault.epoch;
    const stale = () => !sameVault(get, epoch) || get().session?.activeOrganizationId !== orgId;

    // No tree is passed: `store.tree` is the sidebar's LAZY tree (top level only,
    // unexpanded folders hold an empty `children` placeholder), and reconcile
    // needs every note in the vault. It reads the full tree itself.
    const result = await syncManager.enable(session, {
      orgId,
      name: vault.name,
      path: vault.path,
      epoch,
    });
    // `syncManager.enable` already dropped its own work if the scope went stale;
    // this guard keeps the STORE from claiming sync is on for the wrong vault.
    if (stale()) return;
    set({ syncEnabled: result.ok });
    if (result.ok) {
      // Broadcast the user's current activity status on this session's presence.
      syncManager.setPresenceStatus(get().activityStatus);
      // This folder is now the one this vault opens with.
      rememberOrgVault(orgId, vault.path);
      rememberLastVault(orgId);
      // Reconcile may have materialized server-only notes onto disk; refresh so
      // the sidebar reflects the full vault, not just what was already local.
      await get().refreshTree();
      if (stale()) return;
      await get().refreshTitles();
      if (stale()) return;
      await get().refreshLocks();
      if (stale()) return;
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
