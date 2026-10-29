// SPDX-License-Identifier: Apache-2.0
//
// Public links in keyed vaults (W3, security rule 3). The link token is the
// only secret a viewer has, so it is what opens the vault key:
//
//   token_hash  sha256(token), how `/p/:token` finds the row
//   wrapped_vk  VK under HKDF(token, "link|<vaultId>") — a view needs no device
//   token_enc   the token sealed under VK, so members can still copy the URL
//
// In a keyed vault the plaintext `token` column is left NULL for new links.
// A link minted before the vault was keyed is upgraded on its first view after
// a member's device allow-listed it (`allow_mac`) while a VK is in memory —
// the same pattern as `mcp_` tokens (crypto/conversion.ts).
import { createHash } from "node:crypto";
import type pg from "pg";
import { vaultKeysEnabled } from "./config.js";
import { heldKey, vaultCheckState } from "./conversion.js";
import type { DocCrypto } from "./doc-crypto.js";
import { aadFor, open, seal } from "./envelope.js";
import { vaultKeyCache } from "./key-cache.js";
import { unwrapVk, verifyAllowMac, wrapVk } from "./token-wrap.js";
import { verifyVk } from "./vk-check.js";

type Queryable = Pick<pg.Pool, "query">;

const TABLE = "public_links";

export function linkTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sealLinkToken(vk: Buffer, vaultId: string, linkId: string, token: string, generation: number): Buffer {
  return seal(vk, aadFor(TABLE, "token", vaultId, linkId), Buffer.from(token, "utf8"), generation);
}

export function openLinkToken(vk: Buffer, vaultId: string, linkId: string, enc: Buffer): string | null {
  try {
    return open(vk, aadFor(TABLE, "token", vaultId, linkId), enc).toString("utf8");
  } catch {
    return null;
  }
}

export function wrapLinkVk(token: string, vaultId: string, linkId: string, vk: Buffer, generation: number): Buffer {
  return wrapVk(token, "link", TABLE, vaultId, linkId, vk, generation);
}

export interface LinkKeyRow {
  id: string;
  vault_id: string;
  token_enc: Buffer | null;
  wrapped_vk: Buffer | null;
  wrap_generation: number | null;
  allow_mac: Buffer | null;
}

/**
 * The key a VIEW of this link reads the note with. `{}` = no key needed
 * (unkeyed or pending vault: plaintext, today's path); `{crypto}` = keyed;
 * `"unavailable"` = keyed and this link has no usable key (never "empty").
 * While pending or keyed, an allow-listed link without a wrap is upgraded
 * here when a member's VK is held in memory.
 */
export async function linkCrypto(
  row: LinkKeyRow,
  token: string,
  db: Queryable,
): Promise<{ crypto?: DocCrypto } | "unavailable"> {
  if (!vaultKeysEnabled()) return {};
  const state = await vaultCheckState(row.vault_id, db);
  if (!state) return {};
  let vk: Buffer | null = null;
  if (row.wrapped_vk && row.wrap_generation === state.generation) {
    vk = unwrapVk(token, "link", TABLE, row.vault_id, row.id, row.wrapped_vk);
    if (vk && !verifyVk(vk, row.vault_id, state.check)) vk = null;
  }
  if (!vk && row.allow_mac) {
    const held = heldKey(row.vault_id, state, vaultKeyCache);
    if (held && verifyAllowMac(held, row.id, linkTokenHash(token), row.allow_mac)) {
      await db.query(
        `UPDATE public_links
            SET wrapped_vk = $2, wrap_generation = $3, token_enc = COALESCE(token_enc, $4)
          WHERE id = $1`,
        [
          row.id,
          wrapLinkVk(token, row.vault_id, row.id, held, state.generation),
          state.generation,
          sealLinkToken(held, row.vault_id, row.id, token, state.generation),
        ],
      );
      vk = held;
    } else {
      held?.fill(0);
    }
  }
  if (state.pending) {
    vk?.fill(0);
    return {};
  }
  return vk ? { crypto: { vaultId: row.vault_id, key: vk, generation: state.generation } } : "unavailable";
}
