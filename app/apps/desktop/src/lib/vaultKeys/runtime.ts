// Client-held vault keys (W3): production wiring of the session.
//
// One session per (server, user), with the shared API client's `X-Baalda-VK`
// resolver pointed at its verified keys. The open vault gets: account check →
// vault key → servicing teammates' key requests, again on registry/member
// frames and every 2 minutes, one run at a time. Everything is a no-op on a
// server without the `vault-keys` feature.

import { api } from "../auth/authManager";
import {
  ApiError,
  rateLimitedMessage,
  type InviteManyInput,
  type InviteManyResult,
} from "../api";
import { decodeSecret, encodeCrockford, newSecret, secretHash, type SecretPurpose } from "./crypto";
import { getKeychainString, joinSecretName, setKeychainString } from "./store";
import { runFreshAccountKey, type FreshKeyResult } from "./recovery";
import {
  createVaultKeySession,
  type AccountKeysState,
  type PendingDeviceView,
  type ServiceResult,
  type VaultKeySession,
  type VaultKeyState,
} from "./session";
import {
  forgetOrgVaultIds,
  forgetVaultKeyMaterial,
  knownOrgVaults,
  orgOfVault,
  rememberOrgVault,
  vaultIdsForOrg,
} from "./forget";
import { keychainPinStore, keychainVaultKeyStore } from "./store";

// ── invite secret S / join suffix J (seamless keys B4/B5, C) ────────────────
// Memory only (never localStorage, never logged): held until the vault opens,
// at most `SECRET_HOLD_MS`, then used once to fetch and open the wrapped key.

export const SECRET_HOLD_MS = 30 * 60 * 1000;
const inviteSecrets = new Map<string, { secret: string; until: number }>();
const orgSecrets = new Map<string, { purpose: SecretPurpose; secret: string; until: number }>();

/** Canonical form (Crockford, upper case) or null when it is not a secret. */
function canonicalSecret(secret: string | null | undefined): string | null {
  const raw = secret ? decodeSecret(secret) : null;
  if (!raw) return null;
  const out = encodeCrockford(raw);
  raw.fill(0);
  return out;
}

/** B5: the `k` of a `baalda://invite/<id>?k=…` link, until the invite is accepted. */
export function rememberInviteSecret(invitationId: string, secret: string | null | undefined): void {
  const s = canonicalSecret(secret);
  if (s) inviteSecrets.set(invitationId, { secret: s, until: Date.now() + SECRET_HOLD_MS });
}

/** The invitation was accepted into `orgId`: its secret now waits for that vault. */
export function claimInviteSecret(invitationId: string, orgId: string): void {
  const held = inviteSecrets.get(invitationId);
  inviteSecrets.delete(invitationId);
  if (held && held.until > Date.now()) orgSecrets.set(orgId, { purpose: "invite", secret: held.secret, until: held.until });
}

/** C: joined `orgId` with `<code>-<J>`: J waits for that vault to open. */
export function offerJoinSecret(orgId: string, secret: string | null | undefined): void {
  const s = canonicalSecret(secret);
  if (s) orgSecrets.set(orgId, { purpose: "join", secret: s, until: Date.now() + SECRET_HOLD_MS });
}

/** Split a typed join code `<code>-<J>`: the part after the first `-` when it is a secret. */
export function joinCodeSecret(typed: string): string | null {
  const t = typed.trim();
  const dash = t.indexOf("-");
  return dash > 0 ? canonicalSecret(t.slice(dash + 1)) : null;
}

/** Fetch + open the wrapped key a held secret unlocks for this vault (once). */
async function consumeSecretFor(session: VaultKeySession, userId: string, orgId: string | null, vaultId: string) {
  if (!orgId) return;
  const held = orgSecrets.get(orgId);
  if (!held) return;
  if (held.until <= Date.now()) {
    orgSecrets.delete(orgId);
    return;
  }
  try {
    const wraps =
      held.purpose === "invite"
        ? await api.getInviteWraps(vaultId)
        : await api.getJoinWrap(vaultId, secretHash(held.secret)).then((w) => (w ? [w] : []));
    const result = await session.adoptFromSecret(vaultId, held.purpose, held.secret, wraps);
    // Any definitive answer ends it; a network error keeps it for the next run.
    orgSecrets.delete(orgId);
    if (result === "adopted" || result === "already") rememberOrgVault(api.getBaseUrl(), userId, orgId, vaultId);
  } catch (e) {
    console.warn("[vault-keys] secret key fetch failed", e instanceof ApiError ? e.status : "error");
  }
}

/**
 * B1/B2: invite, wrapping the vault key for each invitee when THIS device
 * holds the org's verified key. Without it, or if the key part is refused,
 * the invitation goes exactly as before.
 */
