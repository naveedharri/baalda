// SPDX-License-Identifier: Apache-2.0
//
// AES-256-GCM envelope for vault-key encrypted columns (W3).
//
//   0x01 | u16 generation (big-endian) | 12-byte random nonce | ciphertext | 16-byte tag
//
// The AAD binds a value to where it lives (`aadFor`): table, column, vault and
// row key. Copying a sealed value into another row, column or vault fails to
// open, so a database writer cannot swap ciphertexts between rows. The header
// (version + generation + nonce) is authenticated as well.
//
// Telling sealed from plaintext: NEVER by sniffing. Yjs updates and blob bytes
// are arbitrary binary, and a plaintext update can start with 0x01 and be long
// enough to parse as an envelope. Encrypted data goes in its own `*_enc` column
// (or a row flag), and the column it was read from is what says "sealed".
// `isSealed` only checks that a buffer is SHAPED like an envelope (version
// byte + minimum length); it is a sanity check on a value already known to come
// from an encrypted column, never a way to classify an unknown value.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENVELOPE_VERSION = 0x01;
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 2 + NONCE_BYTES;
export const ENVELOPE_OVERHEAD = HEADER_BYTES + TAG_BYTES;
const MAX_GENERATION = 0xffff;

export function aadFor(table: string, column: string, vaultId: string, rowKey: string): Buffer {
  for (const part of [table, column, vaultId, rowKey]) {
    if (part.includes("|")) throw new Error("aadFor: parts must not contain '|'");
  }
  return Buffer.from(`bd1|${table}|${column}|${vaultId}|${rowKey}`, "utf8");
}

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
}

/**
 * GCM's additional data is `header || aad`: the 15 header bytes (version,
 * generation big-endian, nonce) followed by the `aadFor` bytes, one buffer.
 * The desktop must authenticate exactly the same concatenation.
 *
 * `nonceForTest` exists only for fixed interop vectors; production callers
 * never pass it (a reused GCM nonce under one key breaks confidentiality).
 */
export function seal(
  key: Buffer,
  aad: Buffer,
  plaintext: Buffer,
  generation = 1,
  nonceForTest?: Buffer,
): Buffer {
  checkKey(key);
  if (!Number.isInteger(generation) || generation < 0 || generation > MAX_GENERATION) {
    throw new Error("seal: generation must be an integer in 0..65535");
  }
  if (nonceForTest && nonceForTest.length !== NONCE_BYTES) throw new Error("seal: nonce must be 12 bytes");
  const nonce = nonceForTest ?? randomBytes(NONCE_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = ENVELOPE_VERSION;
  header.writeUInt16BE(generation, 1);
  nonce.copy(header, 3);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([header, aad]));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ct, cipher.getAuthTag()]);
}

/** Throws on a wrong key, wrong AAD, tampering or a malformed envelope. */
export function open(key: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  checkKey(key);
  if (!isSealed(sealed)) throw new Error("open: not an envelope");
  const header = sealed.subarray(0, HEADER_BYTES);
  const nonce = sealed.subarray(3, HEADER_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.concat([header, aad]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Shape check only (see the header note): never use it to classify unknown bytes. */
export function isSealed(buf: Buffer): boolean {
  return buf.length >= ENVELOPE_OVERHEAD && buf[0] === ENVELOPE_VERSION;
}

/** The key generation recorded in an envelope's header. */
export function generationOf(sealed: Buffer): number {
  if (!isSealed(sealed)) throw new Error("generationOf: not an envelope");
  return sealed.readUInt16BE(1);
}
