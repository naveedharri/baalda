// SPDX-License-Identifier: Apache-2.0
//
// Vault keys for `mcp_` tokens (W3). A token carries, per keyed (or pending)
// vault of its org, the VK wrapped under its own secret (`mcp_token_keys`).
// Each call unwraps it, verifies it against the vault's check, and hands it to
// the tools for that call only: it is NEVER put in the process key cache.
//
// A token that predates the vault's key is upgraded on its next call when a
// member's device allow-listed it (`mcp_token_allow`, MAC under VK) and a VK
// is held in memory (the keyed cache, or the pending cache that a converting
// device keeps warm). This is the only place a request path consults a cache,
// and only to create the wrap the MAC proves a VK holder asked for.
import type pg from "pg";
import { vaultKeyCache } from "../crypto/key-cache.js";
import { heldKey } from "../crypto/conversion.js";
import { unwrapVk, verifyAllowMac, wrapVk } from "../crypto/token-wrap.js";
import { verifyVk } from "../crypto/vk-check.js";
import { decodeVk } from "../crypto/transport.js";

type Queryable = Pick<pg.Pool, "query">;

const TABLE = "mcp_token_keys";

export interface HeldKey {
  key: Buffer;
  generation: number;
}

interface VaultCheck {
  vaultId: string;
  check: Buffer;
  generation: number;
  pending: boolean;
}

/** The org's vaults that are keyed or pending a key (keyed wins). */
export async function orgVaultChecks(orgId: string, db: Queryable): Promise<VaultCheck[]> {
  const { rows } = await db.query<{
    id: string;
    vk_check: Buffer | null;
    key_generation: number | null;
    p_check: Buffer | null;
    p_generation: number | null;
  }>(
    `SELECT v.id, v.vk_check, v.key_generation, p.vk_check AS p_check, p.generation AS p_generation
       FROM vaults v LEFT JOIN vault_pending_keys p ON p.vault_id = v.id
      WHERE v.organization_id = $1 AND (v.vk_check IS NOT NULL OR p.vault_id IS NOT NULL)`,
    [orgId],
  );
  return rows.map((r) =>
    r.vk_check
      ? { vaultId: r.id, check: r.vk_check, generation: r.key_generation ?? 1, pending: false }
      : { vaultId: r.id, check: r.p_check as Buffer, generation: r.p_generation ?? 1, pending: true },
  );
}

/** Store wraps for a freshly minted token. Every key must verify, else nothing is written. */
export async function storeTokenWraps(
  token: string,
  tokenId: string,
  keys: Array<{ vaultId: string; key: Buffer; generation: number }>,
  db: Queryable,
): Promise<void> {
  for (const k of keys) {
    await db.query(
      `INSERT INTO mcp_token_keys (token_id, vault_id, generation, wrapped_vk) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, vault_id, generation) DO NOTHING`,
      [tokenId, k.vaultId, k.generation, wrapVk(token, "mcp-vk", TABLE, k.vaultId, tokenId, k.key, k.generation)],
    );
  }
}

/**
 * Per-call keys for a verified token. Vaults without a usable key are simply
 * absent: an unkeyed vault needs none (today's path), and a keyed vault the
 * token holds no key for refuses its content calls with `key_required`.
 */
export async function resolveTokenKeys(
  token: string,
  tokenId: string,
  tokenHash: string,
  orgId: string,
  db: Queryable,
): Promise<Map<string, HeldKey>> {
  const out = new Map<string, HeldKey>();
  const checks = await orgVaultChecks(orgId, db);
  if (checks.length === 0) return out;
  const { rows: wraps } = await db.query<{ vault_id: string; generation: number; wrapped_vk: Buffer }>(
    "SELECT vault_id, generation, wrapped_vk FROM mcp_token_keys WHERE token_id = $1",
    [tokenId],
  );
  for (const v of checks) {
    const mine = wraps.find((w) => w.vault_id === v.vaultId && w.generation === v.generation);
    if (mine) {
      const vk = unwrapVk(token, "mcp-vk", TABLE, v.vaultId, tokenId, mine.wrapped_vk);
      if (vk && verifyVk(vk, v.vaultId, v.check)) {
        out.set(v.vaultId, { key: vk, generation: v.generation });
        continue;
      }
      vk?.fill(0);
    }
    const upgraded = await tryUpgrade(token, tokenId, tokenHash, v, db);
    if (upgraded) out.set(v.vaultId, upgraded);
  }
  return out;
}

async function tryUpgrade(
  token: string,
  tokenId: string,
  tokenHash: string,
  v: VaultCheck,
  db: Queryable,
): Promise<HeldKey | null> {
  const { rows } = await db.query<{ mac: Buffer }>(
    "SELECT mac FROM mcp_token_allow WHERE token_id = $1 AND vault_id = $2",
    [tokenId, v.vaultId],
  );
  if (!rows[0]) return null;
  const vk = heldKey(v.vaultId, { check: v.check, generation: v.generation, pending: v.pending }, vaultKeyCache);
  if (!vk) return null;
  if (!verifyAllowMac(vk, tokenId, tokenHash, rows[0].mac)) {
    vk.fill(0);
    return null;
  }
  await storeTokenWraps(token, tokenId, [{ vaultId: v.vaultId, key: vk, generation: v.generation }], db);
  return { key: vk, generation: v.generation };
}

/**
 * Keys a desktop presented when minting a token, from `X-Baalda-VK`: either
 * one bare base64 key (tried against every keyed/pending vault of the org) or
 * `vaultId=<b64>` pairs separated by commas. Every KEYED vault of the org must
 * be covered by a key that verifies, else `missing` names it (the route answers
 * 409 `key_required`, nothing minted). A PENDING vault without a key is fine:
 * it is still plaintext, and the token can be allow-listed before conversion.
 */
export async function keysForMint(
  orgId: string,
  header: string | undefined,
  db: Queryable,
): Promise<{ keys: Array<{ vaultId: string; key: Buffer; generation: number }>; missing: string[] }> {
  const checks = await orgVaultChecks(orgId, db);
  const offered: Array<{ vaultId: string | null; key: Buffer }> = [];
  for (const part of (header ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=", 1);
    const named = eq > 0 && !/^[A-Za-z0-9+/_-]+={1,2}$/.test(part);
    const key = decodeVk(named ? part.slice(eq + 1) : part);
    if (key) offered.push({ vaultId: named ? part.slice(0, eq) : null, key });
  }
  const keys: Array<{ vaultId: string; key: Buffer; generation: number }> = [];
  const missing: string[] = [];
  for (const v of checks) {
    const hit = offered.find(
      (o) => (o.vaultId === null || o.vaultId === v.vaultId) && verifyVk(o.key, v.vaultId, v.check),
    );
    if (hit) keys.push({ vaultId: v.vaultId, key: hit.key, generation: v.generation });
    else if (!v.pending) missing.push(v.vaultId);
  }
  return { keys, missing };
}
