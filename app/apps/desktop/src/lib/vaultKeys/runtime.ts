// Client-held vault keys (W3): production wiring of the session.
//
// One session per (server, user), with the shared API client's `X-Baalda-VK`
// resolver pointed at its verified keys. The open vault gets: account check →
// vault key → servicing teammates' key requests, again on registry/member
// frames and every 2 minutes, one run at a time. Everything is a no-op on a
// server without the `vault-keys` feature.

import { api } from "../auth/authManager";
import { rateLimitedMessage, type AllowlistCandidate } from "../api";
import { runFreshAccountKey, type FreshKeyResult } from "./recovery";
import {
  createVaultKeySession,
  type AccountKeysState,
  type PendingDeviceView,
  type ServiceResult,
  type VaultKeySession,
  type VaultKeyState,
} from "./session";
import { forgetOrgVaultIds, forgetVaultKeyMaterial, rememberOrgVault, vaultIdsForOrg } from "./forget";
import { keychainPinStore, keychainVaultKeyStore } from "./store";

export const SERVICE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * The server's features, or a THROW when `/health` gave no answer. Unknown must
 * never read as "no vault keys": that would lift the open-time pause on a flaky
 * network. A known answer is reused for a minute.
 */
let featureMemo: { url: string; at: number; set: ReadonlySet<string> } | null = null;
async function knownFeatures(): Promise<ReadonlySet<string>> {
  const url = api.getBaseUrl();
  if (featureMemo && featureMemo.url === url && Date.now() - featureMemo.at < 60_000) return featureMemo.set;
  const health = await api.getHealth().catch(() => null);
  if (!health) throw new Error("server features unknown");
  featureMemo = { url, at: Date.now(), set: new Set(health.features) };
  return featureMemo.set;
}

const DEVICE_ID_KEY = "context.vaultKeys.deviceId";
/** Stable, non-secret id of this install (a pending device is keyed by it). */
function installDeviceId(): string {
  try {
    const have = localStorage.getItem(DEVICE_ID_KEY);
    if (have) return have;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return (memoDeviceId ??= crypto.randomUUID());
  }
}
let memoDeviceId: string | null = null;

export type VaultKeyEvent =
  | { kind: "account"; state: AccountKeysState }
  | { kind: "vault"; vaultId: string; state: VaultKeyState }
  | { kind: "serviced"; vaultId: string; result: ServiceResult }
  /** Another device asks to sign in as us: "Approve?" with its code. */
  | { kind: "pending-devices"; devices: PendingDeviceView[] }
  /** The server's churn brake refused a key step (429 rate_limited): its plain message. */
  | { kind: "rate-limited"; message: string }
  /** Lost every device: a new account key exists; teammates confirm `code`. */
  | { kind: "fresh-key"; code: string }
  /** Converting: the owner reviews these connections before any is allow-listed. */
  | { kind: "conversion-review"; vaultId: string; candidates: AllowlistCandidate[] };

