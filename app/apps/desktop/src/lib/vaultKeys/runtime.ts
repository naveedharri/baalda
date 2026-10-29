// Client-held vault keys (W3): production wiring of the session.
//
// One session per (server, user), with the shared API client's `X-Baalda-VK`
// resolver pointed at its verified keys. The open vault gets: account check →
// vault key → servicing teammates' key requests, again on registry/member
// frames and every 2 minutes, one run at a time. Everything is a no-op on a
// server without the `vault-keys` feature.

import { api } from "../auth/authManager";
import { serverFeatures } from "../serverFeatures";
import {
  createVaultKeySession,
  type AccountKeysState,
  type PendingDeviceView,
  type ServiceResult,
  type VaultKeySession,
  type VaultKeyState,
} from "./session";
import { keychainPinStore, keychainVaultKeyStore } from "./store";

export const SERVICE_INTERVAL_MS = 2 * 60 * 1000;

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
  | { kind: "pending-devices"; devices: PendingDeviceView[] };

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

/** Record a vault's key state (exported for tests). */
export function noteVaultKeyState(vaultId: string, state: VaultKeyState): void {
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
  running: Promise<void> | null;
  again: boolean;
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
    features: () => serverFeatures(serverUrl, () => api.getHealth()),
    keysAllowed: () => keysAllowed,
    selfUserId: () => userId,
    deviceId: installDeviceId,
    isMember: async (_vaultId, memberId) => {
      const orgId = current?.orgId;
      if (!orgId) return false;
      const { members } = await api.getMembersOverview(orgId);
      return members.some((m) => m.userId === memberId);
    },
  });
  api.setVaultKeyResolver((vaultId) => session.headerFor(vaultId));
  api.setKeyRequiredHandler((vaultId) => vaultKeysEnsure(vaultId));
  current = { key, session, vaultId: null, orgId: null, timer: null, running: null, again: false };
  return current;
}

async function runOnce(): Promise<void> {
  const c = current;
  if (!c?.vaultId) return;
  const vaultId = c.vaultId;
  const account = await c.session.ensureAccountKeys();
  emit({ kind: "account", state: account });
  if (account.state !== "ready") return;
  const devices = await c.session.pendingDevices();
  if (devices.length) emit({ kind: "pending-devices", devices });
  const state = await c.session.ensureVaultKey(vaultId);
  noteVaultKeyState(vaultId, state);
  emit({ kind: "vault", vaultId, state });
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
    .catch((e) => console.warn("[vault-keys] run failed", e instanceof Error ? e.message : e))
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
  if (c.timer) clearInterval(c.timer);
  c.vaultId = opts.vaultId;
  c.orgId = opts.orgId;
  c.timer = setInterval(vaultKeysNudge, SERVICE_INTERVAL_MS);
  vaultKeysNudge();
}

export function vaultKeysClosed(): void {
  blockedVaults.clear();
  if (!current) return;
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
  current.vaultId = null;
  current.orgId = null;
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
