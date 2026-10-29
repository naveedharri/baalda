// Client-held vault keys (W3): the session state machine.
//
// Dependency-injected like the bridge (api, keychain store, server features,
// membership check), so it runs under vitest in Node. Not wired into sync yet.
//
// Rules this module enforces:
// - Only a key that opens the server's `vk_check` is ever used or sent (the
//   `X-Baalda-VK` header reads `headerFor`, which serves verified keys only).
// - Only devices seal: a key holder seals the VK to a requester's public key,
//   and only after the membership check confirms the requester is a current
//   member. The server never opens a sealed box.
// - Trust on first use: the first seal to a member pins their key fingerprint
//   (keychain); a later different key is refused and reported, never sealed.
// - Every launch checks the server's public key for this account is ours.
// - Without the server's `vault-keys` feature every step is a no-op.

import type {
  AccountKeysBody,
  MyVaultKeys,
  PendingDevice,
  VaultKeyInit,
  VaultKeyRequest,
  VaultKeyWrapPost,
} from "../api";
import { ApiError } from "../api";
import { VAULT_KEYS } from "../serverFeatures";
import {
  fromBase64,
  deviceCode,
  generateAccountKeypair,
  generateVaultKey,
  keyFingerprint,
  makeVkCheck,
  openSealed,
  openSealedVk,
  publicKeyFromPrivate,
  sealTo,
  sealVkTo,
  shortFingerprint,
  toBase64,
  verifyVk,
  vaultKeyToWords,
  wordsToVaultKey,
} from "./crypto";

export interface VaultKeysApi {
  initVaultKeys(vaultId: string, body: VaultKeyInit): Promise<"created" | "already-keyed">;
  getMyVaultKeys(vaultId: string): Promise<MyVaultKeys>;
  listVaultKeyRequests(vaultId: string): Promise<VaultKeyRequest[]>;
  postVaultKeyWrap(vaultId: string, wrap: VaultKeyWrapPost, vkBase64: string): Promise<void>;
  putMyKeys(body: AccountKeysBody): Promise<void>;
  getMyKeys(): Promise<AccountKeysBody | null>;
  registerPendingDevice(deviceId: string, publicKey: string): Promise<void>;
  listPendingDevices(): Promise<PendingDevice[]>;
  getDeviceKey(deviceId: string): Promise<string | null>;
  putDeviceKey(deviceId: string, privWrapped: string): Promise<void>;
  denyDevice(deviceId: string): Promise<void>;
}

/** The keychain store, scoped to the current server + user by the caller. */
export interface VaultKeyStore {
  getAccountPrivateKey(): Promise<Uint8Array | null>;
  /** The ephemeral link-a-device key while this device waits for approval. */
  getDeviceLinkKey(): Promise<Uint8Array | null>;
  setDeviceLinkKey(key: Uint8Array): Promise<void>;
  deleteDeviceLinkKey(): Promise<void>;
  setAccountPrivateKey(key: Uint8Array): Promise<void>;
  getVaultKey(vaultId: string): Promise<Uint8Array | null>;
  setVaultKey(vaultId: string, vk: Uint8Array): Promise<void>;
  clearCache(): void;
}

/** Trust-on-first-use pins of members' public-key fingerprints (keychain). */
export interface KeyPinStore {
  get(userId: string): Promise<string | null>;
  set(userId: string, fingerprint: string): Promise<void>;
}

export interface VaultKeySessionDeps {
  api: VaultKeysApi;
  keys: VaultKeyStore;
  pins: KeyPinStore;
  /** The server's `/health` features (`cachedServerFeatures`). */
  features(): Promise<ReadonlySet<string>>;
  /** May this device key an unkeyed vault? (owner/admin + product flag) */
  keysAllowed(vaultId: string): boolean;
  /** Is `userId` a CURRENT member of the vault, per the members API? */
  isMember(vaultId: string, userId: string): Promise<boolean>;
  /** The signed-in user's id (to seal a restored key to ourselves). */
  selfUserId(): string | null;
  /** Stable id of this app install (not secret). */
  deviceId(): string;
}

export type AccountKeysState =
  | { state: "disabled" }
  | { state: "ready"; isNew: boolean }
  /** Link-a-device: approve from another computer showing the same code. */
  | { state: "awaiting-device-approval"; code: string }
  /** The server's public key for this account is not this device's: refuse keys. */
  | { state: "security-warning" };

export type VaultKeyState =
  | { state: "disabled" }
  | { state: "security-warning" }
  /** `created`: this device just keyed the vault: show "Save your vault key". */
  | { state: "ready"; generation: number; created?: true }
  | { state: "waiting-for-teammate" }
  | { state: "unkeyed" }
  | { state: "needs-account-key" }
  /** The only key on offer does not open `vk_check`: never used. */
  | { state: "key-mismatch" };

