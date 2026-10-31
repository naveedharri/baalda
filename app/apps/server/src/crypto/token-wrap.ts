// SPDX-License-Identifier: Apache-2.0
//
// Vault keys wrapped under a bearer token's own secret (W3, security rule 3).
// The server stores only sha256(token); the wrapping key is
// HKDF-SHA256(token, info = "<purpose>|<vaultId>"), so a database copy holds
// neither the token nor anything that opens the wrap. The wrap reuses the
// envelope format (AES-256-GCM, AAD bound to table/column/vault/row).
//
// Allow-list MAC: HMAC-SHA256(VK, utf8(id) || utf8(hash)), written by a
// member's device for a token that predates the vault's key. Only a VK holder
// can produce it, so a token row inserted straight into the database never
// qualifies for a key. Interop contract with the desktop: hash is the
// lowercase hex sha256 of the secret, concatenated with no separator.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { KEY_BYTES, aadFor, open, seal } from "./envelope.js";

export type WrapPurpose = "mcp-vk" | "link" | "oauth-access" | "oauth-refresh" | "oauth-consent";

const SALT = Buffer.from("baalda-token-wrap-v1", "ascii");

export function deriveTokenKek(secret: string, purpose: WrapPurpose, vaultId: string): Buffer {
  if (vaultId.includes("|")) throw new Error("deriveTokenKek: vaultId must not contain '|'");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, `${purpose}|${vaultId}`, KEY_BYTES));
}

/** VK sealed under the token-derived key. `table`/`rowKey` bind the wrap to its row. */
export function wrapVk(
  secret: string,
  purpose: WrapPurpose,
  table: string,
  vaultId: string,
  rowKey: string,
  vk: Buffer,
  generation: number,
): Buffer {
  const kek = deriveTokenKek(secret, purpose, vaultId);
  try {
    return seal(kek, aadFor(table, "wrapped_vk", vaultId, rowKey), vk, generation);
  } finally {
    kek.fill(0);
  }
}

/** The VK, or null on any failure (wrong token, moved row, tampering). */
export function unwrapVk(
  secret: string,
  purpose: WrapPurpose,
  table: string,
  vaultId: string,
  rowKey: string,
  wrapped: Buffer,
): Buffer | null {
  const kek = deriveTokenKek(secret, purpose, vaultId);
  try {
    const vk = open(kek, aadFor(table, "wrapped_vk", vaultId, rowKey), wrapped);
    return vk.length === KEY_BYTES ? vk : null;
  } catch {
    return null;
  } finally {
    kek.fill(0);
  }
}

export function allowMac(vk: Buffer, tokenId: string, tokenHash: string): Buffer {
  // utf8(id) || utf8(hash), no separator (desktop contract). Unambiguous: the
  // hash is always 64 lowercase hex chars.
  return createHmac("sha256", vk).update(tokenId, "utf8").update(tokenHash, "utf8").digest();
}

export function verifyAllowMac(vk: Buffer, tokenId: string, tokenHash: string, mac: Buffer): boolean {
  const want = allowMac(vk, tokenId, tokenHash);
  return mac.length === want.length && timingSafeEqual(mac, want);
}
