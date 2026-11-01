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
  AllowlistCandidate,
  InviteManyInput,
  InviteManyResult,
  AllowlistEntry,
  MyVaultKeys,
  PendingDevice,
  VaultKeyInit,
  VaultKeyRequest,
  VaultKeyWrapPost,
} from "../api";
import { VAULT_KEYS } from "../serverFeatures";
import { conversionSafe } from "./conversionSafety";
import {
  fromBase64,
  deviceCode,
  generateAccountKeypair,
  generateVaultKey,
  keyFingerprint,
  allowlistMac,
  makeStableVkCheck,
  makeVkCheck,
  openSealed,
  openSealedVk,
  publicKeyFromPrivate,
  sealTo,
  sealVkTo,
  shortFingerprint,
  unwrapAccountKeyWithUnlock,
  wrapAccountKeyWithUnlock,
  newSecret,
  secretHash,
  unwrapVkWithSecret,
  wrapVkWithSecret,
  type SecretPurpose,
  toBase64,
  verifyVk,
  vaultKeyToWords,
  wordsToVaultKey,
} from "./crypto";

export interface VaultKeysApi {
  initVaultKeys(
    vaultId: string,
    body: VaultKeyInit,
  ): Promise<"created" | "already-keyed" | "not-ready" | "pending-mismatch">;
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
  registerPendingVaultKey(
    vaultId: string,
    body: { vkCheck: string; generation: number; deviceId: string },
    vkBase64: string,
  ): Promise<"registered" | "claimed">;
  getAllowlistCandidates(vaultId: string, vkBase64: string): Promise<AllowlistCandidate[]>;
  postAllowlist(
    vaultId: string,
    entries: AllowlistEntry[],
    vkBase64: string,
    excluded?: Array<{ kind: string; id: string }>,
  ): Promise<{ rejected: string[] }>;
  getConversionReady(vaultId: string, vkBase64: string): Promise<boolean>;
  /** Seamless keys F (optional: older test fakes omit them ⇒ always E). */
  unlockAccountKey?(password: string): Promise<{ unlockKey: string } | "wrong-password" | "unavailable">;
  putPasswordWrap?(privWrapped: string): Promise<void>;
  /** Seamless keys B/C (optional: older fakes omit them ⇒ today's behaviour). */
  putInviteWrap?(
    vaultId: string,
    invitationId: string,
    body: { sealedVk: string; publicKey: string; generation: number },
    vkBase64: string,
  ): Promise<void>;
  putJoinWrap?(
    vaultId: string,
    body: { secretHash: string; wrappedVk: string; generation: number; code: string },
    vkBase64: string,
  ): Promise<"stored" | "stale-code">;
}

/** What adopting a secret-wrapped key did (B4 / C). */
export type SecretAdoptResult = "adopted" | "already" | "no-match" | "refused";

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
  /** True only for a key this device generated for a conversion the server
   *  has not confirmed: the one held key a teammate's wrap may replace. */
  isVaultKeyProvisional(vaultId: string): Promise<boolean>;
  setVaultKeyProvisional(vaultId: string, on: boolean): Promise<void>;
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
  /** May this user convert the vault (owner/admin)? Default: no. */
  canConvert?(vaultId: string): Promise<boolean>;
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
  /** `created`: this device just keyed the vault. */
  | { state: "ready"; generation: number; created?: true }
  | { state: "waiting-for-teammate" }
  /** `conversionAllowed`: the server's rollout gate for converting this vault.
   * `encryptionRequested`: an owner/admin opted it in (absent = unknown/no). */
  | { state: "unkeyed"; conversionAllowed?: boolean; encryptionRequested?: boolean }
  | { state: "needs-account-key" }
  /** The only key on offer does not open `vk_check`: never used. */
  | { state: "key-mismatch" };

export type ConvertResult =
  | "converted"
  | "waiting-ready"
  /** `conversionSafe` is not met yet (no other keyed member, no password
   *  wrap, a single device): nothing was generated or sent; ask again later. */
  | "not-safe-yet"
  | "claimed-elsewhere"
  | "already-keyed"
  | "needs-account-key"
  | "not-allowed";