export async function inviteWithVaultKeys(orgId: string, input: InviteManyInput): Promise<InviteManyResult[]> {
  const c = current;
  const [serverUrl, userId] = c ? splitScope(c.key) : ["", ""];
  const vaultId = c
    ? [...(c.orgId === orgId && c.vaultId ? [c.vaultId] : []), ...vaultIdsForOrg(serverUrl, userId, orgId)].find(
        (id) => c.session.headerFor(id),
      ) ?? null
    : null;
  let material: ReturnType<VaultKeySession["inviteKeyMaterial"]> = null;
  try {
    material = c && vaultId ? c.session.inviteKeyMaterial(vaultId, input.emails) : null;
  } catch {
    material = null;
  }
  if (!c || !vaultId || !material) return api.inviteMany(orgId, input);
  let results: InviteManyResult[];
  try {
    results = await api.inviteMany(orgId, { ...input, vaultKeys: material.vaultKeys }, material.vkBase64);
  } catch (e) {
    // The key proof was refused (key_required / outdated): invite as today.
    if (e instanceof ApiError && (e.status === 409 || e.status === 426)) return api.inviteMany(orgId, input);
    throw e;
  }
  await c.session.sealInviteResults(vaultId, results).catch(() => []);
  return results;
}

/**
 * C: the join code to SHOW. An admin device holding the org's verified key
 * shows `<code>-<J>` (J in the keychain per server/org/code/generation, its
 * wrap uploaded once); anything else, or any failure, shows the plain code.
 */
export async function vaultKeysJoinCode(orgId: string, code: string): Promise<string> {
  try {
    const c = current;
    if (!c || !code) return code;
    const [serverUrl, userId] = splitScope(c.key);
    const ids = [...(c.orgId === orgId && c.vaultId ? [c.vaultId] : []), ...vaultIdsForOrg(serverUrl, userId, orgId)];
    const vaultId = ids.find((id) => c.session.headerFor(id));
    const generation = vaultId ? c.session.heldGeneration(vaultId) : null;
    if (!vaultId || generation == null) return code;
    const name = joinSecretName(serverUrl, orgId, code, generation);
    let secret = canonicalSecret(await getKeychainString(name));
    if (!secret) {
      secret = newSecret();
      await setKeychainString(name, secret);
    }
    if ((await getKeychainString(`${name}|up`)) !== "1") {
      const r = await c.session.uploadJoinWrap(vaultId, secret, code);
      if (r !== "stored") return code;
      await setKeychainString(`${name}|up`, "1");
    }
    return `${code}-${secret}`;
  } catch (e) {
    console.warn("[vault-keys] join code key skipped", e instanceof ApiError ? e.status : "error");
    return code;
  }
}

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
  /** `names`: display names from THAT vault's own roster (userId → name). */
  | { kind: "serviced"; vaultId: string; result: ServiceResult; names?: Record<string, string> }
  /** Another device asks to sign in as us: "Approve?" with its code. */
  | { kind: "pending-devices"; devices: PendingDeviceView[] }
  /** The server's churn brake refused a key step (429 rate_limited): its plain message. */
  | { kind: "rate-limited"; message: string }
  /** Lost every device: a new account key exists; teammates confirm `code`. */
  | { kind: "fresh-key"; code: string };

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

/**
 * The roster a membership check reads: the vault's OWN org (background
 * servicing covers vaults other than the open one), else the open org. One
 * overview per org per minute, so N vaults x 50 requests is not N x 50 calls.
 */
type RosterRow = { userId: string; role?: string; name?: string | null; email?: string | null };
const rosterMemo = new Map<string, { at: number; members: Promise<RosterRow[]> }>();
const ROSTER_TTL_MS = 60_000;
function rosterOf(orgId: string): Promise<RosterRow[]> {
  const hit = rosterMemo.get(orgId);
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.members;
  const members = api.getMembersOverview(orgId).then((r) => r.members);
  members.catch(() => rosterMemo.delete(orgId));
  rosterMemo.set(orgId, { at: Date.now(), members });
  return members;
}

