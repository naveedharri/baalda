// Client-held vault keys (W3): pure crypto, no IO.
//
// Keys
// - VK (vault key): 32 random bytes per vault. The server never stores it; it
//   stores only `vk_check` (below) and one `sealedVk` per member.
// - Account keypair: X25519 (`@noble/curves`). The private key lives in the OS
//   keychain on each device and, wrapped by the recovery phrase, on the server.
//
// vk_check (must stay byte-compatible with the server's format)
//   AES-256-GCM (WebCrypto) under VK, plaintext = ASCII "baalda-vk-check-v1".
//   Layout: 0x01 | u16 BE generation | 12-byte nonce | ciphertext | 16-byte tag.
//   GCM additional data = the 15 header bytes (0x01 | generation | nonce)
//   followed by the ASCII "bd1|vaults|vk_check|<vaultId>|<vaultId>", one buffer.
//   Pinned by a fixed vector shared with the server (crypto.test.ts).
//
// sealedVk (desktop↔desktop only; the server never opens it)
//   An anonymous sealed box in the spirit of libsodium's crypto_box_seal, built
//   from audited primitives instead of XSalsa20:
//     eph            = fresh X25519 keypair
//     shared         = X25519(eph.secret, recipientPub)   (all-zero refused)
//     key            = HKDF-SHA256(ikm = shared, salt = ephPub || recipientPub,
//                                  info = "baalda-sealed-box-v1", L = 32)
//     nonce          = 24 random bytes
//     ct             = XChaCha20-Poly1305(key, nonce, aad = "baalda-sealed-box-v1")
//   Layout: 0x01 | ephPub (32) | nonce (24) | ciphertext + 16-byte tag.
//   For a 32-byte VK the box is 105 bytes.
//
// privWrappedRecovery
//   phrase = 24 BIP39 English words (256-bit entropy, `@scure/bip39`), normalized
//   (NFKD, lower case, single spaces) before use.
//     key   = Argon2id(phrase, salt (16 random), m, t, p, dkLen = 32)
//     ct    = XChaCha20-Poly1305(key, nonce (24 random), aad = "baalda-recovery-v1")
//   Layout: 0x01 | salt (16) | u32 BE m (KiB) | u32 BE t | u8 p | nonce (24) | ct + tag.
//   Defaults m = 64 MiB, t = 3, p = 1; the parameters travel in the blob so they
//   can change later, and reading caps them so a hostile blob cannot exhaust RAM.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

export const VK_BYTES = 32;
const VERSION = 0x01;
const enc = new TextEncoder();

// ---- bytes helpers ---------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Copy into a fresh ArrayBuffer-backed view (what WebCrypto's typings want). */
function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- vault key + vk_check --------------------------------------------------

export function generateVaultKey(): Uint8Array {
  return randomBytes(VK_BYTES);
}

export const VK_CHECK_PLAINTEXT = "baalda-vk-check-v1";
const GCM_NONCE = 12;
const GCM_TAG = 16;
const VK_CHECK_HEADER = 1 + 2 + GCM_NONCE;

export function vkCheckAad(vaultId: string): Uint8Array {
  return enc.encode(`bd1|vaults|vk_check|${vaultId}|${vaultId}`);
}

function assertVk(vk: Uint8Array): void {
  if (vk.length !== VK_BYTES) throw new Error("vault key must be 32 bytes");
}

async function aesKey(vk: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  assertVk(vk);
  return globalThis.crypto.subtle.importKey("raw", buf(vk), "AES-GCM", false, [usage]);
}