export type RestoreResult =
  | "restored"
  | "invalid-words"
  | "wrong-key"
  | "cannot-verify"
  | "disabled"
  | "security-warning";

export type PendingDeviceView = PendingDevice & { code: string };

/** What a password unlock did (seamless keys F). Every non-`unlocked` answer
 *  leaves today's path (one-click approval) in charge. */
export type PasswordUnlockResult =
  | "unlocked"
  | "wrap-written"
  | "wrap-current"
  | "fallback"
  | "unavailable"
  | "wrong-password"
  | "disabled";

/** A key that arrives this long after a password sign-in still gets a wrap. */
export const PASSWORD_WRAP_WINDOW_MS = 15 * 60 * 1000;

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

  /** Ids already offered / handled this session: listed after new ones. */
  const offeredDevices = new Set<string>();
  const handledRequests = new Set<string>();

  /** Set when the server's account key is not ours: every key step refuses. */
  let accountMismatch = false;
  /** The derived unlock key (never the password) while a key may still arrive
   *  after a password sign-in (`PASSWORD_WRAP_WINDOW_MS`). Memory only. */
  let pendingUnlock: { key: Uint8Array; until: number } | null = null;
  const now = () => Date.now();
  const enabled = async () => (await deps.features()).has(VAULT_KEYS);

  async function ensureAccountKeys(): Promise<AccountKeysState> {
    const state = await ensureAccountKeysInner();
    if (state.state === "ready" && pendingUnlock) await writeLateWrap().catch(() => {});
    return state;
  }

  /** The key arrived within the window after a password sign-in: wrap it now. */
  async function writeLateWrap(): Promise<void> {
    const pending = pendingUnlock;
    if (!pending || now() > pending.until) {
      pendingUnlock = null;
      return;
    }
    const self = deps.selfUserId();
    const priv = await keys.getAccountPrivateKey();
    const remote = await api.getMyKeys();
    if (!self || !priv || !remote || !sameKey(publicKeyFromPrivate(priv), remote.publicKey) || !api.putPasswordWrap) return;
    if (!wrapOpens(pending.key, self, remote)) {
      await api.putPasswordWrap(toBase64(wrapAccountKeyWithUnlock(pending.key, self, remote.publicKey, priv)));
    }
    pendingUnlock = null;
  }

  function wrapOpens(unlockKey: Uint8Array, self: string, remote: AccountKeysBody): Uint8Array | null {
    if (!remote.privWrappedPassword) return null;
    try {
      const priv = unwrapAccountKeyWithUnlock(unlockKey, self, remote.publicKey, fromBase64(remote.privWrappedPassword));
      return priv.length === 32 && sameKey(publicKeyFromPrivate(priv), remote.publicKey) ? priv : null;
    } catch {
      return null;
    }
  }

  /**
   * Seamless keys F: the password (memory only, never stored or logged here)
   * unlocks the account key. Holding the key: (re)write the password wrap when
   * missing or stale. Not holding it: adopt the wrap only when it opens AND
   * its public key is the one `/me/keys` names, then the device is ready with
   * no approval. Anything else falls back to one-click approval (E).
   */
  async function unlockWithPassword(password: string): Promise<PasswordUnlockResult> {
    if (!(await enabled()) || accountMismatch) return "disabled";
    if (!api.unlockAccountKey || !api.putPasswordWrap) return "unavailable";
    const self = deps.selfUserId();
    if (!self) return "fallback";
    const answer = await api.unlockAccountKey(password);
    if (answer === "wrong-password" || answer === "unavailable") return answer;
    let unlockKey: Uint8Array;
    try {
      unlockKey = fromBase64(answer.unlockKey);
    } catch {
      return "fallback";
    }
    if (unlockKey.length !== 32) return "fallback";
    const remote = await api.getMyKeys();
    const local = await keys.getAccountPrivateKey();
    if (!remote) {
      // No account key yet: the first run publishes one; wrap it then.
      pendingUnlock = { key: unlockKey, until: now() + PASSWORD_WRAP_WINDOW_MS };
      return "fallback";
    }
    if (local) {
      if (!sameKey(publicKeyFromPrivate(local), remote.publicKey)) {
        accountMismatch = true;
        return "disabled";
      }
      if (wrapOpens(unlockKey, self, remote)) return "wrap-current";
      await api.putPasswordWrap(toBase64(wrapAccountKeyWithUnlock(unlockKey, self, remote.publicKey, local)));
      return "wrap-written";
    }
    const priv = wrapOpens(unlockKey, self, remote);
    if (!priv) {
      pendingUnlock = { key: unlockKey, until: now() + PASSWORD_WRAP_WINDOW_MS };
      return "fallback";
    }
    await keys.setAccountPrivateKey(priv);
    await keys.deleteDeviceLinkKey().catch(() => {});
    return "unlocked";
  }

  async function ensureAccountKeysInner(): Promise<AccountKeysState> {
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
    const listed = await api.listPendingDevices();
    if (!Array.isArray(listed)) return [];
    const seen = new Set<string>();
    // Never-offered devices first, so junk rows listed ahead of the person's
    // real new computer cannot hold the bounded window forever.
    for (const d of byNovelty(listed, (x) => (x as PendingDevice | null)?.deviceId, offeredDevices)) {
      // The server's list is untrusted: bounded, one prompt per device.
      if (out.length >= MAX_PENDING_DEVICES) break;
      if (!d || typeof d.deviceId !== "string" || typeof d.publicKey !== "string") continue;
      if (d.deviceId === deps.deviceId() || seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      offeredDevices.add(d.deviceId);
      try {
        const pub = fromBase64(d.publicKey);
        if (pub.length === 32) out.push({ ...d, code: deviceCode(pub) });
      } catch {
        /* malformed: never offered */
      }
    }
    return out;
  }

  /**
   * The person approved `device` (one click; the prompt shows the code
   * read-only and passes it back): seal our account key to it. The code must
   * still match the listed public key, so a row whose key and code disagree is
   * never approved.
   */
  async function approveDevice(device: PendingDevice, typedCode: string): Promise<boolean> {
    if (!(await enabled()) || accountMismatch) return false;
    let pub: Uint8Array;
    try {
      pub = fromBase64(device.publicKey);
    } catch {
      return false;
    }
    if (pub.length !== 32 || !sameDeviceCode(typedCode, deviceCode(pub))) return false;
    const priv = await keys.getAccountPrivateKey();
    const remote = await api.getMyKeys();
    if (!priv || !remote || !sameKey(publicKeyFromPrivate(priv), remote.publicKey)) return false;
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
    // Server first: if it refuses (today's server keeps the old key, 409
    // `keys_exist`) nothing local changes, so the device never ends up holding
    // a key the server does not name.
    await api.putMyKeys({ publicKey: toBase64(publicKey) });
    await keys.setAccountPrivateKey(privateKey);
    await keys.deleteDeviceLinkKey();
    return true;
  }

  /**
   * The code teammates see in "<name>'s security key changed" for OUR account
   * key (`shortFingerprint`), or null when this device holds none. Read-only.
   */
  async function accountKeyCode(): Promise<string | null> {
    const priv = await keys.getAccountPrivateKey();
    return priv ? shortFingerprint(publicKeyFromPrivate(priv)) : null;
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
    if (!mine.keyed || !mine.vkCheck || mine.generation === undefined) return "cannot-verify";
    const vkCheck = fromBase64(mine.vkCheck);
    if (!(await verifyVk(vk, vaultId, vkCheck))) return "wrong-key";
    const held = await keys.getVaultKey(vaultId);
    if (!held || !(await verifyVk(held, vaultId, vkCheck))) await keys.setVaultKey(vaultId, vk);
    await confirmed(vaultId);
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

  /**
   * Convert an existing (unkeyed) vault, once, from an owner/admin device.
   * Order is load-bearing for "never lose the key": the VK is in the keychain
   * BEFORE any server call, and every step is resumable with that same key
   * (the check is deterministic, the allowlist idempotent). Another device
   * holding the claim (409) means we adopt nothing and wait for `keys/mine`.
   */
  async function convertVault(vaultId: string): Promise<ConvertResult> {
    if (!(await enabled()) || accountMismatch) return "not-allowed";
    const mine = await api.getMyVaultKeys(vaultId);
    if (mine.keyed) return "already-keyed";
    if (!mine.conversionAllowed) return "not-allowed";
    const priv = await keys.getAccountPrivateKey();
    if (!priv) return "needs-account-key";
    const remote = await api.getMyKeys();
    if (!remote || !sameKey(publicKeyFromPrivate(priv), remote.publicKey)) return "needs-account-key";
    // Zero data loss: never key a vault whose key could die with this computer.
    const safe = conversionSafe({
      otherMembersWithKeys: mine.otherMembersWithKeys,
      hasPasswordWrap: typeof remote.privWrappedPassword === "string" && remote.privWrappedPassword.length > 0,
      // The first computer has no device row; every approved one adds one.
      approvedDevices: Array.isArray(remote.devices) ? remote.devices.length + 1 : undefined,
    });
    if (!safe) return "not-safe-yet";
    // The role check reads the member list (heavy on a big vault): asked only
    // once everything else says go, so a vault that is not safe yet does not
    // fetch it on every run.
    if (!(deps.canConvert && (await deps.canConvert(vaultId)))) return "not-allowed";

    let vk = await keys.getVaultKey(vaultId); // a crashed earlier run: same key
    if (!vk) {
      vk = generateVaultKey();
      // Provisional until the server confirms it (another claim may win). The
      // marker goes FIRST: a crash between the two writes must never leave a
      // fresh key that looks confirmed (that one would be refused forever).
      await keys.setVaultKeyProvisional(vaultId, true);
      await keys.setVaultKey(vaultId, vk); // BEFORE any server call
    }
    const generation = 1;
    const vkCheck = toBase64(await makeStableVkCheck(vk, vaultId, generation));
    const vkB64 = toBase64(vk);
    const claim = await api.registerPendingVaultKey(vaultId, { vkCheck, generation, deviceId: deps.deviceId() }, vkB64);
    if (claim === "claimed") return "claimed-elsewhere";

    // Re-run on every poll: credentials minted while pending must be listed
    // too. Every connection is kept (no owner review): MCP tokens, AI
    // connections and public links keep working. One excluded by an earlier
    // review stays excluded (the server's record).
    const candidates = await api.getAllowlistCandidates(vaultId, vkB64);
    const entries: AllowlistEntry[] = candidates
      .filter((c) => !c.excluded)
      .map((c) => ({ kind: c.kind, id: c.id, mac: toBase64(allowlistMac(vk!, c.id, c.hash)) }));
    if (entries.length) {
      const { rejected } = await api.postAllowlist(vaultId, entries, vkB64);
      if (rejected.length) console.warn(`[vault-keys] ${rejected.length} allowlist entr(y/ies) rejected; retrying next poll`);
    }
    if (!(await api.getConversionReady(vaultId, vkB64))) return "waiting-ready";

    const result = await api.initVaultKeys(vaultId, {
      vkCheck,
      generation,
      sealedVkForSelf: toBase64(sealVkTo(publicKeyFromPrivate(priv), vk)),
    });
    if (result === "not-ready") return "waiting-ready";
    // Our check is not the pending one: another device's claim stands.
    if (result === "pending-mismatch") return "claimed-elsewhere";
    if (result === "already-keyed") {
      // Our own earlier init (lost answer) verifies with our key; anyone
      // else's does not, and then their wrap arrives through `keys/mine`.
      const state = await ensureVaultKey(vaultId);
      return state.state === "ready" ? "converted" : "claimed-elsewhere";
    }
    await confirmed(vaultId);
    accept(vaultId, vk, generation);
    return "converted";
  }

  /**
   * Gate for the first sync pass on vault open: proceed only on a KNOWN state
   * that cannot hurt local files (key held and verified, vault not keyed, or
   * the server without vault keys). Anything else, including an error, pauses.
   */
  async function gateVaultOpen(vaultId: string): Promise<"proceed" | "paused"> {
    try {
      if (!(await enabled())) return "proceed";
      try {
        await ensureAccountKeys();
      } catch {
        /* the account check never decides the gate on its own */
      }
      const state = await ensureVaultKey(vaultId);
      return state.state === "ready" || state.state === "unkeyed" || state.state === "disabled"
        ? "proceed"
        : "paused";
    } catch {
      return "paused";
    }
  }

  /** Owner's Settings → Security: the verified key as 24 words, else null. */
  function revealVaultKey(vaultId: string): string | null {
    const held = verified.get(vaultId);
    return held ? vaultKeyToWords(held.vk) : null;
  }

  async function ensureVaultKey(vaultId: string): Promise<VaultKeyState> {
    if (!(await enabled())) return { state: "disabled" };
    if (accountMismatch) return { state: "security-warning" };
    // Any error (404 not a member, 5xx, timeout) propagates: never keyed on doubt.
    const mine: MyVaultKeys = await api.getMyVaultKeys(vaultId);
    // A confirmed key this device holds is the ground truth: the server's
    // answer comes from a database anyone with DB access can rewrite. When it
    // stops matching (vk_check wiped → "unkeyed", or swapped for a check the
    // writer made with their own key), refuse: never sync this vault as
    // plaintext, never adopt a key from a wrap, never replace the held key.
    const held = await keys.getVaultKey(vaultId);
    const heldConfirmed = held !== null && !(await keys.isVaultKeyProvisional(vaultId));
    if (!mine.keyed) {
      if (heldConfirmed) {
        verified.delete(vaultId);
        return { state: "key-mismatch" };
      }
      const r = await keyUnkeyedVault(vaultId);
      return r.state === "unkeyed"
        ? { state: "unkeyed", conversionAllowed: mine.conversionAllowed, encryptionRequested: mine.encryptionRequested }
        : r;
    }
    if (mine.pending) {
      // A key restored on this device earlier still counts when it verifies.
      if (held && mine.vkCheck && mine.generation !== undefined && (await verifyVk(held, vaultId, fromBase64(mine.vkCheck)))) {
        await confirmed(vaultId);
        return accept(vaultId, held, mine.generation);
      }
      if (heldConfirmed) {
        verified.delete(vaultId);
        return { state: "key-mismatch" };
      }
      return { state: "waiting-for-teammate" };
    }
    const vkCheck = fromBase64(mine.vkCheck);

    const local = held;
    if (local && (await verifyVk(local, vaultId, vkCheck))) {
      await confirmed(vaultId);
      return accept(vaultId, local, mine.generation);
    }
    verified.delete(vaultId);
    if (heldConfirmed) return { state: "key-mismatch" };
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
    await confirmed(vaultId);
    return accept(vaultId, vk, mine.generation);
  }

  /** The held key opened the server's check: no longer provisional. */
  async function confirmed(vaultId: string): Promise<void> {
    if (await keys.isVaultKeyProvisional(vaultId)) await keys.setVaultKeyProvisional(vaultId, false);
  }

  async function keyUnkeyedVault(vaultId: string): Promise<VaultKeyState> {
    // NOTE: does not check the owner/admin opt-in (`encryptionRequested`);
    // `keysAllowed` is off in production and all keying goes through
    // `convertVault`, which honours `conversionAllowed`. Check it here before
    // ever turning that switch on.
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

  /** Seal the verified VK to this account's own key (other devices read it). */
  async function sealToSelf(vaultId: string, vk: Uint8Array, generation: number): Promise<void> {
    const self = deps.selfUserId();
    const priv = await keys.getAccountPrivateKey();
    const remote = priv ? await api.getMyKeys() : null;
    if (!self || !priv || !remote || !sameKey(publicKeyFromPrivate(priv), remote.publicKey)) return;
    await api.postVaultKeyWrap(
      vaultId,
      { userId: self, generation, sealedVk: toBase64(sealVkTo(publicKeyFromPrivate(priv), vk)) },
      toBase64(vk),
    );
  }

  /**
   * B1: per-invitee secret wraps of the verified VK, or null when this device
   * holds no verified key (then it invites exactly as before). The secrets go
   * only into the request body; nothing here keeps them.
   */
  function inviteKeyMaterial(
    vaultId: string,
    emails: string[],
  ): { vaultKeys: NonNullable<InviteManyInput["vaultKeys"]>; vkBase64: string } | null {
    const held = verified.get(vaultId);
    if (!held || accountMismatch) return null;
    const items = emails.map((email) => {
      const secret = newSecret();
      return {
        email,
        secret,
        wrappedVk: toBase64(wrapVkWithSecret(secret, "invite", vaultId, held.generation, held.vk)),
      };
    });
    return { vaultKeys: { vaultId, generation: held.generation, items }, vkBase64: held.b64 };
  }

  /**
   * B2: invitees who already have an account key get the VK sealed to it now
   * (the server installs it on acceptance when the key still matches). TOFU:
   * a pinned, different key is never sealed to. Best-effort per invitee.
   */
  async function sealInviteResults(vaultId: string, results: InviteManyResult[]): Promise<string[]> {
    const held = verified.get(vaultId);
    const sealed: string[] = [];
    if (!held || accountMismatch || !api.putInviteWrap) return sealed;
    for (const r of results) {
      if (!r?.invitationId || r.error || typeof r.publicKey !== "string" || typeof r.inviteeUserId !== "string") continue;
      try {
        const pub = fromBase64(r.publicKey);
        if (pub.length !== 32) continue;
        const fp = keyFingerprint(pub);
        const pinned = await deps.pins.get(r.inviteeUserId);
        if (pinned && pinned !== fp) continue;
        await api.putInviteWrap(
          vaultId,
          r.invitationId,
          { sealedVk: toBase64(sealVkTo(pub, held.vk)), publicKey: r.publicKey, generation: held.generation },
          held.b64,
        );
        if (!pinned) await deps.pins.set(r.inviteeUserId, fp);
        sealed.push(r.inviteeUserId);
      } catch (e) {
        console.warn("[vault-keys] invite seal skipped", e instanceof Error ? e.name : "error");
      }
    }
    return sealed;
  }

  /**
   * B4 / C: open a secret-wrapped VK, verify it against the vault's check,
   * store it, then self-seal. A held confirmed key that verifies is kept; one
   * that does NOT verify is never replaced (same rule as `ensureVaultKey`).
   */
  async function adoptFromSecret(
    vaultId: string,
    purpose: SecretPurpose,
    secret: string,
    wraps: Array<{ generation: number; wrappedVk: string }>,
  ): Promise<SecretAdoptResult> {
    if (!(await enabled()) || accountMismatch) return "refused";
    const mine = await api.getMyVaultKeys(vaultId);
    // A member with no wrap of their own yet gets 202 pending, which still
    // carries the check: that is exactly who a secret wrap is for.
    if (!mine.keyed || !mine.vkCheck || mine.generation === undefined) return "no-match";
    const check = fromBase64(mine.vkCheck);
    const held = await keys.getVaultKey(vaultId);
    if (held && (await verifyVk(held, vaultId, check))) {
      await confirmed(vaultId);
      accept(vaultId, held, mine.generation);
      return "already";
    }
    if (held && !(await keys.isVaultKeyProvisional(vaultId))) return "refused";
    for (const w of wraps) {
      if (!w || w.generation !== mine.generation || typeof w.wrappedVk !== "string") continue;
      let vk: Uint8Array;
      try {
        vk = unwrapVkWithSecret(secret, purpose, vaultId, w.generation, fromBase64(w.wrappedVk));
      } catch {
        continue;
      }
      if (vk.length !== 32 || !(await verifyVk(vk, vaultId, check))) continue;
      await keys.setVaultKey(vaultId, vk);
      await confirmed(vaultId);
      accept(vaultId, vk, mine.generation);
      await sealToSelf(vaultId, vk, mine.generation).catch(() => {});
      return "adopted";
    }
    return "no-match";
  }

  /** C: upload the join wrap for `<code>-<secret>` (admin device with the key). */
  async function uploadJoinWrap(vaultId: string, secret: string, code: string): Promise<"stored" | "stale-code" | "no-key"> {
    const held = verified.get(vaultId);
    if (!held || accountMismatch || !api.putJoinWrap) return "no-key";
    return api.putJoinWrap(
      vaultId,
      {
        secretHash: secretHash(secret),
        wrappedVk: toBase64(wrapVkWithSecret(secret, "join", vaultId, held.generation, held.vk)),
        generation: held.generation,
        code,
      },
      held.b64,
    );
  }

  /** Key holder: seal the VK for each requester who is a current member. */
  async function serviceKeyRequests(vaultId: string): Promise<ServiceResult> {
    const out: ServiceResult = { sealed: [], refused: [], keyChanged: [] };
    if (!(await enabled()) || accountMismatch) return out;
    const held = verified.get(vaultId);
    if (!held) return out;
    const listed = await api.listVaultKeyRequests(vaultId);
    if (!Array.isArray(listed)) return out;
    // The list is the server's word: bounded per run, one key per person. A
    // person listed with two different keys at once is refused outright.
    const byUser = new Map<string, Set<string>>();
    for (const r of listed) {
      if (!r || typeof r.userId !== "string" || typeof r.publicKey !== "string") continue;
      const keysOf = byUser.get(r.userId) ?? new Set<string>();
      keysOf.add(r.publicKey);
      byUser.set(r.userId, keysOf);
    }
    const requests: Array<{ userId: string; publicKey: string }> = [];
    // People not handled yet first: refused junk listed ahead of a real
    // teammate moves to the back after one run instead of starving them.
    for (const [userId, pubs] of byNovelty([...byUser], ([u]) => u, handledRequests)) {
      if (requests.length + out.refused.length >= MAX_KEY_REQUESTS_PER_RUN) break;
      handledRequests.add(userId);
      if (pubs.size !== 1) out.refused.push(userId);
      else requests.push({ userId, publicKey: [...pubs][0] });
    }
    const memberMemo = new Map<string, boolean>();
    const isMember = async (userId: string) => {
      if (!memberMemo.has(userId)) memberMemo.set(userId, await deps.isMember(vaultId, userId));
      return memberMemo.get(userId)!;
    };
    for (const r of requests) {
      let pub: Uint8Array;
      try {
        pub = fromBase64(r.publicKey);
      } catch {
        out.refused.push(r.userId);
        continue;
      }
      if (pub.length !== 32 || !(await isMember(r.userId))) {
        out.refused.push(r.userId);
        continue;
      }
      const fp = keyFingerprint(pub);
      const pinned = await deps.pins.get(r.userId);
      if (pinned && pinned !== fp) {
        out.keyChanged.push({ userId: r.userId, fingerprint: shortFingerprint(pub), publicKey: r.publicKey });
        continue;
      }
      try {
        await api.postVaultKeyWrap(
          vaultId,
          { userId: r.userId, generation: held.generation, sealedVk: toBase64(sealVkTo(pub, held.vk)) },
          held.b64,
        );
      } catch (e) {
        // Removed from the vault after the list was read (our roster may lag
        // a minute): skip that person, keep sealing for everyone else.
        if (isNotMemberRefusal(e)) {
          out.refused.push(r.userId);
          continue;
        }
        throw e;
      }
      if (!pinned) await deps.pins.set(r.userId, fp);
      out.sealed.push({ userId: r.userId, fingerprint: shortFingerprint(pub) });
    }
    return out;
  }

  /**
   * Service runs back to back while each one fills its per-run cap (a big team
   * right after conversion: 150 people = 3 runs now, not 3 runs 2 minutes
   * apart). Bounded by {@link MAX_BACK_TO_BACK_RUNS}; stops at the first run
   * that seals nobody (junk listings cannot keep it going).
   */
  async function serviceAllKeyRequests(vaultId: string): Promise<ServiceResult> {
    const all: ServiceResult = { sealed: [], refused: [], keyChanged: [] };
    for (let run = 0; run < MAX_BACK_TO_BACK_RUNS; run++) {
      const r = await serviceKeyRequests(vaultId);
      all.sealed.push(...r.sealed);
      all.refused.push(...r.refused);
      all.keyChanged.push(...r.keyChanged);
      if (!filledRun(r)) break;
    }
    return all;
  }

  /** `X-Baalda-VK` value for a vault: verified keys only. Synchronous. */
  function headerFor(vaultId: string): string | null {
    return verified.get(vaultId)?.b64 ?? null;
  }

  const session = {
    ensureAccountKeys,
    unlockWithPassword,
    restoreWithVaultKey,
    revealVaultKey,
    convertVault,
    gateVaultOpen,
    pendingDevices,
    approveDevice,
    denyDevice,
    startFreshAccountKey,
    accountKeyCode,
    approveChangedKey,
    ensureVaultKey,
    serviceKeyRequests,
    serviceAllKeyRequests,
    headerFor,
    inviteKeyMaterial,
    sealInviteResults,
    adoptFromSecret,
    uploadJoinWrap,
    /** The verified key's generation, else null. */
    heldGeneration(vaultId: string): number | null {
      return verified.get(vaultId)?.generation ?? null;
    },
    /** Does this device's keychain hold a key for the vault (verified or not)? */
    async holdsVaultKey(vaultId: string): Promise<boolean> {
      return verified.has(vaultId) || (await keys.getVaultKey(vaultId)) !== null;
    },
    /** Membership ended / vault gone: stop serving this vault's key (memory only;
     *  the keychain copy goes through `forget.ts`). */
    forgetVerified(vaultId: string) {
      verified.delete(vaultId);
    },
    clear() {
      verified.clear();
      offeredDevices.clear();
      handledRequests.clear();
      accountMismatch = false;
      pendingUnlock = null;
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

/** Most key requests handled in one run (the rest wait for the next run). */
export const MAX_KEY_REQUESTS_PER_RUN = 50;
/** Back-to-back service runs per cycle while each fills its cap (500 people). */
export const MAX_BACK_TO_BACK_RUNS = 10;

/** A run that sealed someone and used its whole per-run budget: more may wait. */
export function filledRun(r: ServiceResult): boolean {
  return r.sealed.length > 0 && r.sealed.length + r.refused.length + r.keyChanged.length >= MAX_KEY_REQUESTS_PER_RUN;
}

/** The server's 404 `not_member` for a wrap: that person left the vault. */
function isNotMemberRefusal(e: unknown): boolean {
  const err = e as { status?: unknown; body?: { code?: unknown } } | null;
  return err?.status === 404 && err.body?.code === "not_member";
}
/** Most "a new computer is signing in" prompts raised from one listing. */
export const MAX_PENDING_DEVICES = 5;

/** Items whose id is not in `handled` first, original order kept within each group. */
function byNovelty<T>(items: T[], idOf: (item: T) => unknown, handled: ReadonlySet<string>): T[] {
  const fresh: T[] = [];
  const old: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    (typeof id === "string" && handled.has(id) ? old : fresh).push(item);
  }
  return [...fresh, ...old];
}

/** A typed device code matches, ignoring case, spaces and dashes. */
function sameDeviceCode(typed: unknown, code: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
  const t = norm(typeof typed === "string" ? typed : "");
  return t.length === 8 && t === norm(code);
}

function sameKey(a: Uint8Array, b64: string): boolean {
  try {
    return toBase64(a) === toBase64(fromBase64(b64));
  } catch {
    return false;
  }
}