function sessionFor(userId: string) {
  const serverUrl = api.getBaseUrl();
  const key = `${serverUrl}|${userId}`;
  if (current?.key === key) return current;
  vaultKeysClosed();
  current?.session.dispose();
  rosterMemo.clear();
  const orgFor = (vaultId: string) => orgOfVault(serverUrl, userId, vaultId) ?? current?.orgId ?? null;
  const session = createVaultKeySession({
    api,
    keys: keychainVaultKeyStore(serverUrl, userId),
    pins: keychainPinStore(serverUrl, userId),
    features: knownFeatures,
    keysAllowed: () => keysAllowed,
    selfUserId: () => userId,
    deviceId: installDeviceId,
    canConvert: async (vaultId) => {
      const orgId = orgFor(vaultId);
      if (!orgId) return false;
      // Fresh roster: a role change must not ride a cached answer.
      const { members } = await api.getMembersOverview(orgId);
      const role = members.find((m) => m.userId === userId)?.role;
      return role === "owner" || role === "admin";
    },
    isMember: async (vaultId, memberId) => {
      const orgId = orgFor(vaultId);
      if (!orgId) return false;
      return (await rosterOf(orgId)).some((m) => m.userId === memberId);
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
  await consumeSecretFor(c.session, splitScope(c.key)[1], c.orgId, vaultId);
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
      // Right after keys/init: seal to every current member now, not in 2 min.
      rosterMemo.clear();
      await serviceVault(c, vaultId);
      await serviceOtherVaults(c, vaultId);
      return;
    }
    // `not-safe-yet` waits for the normal 2-minute run (it turns safe once the
    // person types their password, a teammate gets an account key, etc.).
    if (conv === "waiting-ready" && !c.conversionTimer) {
      // Keep the pending key warm: ask again every minute while open.
      c.conversionTimer = setTimeout(() => {
        c.conversionTimer = null;
        if (current === c) vaultKeysNudge();
      }, CONVERSION_POLL_MS);
    }
    return;
  }
  if (state.state === "ready") await serviceVault(c, vaultId);
  await serviceOtherVaults(c, vaultId);
}

async function serviceVault(c: NonNullable<typeof current>, vaultId: string): Promise<void> {
  const result = await c.session.serviceAllKeyRequests(vaultId);
  if (!result.sealed.length && !result.keyChanged.length) return;
  emit({ kind: "serviced", vaultId, result, names: await namesFor(c, vaultId, result) });
}

/** Names for the toast from the vault's OWN org roster (the cached one the
 *  membership check read), so a background vault's seal is named right. */
async function namesFor(c: NonNullable<typeof current>, vaultId: string, result: ServiceResult) {
  const [serverUrl, userId] = splitScope(c.key);
  const orgId = orgOfVault(serverUrl, userId, vaultId) ?? c.orgId;
  if (!orgId) return undefined;
  try {
    const roster = await rosterOf(orgId);
    const names: Record<string, string> = {};
    for (const s of [...result.sealed, ...result.keyChanged]) {
      const m = roster.find((r) => r.userId === s.userId);
      const name = m?.name?.trim() || m?.email || "";
      if (name) names[s.userId] = name;
    }
    return names;
  } catch {
    return undefined;
  }
}

/**
 * Every OTHER vault this device holds a key for on this server + account
 * (the ones recorded by `rememberOrgVault`): verify the held key against the
 * server's check, then seal to whoever is listed. Never touches the open-vault
 * block state (`noteVaultKeyState`). One vault's failure never stops the rest.
 */
async function serviceOtherVaults(c: NonNullable<typeof current>, openVaultId: string): Promise<void> {
  const [serverUrl, userId] = splitScope(c.key);
  if (!userId) return;
  const seen = new Set<string>([openVaultId]);
  for (const [, vaultId] of knownOrgVaults(serverUrl, userId)) {
    if (seen.has(vaultId) || current !== c) continue;
    seen.add(vaultId);
    try {
      if (!(await c.session.holdsVaultKey(vaultId))) continue;
      const state = await c.session.ensureVaultKey(vaultId);
      if (state.state === "ready") await serviceVault(c, vaultId);
    } catch (e) {
      console.warn("[vault-keys] background re-share failed for one vault", e instanceof Error ? e.message : e);
    }
  }
}

function splitScope(key: string): [string, string] {
  const at = key.lastIndexOf("|");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

/**
 * Seamless keys F: right after a successful password sign-in, and at launch
 * with a remembered password. The password is used for one call and dropped;
 * every failure (wrong password, throttle, server without F) leaves one-click
 * approval in charge and never blocks the sign-in.
 */
export async function vaultKeysPasswordUnlock(userId: string, password: string): Promise<void> {
  try {
    const c = sessionFor(userId);
    const result = await c.session.unlockWithPassword(password);
    if (result === "unlocked" && c.vaultId) vaultKeysNudge();
  } catch (e) {
    const limited = rateLimitedMessage(e);
    if (limited) emit({ kind: "rate-limited", message: limited });
    console.warn("[vault-keys] password unlock skipped", e instanceof ApiError ? e.status : "error");
  }
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
    await consumeSecretFor(c.session, opts.userId, opts.orgId, opts.vaultId);
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
