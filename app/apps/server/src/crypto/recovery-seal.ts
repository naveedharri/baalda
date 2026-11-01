// SPDX-License-Identifier: Apache-2.0
//
// The recovery copy's sealing format (crypto/key-recovery.ts), with no server
// imports, so the owner's offline script (scripts/key-recovery.ts) can use it.
//
// Format (version 1): 0x01 | ephemeral X25519 public (32) | nonce (12) | AES-256-GCM ct+tag.
// Key = HKDF-SHA256(ECDH, salt = ephemeral ‖ recipient, info = "baalda-key-recovery-v1|<vault>|<gen>");
// AAD = "bd-recovery|<vault>|<gen>".

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const KEY_BYTES = 32;
const VERSION = 0x01;
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function recoveryKeyFingerprint(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

const publicKeyObject = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const privateKeyObject = (raw: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });

function wrapKey(shared: Buffer, eph: Buffer, recipient: Buffer, vaultId: string, generation: number): Buffer {
  const info = `baalda-key-recovery-v1|${vaultId}|${generation}`;
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([eph, recipient]), info, 32));
}

const aad = (vaultId: string, generation: number) => Buffer.from(`bd-recovery|${vaultId}|${generation}`, "utf8");

/** Seal a vault key to the recovery public key. */
export function sealForRecovery(vk: Buffer, recipient: Buffer, vaultId: string, generation: number): Buffer {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const eph = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const shared = diffieHellman({ privateKey, publicKey: publicKeyObject(recipient) });
  const key = wrapKey(shared, eph, recipient, vaultId, generation);
  shared.fill(0);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(vaultId, generation));
  const ct = Buffer.concat([cipher.update(vk), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  return Buffer.concat([Buffer.from([VERSION]), eph, nonce, ct]);
}

/** Open a recovery copy with the OFFLINE private key (raw 32 bytes). Used only by the owner's script. */
export function openRecoveryCopy(sealed: Buffer, privateKey: Buffer, vaultId: string, generation: number): Buffer {
  if (sealed[0] !== VERSION || sealed.length !== 1 + 32 + 12 + KEY_BYTES + 16) throw new Error("not a recovery copy");
  const eph = sealed.subarray(1, 33);
  const nonce = sealed.subarray(33, 45);
  const body = sealed.subarray(45);
  const priv = privateKeyObject(privateKey);
  const recipient = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const shared = diffieHellman({ privateKey: priv, publicKey: publicKeyObject(eph) });
  const key = wrapKey(shared, eph, recipient, vaultId, generation);
  shared.fill(0);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad(vaultId, generation));
  decipher.setAuthTag(body.subarray(body.length - 16));
  const vk = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  key.fill(0);
  return vk;
}

/** The recovery public key (raw) for a raw private key. */
export function recoveryPublicFromPrivate(privateKey: Buffer): Buffer {
  return createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

/** A fresh recovery key pair (raw 32-byte keys). Only the script calls this. */
export function generateRecoveryKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length),
  };
}