/** Seal the check constant under VK (the server's `vk_check`). */
/** `nonce` is for the fixed test vector only; production always draws one. */
export async function makeVkCheck(
  vk: Uint8Array,
  vaultId: string,
  generation: number,
  nonce: Uint8Array = randomBytes(GCM_NONCE),
): Promise<Uint8Array> {
  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffff) {
    throw new Error("generation must be a u16");
  }
  if (nonce.length !== GCM_NONCE) throw new Error("nonce must be 12 bytes");
  const header = concat(Uint8Array.of(VERSION, (generation >> 8) & 0xff, generation & 0xff), nonce);
  const key = await aesKey(vk, "encrypt");
  const sealed = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce), additionalData: buf(concat(header, vkCheckAad(vaultId))), tagLength: 128 },
      key,
      buf(enc.encode(VK_CHECK_PLAINTEXT)),
    ),
  );
  return concat(header, sealed);
}

/**
 * A `vk_check` that is the same bytes every time for (VK, vault, generation):
 * the nonce is HMAC-SHA256(VK, "baalda-vk-check-nonce|<vaultId>|<generation>")
 * truncated to 12 bytes. Safe because the plaintext is the one fixed constant,
 * so a repeated nonce only ever re-encrypts the identical message. Lets a
 * conversion that crashed resend exactly the check it registered.
 */
export async function makeStableVkCheck(vk: Uint8Array, vaultId: string, generation: number): Promise<Uint8Array> {
  assertVk(vk);
  const nonce = hmac(sha256, vk, enc.encode(`baalda-vk-check-nonce|${vaultId}|${generation}`)).slice(0, GCM_NONCE);
  return makeVkCheck(vk, vaultId, generation, nonce);
}

/** Allowlist proof for one credential: HMAC-SHA256(VK, utf8(id) || utf8(hash)). */
export function allowlistMac(vk: Uint8Array, id: string, hash: string): Uint8Array {
  assertVk(vk);
  return hmac(sha256, vk, concat(enc.encode(id), enc.encode(hash)));
}

/** The generation a `vk_check` was made for, or null when it is malformed. */
export function vkCheckGeneration(check: Uint8Array): number | null {
  if (check.length < VK_CHECK_HEADER + GCM_TAG || check[0] !== VERSION) return null;
  return (check[1] << 8) | check[2];
}

/** True when `vk` opens `check` for this vault. Never throws on a wrong key. */
export async function verifyVk(vk: Uint8Array, vaultId: string, check: Uint8Array): Promise<boolean> {
  if (vk.length !== VK_BYTES || vkCheckGeneration(check) === null) return false;
  try {
    const key = await aesKey(vk, "decrypt");
    const plain = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buf(check.subarray(3, VK_CHECK_HEADER)),
          additionalData: buf(concat(check.subarray(0, VK_CHECK_HEADER), vkCheckAad(vaultId))),
          tagLength: 128,
        },
        key,
        buf(check.subarray(VK_CHECK_HEADER)),
      ),
    );
    return equalBytes(plain, enc.encode(VK_CHECK_PLAINTEXT));
  } catch {
    return false;
  }
}

// ---- account keypair + sealed box ------------------------------------------

export type AccountKeypair = { publicKey: Uint8Array; privateKey: Uint8Array };

