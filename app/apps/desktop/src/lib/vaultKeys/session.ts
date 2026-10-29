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
  VaultKeyInit,
  VaultKeyRequest,
  VaultKeyWrapPost,
} from "../api";
import { ApiError } from "../api";
import { VAULT_KEYS } from "../serverFeatures";
import {
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  keyFingerprint,
  makeVkCheck,
  newRecoveryPhrase,
  openSealedVk,
  publicKeyFromPrivate,
  sealVkTo,
  shortFingerprint,
  toBase64,
  unwrapPrivateKeyWithPhrase,
  verifyVk,
  wrapPrivateKeyWithPhrase,
  type Argon2Params,
} from "./crypto";

export interface VaultKeysApi {
  initVaultKeys(vaultId: string, body: VaultKeyInit): Promise<"created" | "already-keyed">;
  getMyVaultKeys(vaultId: string): Promise<MyVaultKeys>;
  listVaultKeyRequests(vaultId: string): Promise<VaultKeyRequest[]>;
  postVaultKeyWrap(vaultId: string, wrap: VaultKeyWrapPost, vkBase64: string): Promise<void>;
  putMyKeys(body: AccountKeysBody): Promise<void>;
  getMyKeys(): Promise<AccountKeysBody | null>;
}

/** The keychain store, scoped to the current server + user by the caller. */
export interface VaultKeyStore {
  getAccountPrivateKey(): Promise<Uint8Array | null>;
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
  /** Tests pass cheap Argon2 parameters. */
  argon2?: Argon2Params;
}

export type AccountKeysState =
  | { state: "disabled" }
  | { state: "ready"; isNew: false }
  /** First run: show the recovery kit ONCE, then drop the phrase. */
  | { state: "ready"; isNew: true; phrase: string }
  | { state: "needs-recovery-or-approval" }
  /** The server's public key for this account is not this device's: refuse keys. */
  | { state: "security-warning" };

export type VaultKeyState =
  | { state: "disabled" }
  | { state: "security-warning" }
  | { state: "ready"; generation: number }
  | { state: "waiting-for-teammate" }
  | { state: "unkeyed" }
  | { state: "needs-account-key" }
  /** The only key on offer does not open `vk_check`: never used. */
  | { state: "key-mismatch" };

export type SealedFor = { userId: string; fingerprint: string };
export type ServiceResult = {
  /** Sealed: the toast shows `fingerprint` (short form). */
  sealed: SealedFor[];
  /** Not a current member, or a malformed key. */
  refused: string[];
  /** Pinned key differs: "<name>'s security key changed". Never auto-sealed. */
  keyChanged: SealedFor[];
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
    if (!local && remote) return { state: "needs-recovery-or-approval" };
    // No server keys: publish (a fresh keypair, or the one this device holds).
    const privateKey = local ?? generateAccountKeypair().privateKey;
    const phrase = newRecoveryPhrase();
    const privWrappedRecovery = await wrapPrivateKeyWithPhrase(phrase, privateKey, deps.argon2);
    // Keychain first: a failed PUT retries next run with the same key.
    if (!local) await keys.setAccountPrivateKey(privateKey);
    await api.putMyKeys({
      publicKey: toBase64(publicKeyFromPrivate(privateKey)),
      privWrappedRecovery: toBase64(privWrappedRecovery),
    });
    return { state: "ready", isNew: true, phrase };
  }

  /** New device: restore the account private key from the recovery phrase. */
  async function recoverWithPhrase(phrase: string): Promise<boolean> {
    // Never replace a private key this device already holds.
    if (await keys.getAccountPrivateKey()) return false;
    const remote = await api.getMyKeys();
    if (!remote) return false;
    let priv: Uint8Array;
    try {
      priv = await unwrapPrivateKeyWithPhrase(phrase, fromBase64(remote.privWrappedRecovery));
    } catch {
      return false;
    }
    if (!sameKey(publicKeyFromPrivate(priv), remote.publicKey)) return false;
    await keys.setAccountPrivateKey(priv);
    return true;
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
    if (mine.pending) return { state: "waiting-for-teammate" };
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
    return accept(vaultId, vk, generation);
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
        out.keyChanged.push({ userId: r.userId, fingerprint: shortFingerprint(pub) });
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
    recoverWithPhrase,
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