export type RestoreResult =
  | "restored"
  | "invalid-words"
  | "wrong-key"
  | "cannot-verify"
  | "disabled"
  | "security-warning";

export type PendingDeviceView = PendingDevice & { code: string };

export type SealedFor = { userId: string; fingerprint: string };
export type ServiceResult = {
  /** Sealed: the toast shows `fingerprint` (short form). */
  sealed: SealedFor[];
  /** Not a current member, or a malformed key. */
  refused: string[];
  /** Pinned key differs: "<name>'s security key changed". Never auto-sealed;
   *  only `approveChangedKey` after the person confirms the code. */
  keyChanged: (SealedFor & { publicKey: string })[];
};

const sessions = new Set<{ clear(): void }>();

/** Sign-out and server switch: drop every session's verified keys and caches. */
export function resetVaultKeySessions(): void {
  for (const s of sessions) s.clear();
}

export function createVaultKeySession(deps: VaultKeySessionDeps) {
  const { api, keys } = deps;
  /** vaultId → verified VK (+ generation). The only source for the header. */
  const verified = new Map<string, { vk: Uint8Array; b64: string; generation: number }>();

  /** Set when the server's account key is not ours: every key step refuses. */
  let accountMismatch = false;
  const enabled = async () => (await deps.features()).has(VAULT_KEYS);

  async function ensureAccountKeys(): Promise<AccountKeysState> {
    if (!(await enabled())) return { state: "disabled" };
    const local = await keys.getAccountPrivateKey();
    const remote = await api.getMyKeys();
    if (local && remote) {
      // Checked on every launch: a server that swaps our public key must not
      // get vault keys sealed to it, nor see us proceed as if nothing happened.
      accountMismatch = !sameKey(publicKeyFromPrivate(local), remote.publicKey);
      return accountMismatch ? { state: "security-warning" } : { state: "ready", isNew: false };
    }
    // No local key but the server has one: link this device. A session alone
    // never yields keys: another of OUR devices must approve the code.
    if (!local && remote) return linkThisDevice(remote.publicKey);
    // No server keys: publish (a fresh keypair, or the one this device holds).
    const privateKey = local ?? generateAccountKeypair().privateKey;
    // Keychain first: a failed PUT retries next run with the same key.
    if (!local) await keys.setAccountPrivateKey(privateKey);
    await api.putMyKeys({ publicKey: toBase64(publicKeyFromPrivate(privateKey)) });
    return { state: "ready", isNew: true };
  }

  async function linkThisDevice(accountPublicKey: string): Promise<AccountKeysState> {
    let linkKey = await keys.getDeviceLinkKey();
    if (!linkKey) {
      linkKey = generateAccountKeypair().privateKey;
      await keys.setDeviceLinkKey(linkKey);
    }
    const linkPub = publicKeyFromPrivate(linkKey);
    const wrapped = await api.getDeviceKey(deps.deviceId());
    if (wrapped) {
      let priv: Uint8Array | null = null;
      try {
        priv = openSealed(linkKey, fromBase64(wrapped));
      } catch {
        priv = null;
      }
      // Adopted only when it IS the account key the server names.
      if (priv && priv.length === 32 && sameKey(publicKeyFromPrivate(priv), accountPublicKey)) {
        if (!(await keys.getAccountPrivateKey())) await keys.setAccountPrivateKey(priv);
        await keys.deleteDeviceLinkKey();
        return { state: "ready", isNew: false };
      }
    }
    await api.registerPendingDevice(deps.deviceId(), toBase64(linkPub)); // idempotent
    return { state: "awaiting-device-approval", code: deviceCode(linkPub) };
  }

  /** Existing device: devices waiting for approval, each with its code. */
  async function pendingDevices(): Promise<PendingDeviceView[]> {
    if (!(await enabled()) || accountMismatch) return [];
    if (!(await keys.getAccountPrivateKey())) return [];
    const out: PendingDeviceView[] = [];
    for (const d of await api.listPendingDevices()) {
      if (d.deviceId === deps.deviceId()) continue;
      try {
        const pub = fromBase64(d.publicKey);
        if (pub.length === 32) out.push({ ...d, code: deviceCode(pub) });
      } catch {
        /* malformed: never offered */
      }
    }
    return out;
  }

  /** The person approved `device` (codes matched): seal our account key to it. */
  async function approveDevice(device: PendingDeviceView): Promise<boolean> {
    if (!(await enabled()) || accountMismatch) return false;
    const priv = await keys.getAccountPrivateKey();
    const remote = await api.getMyKeys();
    if (!priv || !remote || !sameKey(publicKeyFromPrivate(priv), remote.publicKey)) return false;
    const pub = fromBase64(device.publicKey);
    if (pub.length !== 32 || deviceCode(pub) !== device.code) return false;
    await api.putDeviceKey(device.deviceId, toBase64(sealTo(pub, priv)));
    return true;
  }

  async function denyDevice(deviceId: string): Promise<void> {
    await api.denyDevice(deviceId);
  }

  /**
   * Lost every device: a NEW account keypair, explicitly chosen by the person.
   * Only when this device holds no account key (never replaces one). Old seals
   * to the previous key stop opening; owners restore with the vault key,
   * members are re-approved by teammates who confirm the new code.
   */
  async function startFreshAccountKey(): Promise<boolean> {
    if (!(await enabled()) || accountMismatch) return false;
    if (await keys.getAccountPrivateKey()) return false;
    const { privateKey, publicKey } = generateAccountKeypair();
    await keys.setAccountPrivateKey(privateKey);
    await api.putMyKeys({ publicKey: toBase64(publicKey) });
    await keys.deleteDeviceLinkKey();
    return true;
  }

  /**
   * "<name>'s security key changed": the ONE human override of a pin, after
   * the person confirmed the code with them. Updates the pin, then seals.
   */
  async function approveChangedKey(vaultId: string, change: SealedFor & { publicKey: string }): Promise<boolean> {
    const held = verified.get(vaultId);
    if (!held || accountMismatch) return false;
    const pub = fromBase64(change.publicKey);
    if (pub.length !== 32 || shortFingerprint(pub) !== change.fingerprint) return false;
    if (!(await deps.isMember(vaultId, change.userId))) return false;
    await deps.pins.set(change.userId, keyFingerprint(pub));
    await api.postVaultKeyWrap(
      vaultId,
      { userId: change.userId, generation: held.generation, sealedVk: toBase64(sealVkTo(pub, held.vk)) },
      held.b64,
    );
    return true;
  }

  /**
   * "Restore with vault key": the owner's 24 words, checked against the
   * server's `vk_check` before anything is stored. A wrong key is refused and
   * never stored; a stored key that still verifies is never replaced. With a
   * ready account key the VK is also sealed to ourselves for other devices.
   */
  async function restoreWithVaultKey(vaultId: string, words: string): Promise<RestoreResult> {
    if (!(await enabled())) return "disabled";
    if (accountMismatch) return "security-warning";
    const vk = wordsToVaultKey(words);
    if (!vk) return "invalid-words";
    const mine = await api.getMyVaultKeys(vaultId);
    if (!mine.vkCheck || mine.generation === undefined) return "cannot-verify";
    const vkCheck = fromBase64(mine.vkCheck);
    if (!(await verifyVk(vk, vaultId, vkCheck))) return "wrong-key";
    const held = await keys.getVaultKey(vaultId);
    if (!held || !(await verifyVk(held, vaultId, vkCheck))) await keys.setVaultKey(vaultId, vk);
    accept(vaultId, vk, mine.generation);
    const self = deps.selfUserId();
    const priv = await keys.getAccountPrivateKey();
    const remote = priv ? await api.getMyKeys() : null;
    if (self && priv && remote && sameKey(publicKeyFromPrivate(priv), remote.publicKey)) {
      await api.postVaultKeyWrap(
        vaultId,
        { userId: self, generation: mine.generation, sealedVk: toBase64(sealVkTo(publicKeyFromPrivate(priv), vk)) },
        toBase64(vk),
      );
    }
    return "restored";
  }

  /** Owner's Settings → Security: the verified key as 24 words, else null. */
  function revealVaultKey(vaultId: string): string | null {
    const held = verified.get(vaultId);
    return held ? vaultKeyToWords(held.vk) : null;
  }

  async function ensureVaultKey(vaultId: string): Promise<VaultKeyState> {
    if (!(await enabled())) return { state: "disabled" };
    if (accountMismatch) return { state: "security-warning" };
    let mine: MyVaultKeys | null;
    try {
      mine = await api.getMyVaultKeys(vaultId);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      mine = null;
    }
    if (mine === null) return keyUnkeyedVault(vaultId);
    if (mine.pending) {
      // A key restored on this device earlier still counts when it verifies.
      const held = mine.vkCheck ? await keys.getVaultKey(vaultId) : null;
      if (held && mine.vkCheck && mine.generation !== undefined && (await verifyVk(held, vaultId, fromBase64(mine.vkCheck)))) {
        return accept(vaultId, held, mine.generation);
      }
      return { state: "waiting-for-teammate" };
    }
    const vkCheck = fromBase64(mine.vkCheck);

    const local = await keys.getVaultKey(vaultId);
    if (local && (await verifyVk(local, vaultId, vkCheck))) {
      return accept(vaultId, local, mine.generation);
    }
    verified.delete(vaultId);
    const wrap = mine.wraps.find((w) => w.generation === mine.generation);
    if (!wrap) return { state: "waiting-for-teammate" };
    const priv = await keys.getAccountPrivateKey();
    if (!priv) return { state: "needs-account-key" };
    let vk: Uint8Array;
    try {
      vk = openSealedVk(priv, fromBase64(wrap.sealedVk));
    } catch {
      return { state: "key-mismatch" };
    }
    if (!(await verifyVk(vk, vaultId, vkCheck))) return { state: "key-mismatch" };
    await keys.setVaultKey(vaultId, vk);
    return accept(vaultId, vk, mine.generation);
  }

  async function keyUnkeyedVault(vaultId: string): Promise<VaultKeyState> {
    if (!deps.keysAllowed(vaultId)) return { state: "unkeyed" };
    // A key this device already holds for the vault is never replaced by a
    // fresh one: the server's "unkeyed" may be wrong, the local key is not lost.
    if (await keys.getVaultKey(vaultId)) return { state: "unkeyed" };
    const priv = await keys.getAccountPrivateKey();
    if (!priv) return { state: "needs-account-key" };
    const generation = 1;
    const vk = generateVaultKey();
    const body: VaultKeyInit = {
      vkCheck: toBase64(await makeVkCheck(vk, vaultId, generation)),
      generation,
      sealedVkForSelf: toBase64(sealVkTo(publicKeyFromPrivate(priv), vk)),
    };
    // Server first (atomic: 409 `already_keyed` if anyone keyed it), keychain
    // after. A failed keychain write loses nothing: `sealedVkForSelf` is opened
    // from the server on the next run. Nothing is stored for a refused init.
    const result = await api.initVaultKeys(vaultId, body);
    if (result === "already-keyed") return ensureVaultKey(vaultId);
    await keys.setVaultKey(vaultId, vk);
    accept(vaultId, vk, generation);
    return { state: "ready", generation, created: true };
  }

  function accept(vaultId: string, vk: Uint8Array, generation: number): VaultKeyState {
    verified.set(vaultId, { vk, b64: toBase64(vk), generation });
    return { state: "ready", generation };
  }

  /** Key holder: seal the VK for each requester who is a current member. */
  async function serviceKeyRequests(vaultId: string): Promise<ServiceResult> {
    const out: ServiceResult = { sealed: [], refused: [], keyChanged: [] };
    if (!(await enabled()) || accountMismatch) return out;
    const held = verified.get(vaultId);
    if (!held) return out;
    for (const r of await api.listVaultKeyRequests(vaultId)) {
      let pub: Uint8Array;
      try {
        pub = fromBase64(r.publicKey);
      } catch {
        out.refused.push(r.userId);
        continue;
      }
      if (pub.length !== 32 || !(await deps.isMember(vaultId, r.userId))) {
        out.refused.push(r.userId);
        continue;
      }
      const fp = keyFingerprint(pub);
      const pinned = await deps.pins.get(r.userId);
      if (pinned && pinned !== fp) {
        out.keyChanged.push({ userId: r.userId, fingerprint: shortFingerprint(pub), publicKey: r.publicKey });
        continue;
      }
      await api.postVaultKeyWrap(
        vaultId,
        { userId: r.userId, generation: held.generation, sealedVk: toBase64(sealVkTo(pub, held.vk)) },
        held.b64,
      );
      if (!pinned) await deps.pins.set(r.userId, fp);
      out.sealed.push({ userId: r.userId, fingerprint: shortFingerprint(pub) });
    }
    return out;
  }

  /** `X-Baalda-VK` value for a vault: verified keys only. Synchronous. */
  function headerFor(vaultId: string): string | null {
    return verified.get(vaultId)?.b64 ?? null;
  }

  const session = {
    ensureAccountKeys,
    restoreWithVaultKey,
    revealVaultKey,
    pendingDevices,
    approveDevice,
    denyDevice,
    startFreshAccountKey,
    approveChangedKey,
    ensureVaultKey,
    serviceKeyRequests,
    headerFor,
    clear() {
      verified.clear();
      accountMismatch = false;
      keys.clearCache();
    },
    dispose() {
      sessions.delete(session);
    },
  };
  sessions.add(session);
  return session;
}

export type VaultKeySession = ReturnType<typeof createVaultKeySession>;

function sameKey(a: Uint8Array, b64: string): boolean {
  try {
    return toBase64(a) === toBase64(fromBase64(b64));
  } catch {
    return false;
  }
}