export function generateAccountKeypair(): AccountKeypair {
  const { secretKey, publicKey } = x25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/** Full fingerprint of a public key: lowercase hex SHA-256 (what pins store). */
export function keyFingerprint(publicKey: Uint8Array): string {
  return Array.from(sha256(publicKey), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Device-link code both computers show: "xxxx xxxx" from the device key. */
export function deviceCode(publicKey: Uint8Array): string {
  return keyFingerprint(publicKey).slice(0, 8).replace(/^(.{4})/, "$1 ");
}

/** Short form for people to compare: 4 groups of 4 hex, e.g. "1a2b 3c4d 5e6f 7a8b". */
export function shortFingerprint(publicKey: Uint8Array): string {
  return keyFingerprint(publicKey).slice(0, 16).match(/.{4}/g)!.join(" ");
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

const SEAL_INFO = enc.encode("baalda-sealed-box-v1");
const X_NONCE = 24;
const SEAL_HEADER = 1 + 32 + X_NONCE;

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new Error("low-order public key");
  return hkdf(sha256, shared, concat(ephPub, recipientPub), SEAL_INFO, 32);
}

/** Anonymous sealed box of `payload` to an X25519 public key. */
export function sealTo(recipientPublicKey: Uint8Array, payload: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== 32) throw new Error("public key must be 32 bytes");
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, recipientPublicKey);
  const key = sealKey(shared, eph.publicKey, recipientPublicKey);
  const nonce = randomBytes(X_NONCE);
  const ct = xchacha20poly1305(key, nonce, SEAL_INFO).encrypt(payload);
  return concat(Uint8Array.of(VERSION), eph.publicKey, nonce, ct);
}

/** Open a sealed box; throws when it is not for this key or was altered. */
export function openSealed(privateKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < SEAL_HEADER + 16 || sealed[0] !== VERSION) {
    throw new Error("malformed sealed box");
  }
  const ephPub = sealed.subarray(1, 33);
  const nonce = sealed.subarray(33, SEAL_HEADER);
  const recipientPub = x25519.getPublicKey(privateKey);
  const shared = x25519.getSharedSecret(privateKey, ephPub);
  const key = sealKey(shared, ephPub, recipientPub);
  return xchacha20poly1305(key, nonce, SEAL_INFO).decrypt(sealed.subarray(SEAL_HEADER));
}

export function sealVkTo(recipientPublicKey: Uint8Array, vk: Uint8Array): Uint8Array {
  assertVk(vk);
  return sealTo(recipientPublicKey, vk);
}

export function openSealedVk(privateKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  const vk = openSealed(privateKey, sealed);
  assertVk(vk);
  return vk;
}

// ---- vault key as words (owner-visible recovery) ----------------------------
//
// The 32-byte VK is BIP39 entropy: exactly 24 English words, the last carrying
// an 8-bit SHA-256 checksum, so a mistyped word is refused before any server
// check. The words ARE the key: whoever holds them can read the vault.

export function vaultKeyToWords(vk: Uint8Array): string {
  assertVk(vk);
  return entropyToMnemonic(vk, english);
}

/** The VK the words encode, or null for anything that is not 24 valid words. */
export function wordsToVaultKey(words: string): Uint8Array | null {
  const p = normalizePhrase(words);
  if (p.split(" ").length !== 24 || !validateMnemonic(p, english)) return null;
  const vk = mnemonicToEntropy(p, english);
  return vk.length === VK_BYTES ? vk : null;
}