const listeners = new Set<(e: VaultKeyEvent) => void>();
/** UI: recovery kit, "<name>'s security key changed", the "given access" toast. */
export function onVaultKeyEvent(cb: (e: VaultKeyEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const emit = (e: VaultKeyEvent) => {
  for (const cb of listeners) cb(e);
};

/**
 * Vaults whose key this device KNOWS it lacks. While a vault is here every
 * structural sync step pauses (`InboundHost.structurePaused`), exactly like a
 * missing vault root: nothing is materialized, registered, moved or deleted
 * until the key arrives. Local files and edits stay as they are.
 */
const blockedVaults = new Set<string>();
const blockListeners = new Set<(vaultId: string, blocked: boolean) => void>();

/** The states in which the vault is keyed but this device cannot use it. */
export function blocksStructure(state: VaultKeyState): boolean {
  return (
    state.state === "waiting-for-teammate" ||
    state.state === "needs-account-key" ||
    state.state === "key-mismatch" ||
    state.state === "security-warning"
  );
}

export function isVaultKeyBlocked(vaultId: string | null | undefined): boolean {
  return !!vaultId && blockedVaults.has(vaultId);
}

export function onVaultKeyBlockChange(cb: (vaultId: string, blocked: boolean) => void): () => void {
  blockListeners.add(cb);
  return () => blockListeners.delete(cb);
}

/** The last known key state per vault, for Vault Settings (absent = unknown). */
const lastStates = new Map<string, VaultKeyState>();
export function vaultKeyStateFor(vaultId: string | null | undefined): VaultKeyState | null {
  return (vaultId && lastStates.get(vaultId)) || null;
}

/** Record a vault's key state (exported for tests). */
export function noteVaultKeyState(vaultId: string, state: VaultKeyState): void {
  lastStates.set(vaultId, state);
  const was = blockedVaults.has(vaultId);
  const now = blocksStructure(state);
  if (now) blockedVaults.add(vaultId);
  else blockedVaults.delete(vaultId);
  if (was !== now) for (const cb of blockListeners) cb(vaultId, now);
}

/** Product switch for keying an UNKEYED vault (off until the rollout). */
let keysAllowed = false;
export function setVaultKeysAllowed(on: boolean): void {
  keysAllowed = on;
}

let current: {
  key: string;
  session: VaultKeySession;
  vaultId: string | null;
  orgId: string | null;
  timer: ReturnType<typeof setInterval> | null;
  conversionTimer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  again: boolean;
  account: AccountKeysState | null;
} | null = null;

function sessionFor(userId: string) {
  const serverUrl = api.getBaseUrl();
  const key = `${serverUrl}|${userId}`;
  if (current?.key === key) return current;
  vaultKeysClosed();
  current?.session.dispose();
  const session = createVaultKeySession({
    api,
    keys: keychainVaultKeyStore(serverUrl, userId),
    pins: keychainPinStore(serverUrl, userId),
    features: knownFeatures,
    keysAllowed: () => keysAllowed,
    selfUserId: () => userId,
    deviceId: installDeviceId,
    reviewConnections: true,
    canConvert: async () => {
      const orgId = current?.orgId;
      if (!orgId) return false;
      const { members } = await api.getMembersOverview(orgId);
      const role = members.find((m) => m.userId === userId)?.role;
      return role === "owner" || role === "admin";
    },
    isMember: async (_vaultId, memberId) => {
      const orgId = current?.orgId;
      if (!orgId) return false;
      const { members } = await api.getMembersOverview(orgId);
      return members.some((m) => m.userId === memberId);
    },
  });
  api.setVaultKeyResolver((vaultId) => session.headerFor(vaultId));
  api.setKeyRequiredHandler((vaultId) => vaultKeysEnsure(vaultId));
  current = { key, session, vaultId: null, orgId: null, timer: null, conversionTimer: null, running: null, again: false, account: null };
  return current;
}

export const CONVERSION_POLL_MS = 60 * 1000;

async function runOnce(): Promise<void> {
  const c = current;
  if (!c?.vaultId) return;
  const vaultId = c.vaultId;
  const account = await c.session.ensureAccountKeys();
  c.account = account;
  if (account.state === "ready") {
    // A remembered fresh-key code that is no longer this device's key is stale.
    const remembered = freshAccountKeyCode();
    if (remembered && remembered !== (await c.session.accountKeyCode())) rememberFreshCode(c.key, null);
  }
  emit({ kind: "account", state: account });
  if (account.state === "ready") {
    const devices = await c.session.pendingDevices();
    if (devices.length) emit({ kind: "pending-devices", devices });
  }
  // The vault's own state is asked even without a ready account key: an
  // unkeyed vault must be able to leave the open-time pause.
  const state = await c.session.ensureVaultKey(vaultId);
  noteVaultKeyState(vaultId, state);
  emit({ kind: "vault", vaultId, state });
  if (state.state === "unkeyed" && state.conversionAllowed) {
    const conv = await c.session.convertVault(vaultId);
    if (conv === "converted") {
      const ready: VaultKeyState = { state: "ready", generation: 1, created: true };
      noteVaultKeyState(vaultId, ready);
      emit({ kind: "vault", vaultId, state: ready });
    } else if (conv === "needs-review") {
      const candidates = c.session.pendingConversionReview(vaultId);
      if (candidates) emit({ kind: "conversion-review", vaultId, candidates });
    }
    if ((conv === "waiting-ready" || conv === "needs-review") && !c.conversionTimer) {
      // Keep the pending key warm: ask again every minute while open.
      c.conversionTimer = setTimeout(() => {
        c.conversionTimer = null;
        if (current === c) vaultKeysNudge();
      }, CONVERSION_POLL_MS);
    }
    return;
  }
  if (state.state !== "ready") return;
  const result = await c.session.serviceKeyRequests(vaultId);
  if (result.sealed.length || result.keyChanged.length) emit({ kind: "serviced", vaultId, result });
}

/** Single-flight: a nudge during a run schedules exactly one more. */
export function vaultKeysNudge(): void {
  const c = current;
  if (!c?.vaultId) return;
  if (c.running) {
    c.again = true;
    return;
  }
  c.running = runOnce()
    .catch((e) => {
      // A linking device's registration hit the hourly brake: say so once
      // per run; the next run retries (nothing was stored either side).
      const limited = rateLimitedMessage(e);
      if (limited) emit({ kind: "rate-limited", message: limited });
      console.warn("[vault-keys] run failed", e instanceof Error ? e.message : e);
    })
    .finally(() => {
      c.running = null;
      if (c.again && current === c) {
        c.again = false;
        vaultKeysNudge();
      }
    });
}

/** The vault's sync channel started: key it, then keep servicing requests. */
export function vaultKeysOpened(opts: { userId: string; vaultId: string; orgId: string }): void {
  const c = sessionFor(opts.userId);
  rememberOrgVault(api.getBaseUrl(), opts.userId, opts.orgId, opts.vaultId);
  if (c.timer) clearInterval(c.timer);
  c.vaultId = opts.vaultId;
  c.orgId = opts.orgId;
  c.timer = setInterval(vaultKeysNudge, SERVICE_INTERVAL_MS);
  vaultKeysNudge();
}

export function vaultKeysClosed(): void {
  blockedVaults.clear();
  lastStates.clear();
  if (!current) return;
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
  if (current.conversionTimer) clearTimeout(current.conversionTimer);
  current.conversionTimer = null;
  current.vaultId = null;
  current.orgId = null;
}

export const VAULT_KEY_GATE_TIMEOUT_MS = 20_000;
export const VAULT_KEY_PAUSE_REASON = "vault-key";

/**
 * The open-time gate (first sync pass). Proceeds only on a KNOWN safe answer:
 * the server answered `/health` without `vault-keys`, or the vault is unkeyed,
 * or its key is held and verified. Unknown (unreachable health, an error, the
 * timeout) or a keyed vault without its key pauses: the vault is marked
 * blocked, the retry loop keeps asking, and the caller re-runs on unblock.
 */
export async function vaultKeysGate(opts: {
  userId: string;
  vaultId: string;
  orgId: string;
  timeoutMs?: number;
}): Promise<"proceed" | "paused"> {
  const decide = async (): Promise<"proceed" | "paused"> => {
    const features = await knownFeatures().catch(() => null);
    if (!features) return "paused";
    if (!features.has("vault-keys")) return "proceed";
    const c = sessionFor(opts.userId);
    c.orgId = opts.orgId;
    rememberOrgVault(api.getBaseUrl(), opts.userId, opts.orgId, opts.vaultId);
    return c.session.gateVaultOpen(opts.vaultId);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"paused">((resolve) => {
    timer = setTimeout(() => resolve("paused"), opts.timeoutMs ?? VAULT_KEY_GATE_TIMEOUT_MS);
  });
  const verdict = await Promise.race([decide().catch(() => "paused" as const), timeout]);
  if (timer) clearTimeout(timer);
  if (verdict === "paused") {
    markVaultKeyUnknown(opts.vaultId);
    // Keep asking (2-minute loop + now); a known safe answer unblocks.
    vaultKeysOpened({ userId: opts.userId, vaultId: opts.vaultId, orgId: opts.orgId });
  }
  return verdict;
}

/**
 * May the vault channel open EARLY (the prime window, before the W3 gate)?
 * Only on a KNOWN answer: unkeyed/disabled, or the verified key already held.
 * Unknown (no state yet, the normal launch) waits for the gate, which starts the
 * channel once it proceeds; opening first only earns a 4409 `key_required`.
 */
export function earlyVaultChannelAllowed(state: VaultKeyState | null, keyHeld: boolean): boolean {
  if (keyHeld) return true;
  return state?.state === "unkeyed" || state?.state === "disabled";
}

/**
 * The prime window's full early-channel check (injected into the SyncManager by
 * `store.ts`). A known answer of either kind decides at once; otherwise the
 * server's features decide: a server that ANSWERED `/health` without
 * `vault-keys` has no keyed vaults, so the channel opens early exactly as it did
 * before vault keys. Unknown features, or a `vault-keys` server whose key state
 * is not known yet, wait for the gate (no 4409 `key_required` at startup).
 */
export function vaultKeysEarlyChannel(vaultId: string): boolean | Promise<boolean> {
  if (earlyVaultChannelAllowed(vaultKeyStateFor(vaultId), !!api.vaultKeyFor(vaultId))) return true;
  return knownFeatures().then(
    (features) => !features.has("vault-keys"),
    () => false,
  );
}

/** Paused for an unknown key state: blocked until a known answer arrives. */
export function markVaultKeyUnknown(vaultId: string): void {
  if (blockedVaults.has(vaultId)) return;
  blockedVaults.add(vaultId);
  for (const cb of blockListeners) cb(vaultId, true);
}

/** Ensure the open vault's key now (a `key_required` refusal); true when ready. */
export async function vaultKeysEnsure(vaultId: string): Promise<boolean> {
  const c = current;
  if (!c) return false;
  const state = await c.session.ensureVaultKey(vaultId);
  noteVaultKeyState(vaultId, state);
  emit({ kind: "vault", vaultId, state });
  return state.state === "ready";
}

/** Connections waiting for the owner's review of the open vault's conversion. */
export function pendingConversionReview(vaultId: string | null | undefined): AllowlistCandidate[] | null {
  return (vaultId && current?.session.pendingConversionReview(vaultId)) || null;
}

/** The owner answered the review (`keep` = checked candidate keys): post it now. */
export function submitConversionReview(vaultId: string, keep: ReadonlySet<string>): void {
  current?.session.submitConversionReview(vaultId, keep);
  vaultKeysNudge();
}

/** The open session, for the approval/restore screens. */
export function currentVaultKeySession(): VaultKeySession | null {
  return current?.session ?? null;
}

/**
 * Lost every device: start a new account key (`session.startFreshAccountKey`).
 * The server is asked first, so a churn-brake refusal (429 rate_limited)
 * changes nothing locally; its plain message goes to the toast. On success the
 * new key's code is remembered (it is a public fingerprint, not a secret) so
 * the waiting notice can keep showing it across restarts, and the run is
 * nudged so the vault moves to "waiting for a teammate". Local files and any
 * vault key this device holds are never touched.
 */
export async function startFreshAccountKey(): Promise<FreshKeyResult> {
  const c = current;
  if (!c) return { kind: "not-allowed" };
  const result = await runFreshAccountKey(c.session);
  if (result.kind === "rate-limited") emit({ kind: "rate-limited", message: result.message });
  if (result.kind === "started") {
    rememberFreshCode(c.key, result.code);
    emit({ kind: "fresh-key", code: result.code });
    vaultKeysNudge();
  }
  return result;
}

const FRESH_CODES_KEY = "context.vaultKeys.freshKeyCodes.v1";
function readFreshCodes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FRESH_CODES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
const memoFreshCodes = new Map<string, string | null>();
function rememberFreshCode(scope: string, code: string | null): void {
  memoFreshCodes.set(scope, code);
  try {
    const all = readFreshCodes();
    if (code) all[scope] = code;
    else delete all[scope];
    localStorage.setItem(FRESH_CODES_KEY, JSON.stringify(all));
  } catch {
    /* memory copy only */
  }
}

/** The code of a fresh account key started on this computer (for this server
 *  and user) that teammates still have to confirm, else null. */
export function freshAccountKeyCode(): string | null {
  const scope = current?.key;
  if (!scope) return null;
  if (memoFreshCodes.has(scope)) return memoFreshCodes.get(scope) ?? null;
  return readFreshCodes()[scope] ?? null;
}

/**
 * This person's own security code for Account Settings, or null when vault
 * keys are off here, no account key is held, or the session has not confirmed
 * it matches the server's (`ownSecurityCodeView`).
 */
export async function ownSecurityCode(): Promise<string | null> {
  const c = current;
  if (!c || c.account?.state !== "ready") return null;
  return c.session.accountKeyCode().catch(() => null);
}

/** The last account state the open session reported (null = not asked yet). */
export function accountKeyStateNow(): AccountKeysState | null {
  return current?.account ?? null;
}

/**
 * Membership of `orgId` ended, or the vault is gone, per a DEFINITIVE server
 * answer (callers: `handleMembershipLost`, `deleteRemoteVault`,
 * `unsyncLocalTeardown`; never a network error). Deletes this device's key and
 * provisional marker for every collection id known for the org (+ the folder
 * stamp's `vaultIdHint`) and forgets the in-memory verified key and state. The
 * account key, device-link key and teammate pins are never touched. Local files
 * are not this function's business: their fate is the caller's, unchanged.
 */
export async function vaultKeysMembershipEnded(opts: {
  /** Default: the shared API client's server (the one the session keys use). */
  serverUrl?: string;
  userId: string;
  orgId: string;
  vaultIdHint?: string | null;
}): Promise<string[]> {
  const serverUrl = opts.serverUrl ?? api.getBaseUrl();
  const ids = new Set(vaultIdsForOrg(serverUrl, opts.userId, opts.orgId));
  if (opts.vaultIdHint) ids.add(opts.vaultIdHint);
  const sameScope = current?.key === `${serverUrl}|${opts.userId}`;
  for (const id of ids) {
    if (sameScope) current?.session.forgetVerified(id);
    lastStates.delete(id);
    // A blocked vault STAYS blocked: an unblock would re-run its sync pass.
  }
  const done = await forgetVaultKeyMaterial(keychainVaultKeyStore(serverUrl, opts.userId), ids);
  if (done.length === ids.size) forgetOrgVaultIds(serverUrl, opts.userId, opts.orgId);
  return done;
}