/** Text for "Save to file": vault name, id and the 24 numbered words. */
export function vaultKeyFileText(vaultName: string, vaultId: string, vk: Uint8Array): string {
  const words = vaultKeyToWords(vk).split(" ");
  const lines = words.map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`);
  return [
    `Baalda vault key for "${vaultName}"`,
    `Vault id: ${vaultId}`,
    "",
    "Anyone with these 24 words can read this vault. Keep them somewhere safe.",
    "",
    ...lines,
    "",
  ].join("\n");
}

// ---- recovery phrase --------------------------------------------------------

// ---- password wrap of the account key (seamless keys F) --------------------
// XChaCha20-Poly1305 under the server's `unlockKey`, nonce(24) || ct, AAD
// utf8("bd-acct-pw|" + userId + "|" + publicKeyB64). Desktop only.

const PW_NONCE = 24;
export const accountPasswordAad = (userId: string, publicKeyB64: string) =>
  enc.encode(`bd-acct-pw|${userId}|${publicKeyB64}`);

export function wrapAccountKeyWithUnlock(
  unlockKey: Uint8Array,
  userId: string,
  publicKeyB64: string,
  privateKey: Uint8Array,
): Uint8Array {
  if (unlockKey.length !== 32) throw new Error("unlock key must be 32 bytes");
  const nonce = randomBytes(PW_NONCE);
  const ct = xchacha20poly1305(unlockKey, nonce, accountPasswordAad(userId, publicKeyB64)).encrypt(privateKey);
  const out = new Uint8Array(PW_NONCE + ct.length);
  out.set(nonce, 0);
  out.set(ct, PW_NONCE);
  return out;
}

/** Throws when the wrap does not open (wrong key, other user/public key, tampered). */
export function unwrapAccountKeyWithUnlock(
  unlockKey: Uint8Array,
  userId: string,
  publicKeyB64: string,
  wrapped: Uint8Array,
): Uint8Array {
  if (unlockKey.length !== 32 || wrapped.length <= PW_NONCE) throw new Error("malformed password wrap");
  return xchacha20poly1305(unlockKey, wrapped.subarray(0, PW_NONCE), accountPasswordAad(userId, publicKeyB64)).decrypt(
    wrapped.subarray(PW_NONCE),
  );
}

export type Argon2Params = { m: number; t: number; p: number };
/** m in KiB: 64 MiB, t = 3, p = 1. */
export const RECOVERY_ARGON2: Argon2Params = { m: 64 * 1024, t: 3, p: 1 };
const MAX_ARGON2_M = 1024 * 1024; // 1 GiB
const MAX_ARGON2_T = 64;
const RECOVERY_AAD = enc.encode("baalda-recovery-v1");
const SALT = 16;
const RECOVERY_HEADER = 1 + SALT + 4 + 4 + 1 + X_NONCE;

/** 24 BIP39 English words. */
export function newRecoveryPhrase(): string {
  return generateMnemonic(english, 256);
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").toLowerCase().trim().split(/\s+/).join(" ");
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  const p = normalizePhrase(phrase);
  return p.split(" ").length === 24 && validateMnemonic(p, english);
}

async function phraseKey(phrase: string, salt: Uint8Array, a: Argon2Params): Promise<Uint8Array> {
  return argon2idAsync(enc.encode(normalizePhrase(phrase)), salt, { ...a, dkLen: 32 });
}

export async function wrapPrivateKeyWithPhrase(
  phrase: string,
  privateKey: Uint8Array,
  params: Argon2Params = RECOVERY_ARGON2,
): Promise<Uint8Array> {
  if (!isValidRecoveryPhrase(phrase)) throw new Error("invalid recovery phrase");
  const salt = randomBytes(SALT);
  const key = await phraseKey(phrase, salt, params);
  const nonce = randomBytes(X_NONCE);
  const ct = xchacha20poly1305(key, nonce, RECOVERY_AAD).encrypt(privateKey);
  const p = new Uint8Array(9);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, params.m);
  dv.setUint32(4, params.t);
  dv.setUint8(8, params.p);
  return concat(Uint8Array.of(VERSION), salt, p, nonce, ct);
}

/** Throws on a wrong phrase, a tampered blob or out-of-range parameters. */
export async function unwrapPrivateKeyWithPhrase(phrase: string, wrapped: Uint8Array): Promise<Uint8Array> {
  if (wrapped.length < RECOVERY_HEADER + 16 || wrapped[0] !== VERSION) {
    throw new Error("malformed recovery blob");
  }
  const salt = wrapped.subarray(1, 1 + SALT);
  const dv = new DataView(wrapped.buffer, wrapped.byteOffset + 1 + SALT, 9);
  const params = { m: dv.getUint32(0), t: dv.getUint32(4), p: dv.getUint8(8) };
  if (params.m < 8 * params.p || params.m > MAX_ARGON2_M || params.t < 1 || params.t > MAX_ARGON2_T || params.p !== 1) {
    throw new Error("recovery blob parameters out of range");
  }
  const nonce = wrapped.subarray(1 + SALT + 9, RECOVERY_HEADER);
  const key = await phraseKey(phrase, salt, params);
  return xchacha20poly1305(key, nonce, RECOVERY_AAD).decrypt(wrapped.subarray(RECOVERY_HEADER));
}
