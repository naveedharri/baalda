// SPDX-License-Identifier: Apache-2.0
//
// Vault keys for OAuth connector grants (W3). The connector's own tokens are
// the secret: a grant row carries VK wrapped under HKDF(access token) and under
// HKDF(refresh token) (`oauth_grant_keys`). The row stores only token hashes,
// so a database copy opens neither wrap.
//
// Where the key comes from, per grant:
// - A NEW connection to a keyed/converting vault: the user's desktop finished
//   the consent and presented VK (`oauth_consents` + the in-memory
//   `consentKeys`, rule 2). The code exchange wraps it under the new tokens.
// - A REFRESH: the client presents its refresh token in plaintext, which opens
//   the old row's refresh wrap; VK is rewrapped for the new pair. This is what
//   keeps MCP working with no desktop online.
// - A grant that PREDATES the vault's key: a member's device allow-listed it
//   (`oauth_grant_allow`, MAC = HMAC(VK, grant_id || bare hex sha256(refresh
//   token))). On its next refresh or call, while a VK is held in memory, the
//   MAC is checked and the wraps are stored. A row inserted into the database
//   has no valid MAC and never gets a key.
// - An allow-listed grant REFRESHED while no key is held: the new row gets a
//   carry (`oauth_grant_carry`): the root grant's allow entry plus the root's
//   refresh token sealed under the new refresh token. A later refresh with a
//   key held opens it, checks the token against the root hash and the root MAC
//   with the key, and stores the wraps. Without this, one unattended hourly
//   refresh cost the connection its claim (2026-11-02).
// VKs unwrapped for a call are handed to that call only, never cached.
import { createHash } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "../crypto/config.js";
import { vaultKeyCache } from "../crypto/key-cache.js";
import { heldKey } from "../crypto/conversion.js";
import { unwrapSecret, unwrapVk, verifyAllowMac, wrapSecret, wrapVk } from "../crypto/token-wrap.js";
import { verifyVk } from "../crypto/vk-check.js";
import { orgVaultChecks, type HeldKey } from "./token-keys.js";
import type { IssuedGrant } from "./oauth-token-endpoint.js";

type Queryable = Pick<pg.Pool, "query">;
type Kind = "access" | "refresh";

const TABLE = "oauth_grant_keys";
const purpose = (kind: Kind): "oauth-access" | "oauth-refresh" =>
  kind === "access" ? "oauth-access" : "oauth-refresh";

/** The vault (org) a grant acts on: the consent binding, else the user's sole vault. */
export async function grantOrg(clientId: string, userId: string, db: Queryable = defaultPool): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM mcp_oauth_vault WHERE client_id = $1 AND user_id = $2",
    [clientId, userId],
  );
  if (rows[0]) return rows[0].organization_id;
  const { rows: m } = await db.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return m.length === 1 ? m[0].organizationId : null;
}

async function storeWrap(
  token: string,
  grantId: string,
  kind: Kind,
  vaultId: string,
  key: Buffer,
  generation: number,
  db: Queryable,
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_grant_keys (grant_id, vault_id, generation, kind, wrapped_vk) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (grant_id, vault_id, generation, kind) DO NOTHING`,
    [grantId, vaultId, generation, kind, wrapVk(token, purpose(kind), TABLE, vaultId, `${grantId}:${kind}`, key, generation)],
  );
}

async function openWrap(
  token: string,
  grantId: string,
  kind: Kind,
  v: { vaultId: string; check: Buffer; generation: number },
  db: Queryable,
): Promise<Buffer | null> {
  const { rows } = await db.query<{ wrapped_vk: Buffer }>(
    "SELECT wrapped_vk FROM oauth_grant_keys WHERE grant_id = $1 AND vault_id = $2 AND generation = $3 AND kind = $4",
    [grantId, v.vaultId, v.generation, kind],
  );
  if (!rows[0]) return null;
  const vk = unwrapVk(token, purpose(kind), TABLE, v.vaultId, `${grantId}:${kind}`, rows[0].wrapped_vk);
  if (vk && verifyVk(vk, v.vaultId, v.check)) return vk;
  vk?.fill(0);
  return null;
}

/** A VK from memory for an allow-listed pre-existing grant, or null. */
async function allowListedKey(
  grantId: string,
  refreshHashHex: string,
  v: { vaultId: string; check: Buffer; generation: number; pending: boolean },
  db: Queryable,
): Promise<Buffer | null> {
  const { rows } = await db.query<{ mac: Buffer }>(
    "SELECT mac FROM oauth_grant_allow WHERE grant_id = $1 AND vault_id = $2",
    [grantId, v.vaultId],
  );
  if (!rows[0]) return null;
  const vk = heldKey(v.vaultId, { check: v.check, generation: v.generation, pending: v.pending }, vaultKeyCache);
  if (!vk) return null;
  if (!verifyAllowMac(vk, grantId, refreshHashHex, rows[0].mac)) {
    vk.fill(0);
    return null;
  }
  return vk;
}

const CARRY = "oauth_grant_carry";
const CARRY_COLUMN = "wrapped_root_refresh";

/** An allow-listed root grant, as carried across refreshes (see {@link CARRY}). */
interface CarriedClaim {
  rootGrantId: string;
  rootRefreshHash: string;
  rootMac: Buffer;
  /** The root's refresh token: the possession proof. Zeroed by the caller. */
  rootRefresh: Buffer;
}

/** The claim `grantId` holds on `vaultId`: its own allow entry (root = itself,
 *  proved by the refresh token just presented) or a carry it can open with that
 *  token. Null when it holds neither. */
async function claimOf(
  grantId: string,
  refreshToken: string,
  refreshHashHex: string,
  vaultId: string,
  db: Queryable,
): Promise<CarriedClaim | null> {
  const { rows: allow } = await db.query<{ mac: Buffer }>(
    "SELECT mac FROM oauth_grant_allow WHERE grant_id = $1 AND vault_id = $2",
    [grantId, vaultId],
  );
  if (allow[0]) {
    return { rootGrantId: grantId, rootRefreshHash: refreshHashHex, rootMac: allow[0].mac, rootRefresh: Buffer.from(refreshToken, "utf8") };
  }
  const { rows } = await db.query<{ root_grant_id: string; root_refresh_hash: string; root_mac: Buffer; wrapped_root_refresh: Buffer }>(
    `SELECT root_grant_id, root_refresh_hash, root_mac, wrapped_root_refresh FROM ${CARRY} WHERE grant_id = $1 AND vault_id = $2`,
    [grantId, vaultId],
  );
  const c = rows[0];
  if (!c) return null;
  const rootRefresh = unwrapSecret(refreshToken, "oauth-carry", CARRY, CARRY_COLUMN, vaultId, `${grantId}:carry`, c.wrapped_root_refresh);
  if (!rootRefresh) return null;
  return { rootGrantId: c.root_grant_id, rootRefreshHash: c.root_refresh_hash, rootMac: c.root_mac, rootRefresh };
}

/** The key, when `claim` is genuine: the sealed token hashes to the root's
 *  hash and the root MAC verifies under the held key. Null otherwise. */
function keyForClaim(
  claim: CarriedClaim,
  v: { vaultId: string; check: Buffer; generation: number; pending: boolean },
): Buffer | null {
  if (createHash("sha256").update(claim.rootRefresh).digest("hex") !== claim.rootRefreshHash) return null;
  const vk = heldKey(v.vaultId, { check: v.check, generation: v.generation, pending: v.pending }, vaultKeyCache);
  if (!vk) return null;
  if (!verifyAllowMac(vk, claim.rootGrantId, claim.rootRefreshHash, claim.rootMac)) {
    vk.fill(0);
    return null;
  }
  return vk;
}

/** Hand the claim to the new grant, sealed under its refresh token. */
async function storeCarry(grantId: string, refreshToken: string, vaultId: string, claim: CarriedClaim, db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO ${CARRY} (grant_id, vault_id, root_grant_id, root_refresh_hash, root_mac, wrapped_root_refresh)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (grant_id, vault_id) DO NOTHING`,
    [
      grantId,
      vaultId,
      claim.rootGrantId,
      claim.rootRefreshHash,
      claim.rootMac,
      wrapSecret(refreshToken, "oauth-carry", CARRY, CARRY_COLUMN, vaultId, `${grantId}:carry`, claim.rootRefresh),
    ],
  );
}

/**
 * Per-call keys for a resolved OAuth access token. Vaults without a usable key
 * are absent: an unkeyed vault needs none (today's path), and a keyed vault
 * refuses content calls with `key_required`, as for `mcp_` tokens.
 */
export async function resolveGrantKeys(
  accessToken: string,
  grant: { id: string; refreshHashHex: string },
  orgId: string,
  db: Queryable = defaultPool,
): Promise<Map<string, HeldKey>> {
  const out = new Map<string, HeldKey>();
  for (const v of await orgVaultChecks(orgId, db)) {
    let vk = await openWrap(accessToken, grant.id, "access", v, db);
    if (!vk) {
      vk = await allowListedKey(grant.id, grant.refreshHashHex, v, db);
      // A failed store only means the upgrade retries on the next call.
      if (vk) {
        await storeWrap(accessToken, grant.id, "access", v.vaultId, vk, v.generation, db).catch((err) =>
          console.warn("[oauth] grant key upgrade not stored:", (err as Error).message),
        );
      }
    }
    if (vk) out.set(v.vaultId, { key: vk, generation: v.generation });
  }
  return out;
}

// ── Desktop-completed consent (rule 2) ──────────────────────────────────────
// VK a desktop presented for a consent, held in process memory only, until the
// code exchange wraps it (or it expires). Never persisted.
interface ConsentKey {
  vaultId: string;
  key: Buffer;
  generation: number;
  expiresAt: number;
}
const consentKeys = new Map<string, ConsentKey[]>();

export const CONSENT_TTL_MS = 10 * 60 * 1000;

export function holdConsentKeys(consentId: string, keys: Array<{ vaultId: string; key: Buffer; generation: number }>): void {
  dropConsentKeys(consentId);
  const expiresAt = Date.now() + CONSENT_TTL_MS;
  consentKeys.set(consentId, keys.map((k) => ({ ...k, key: Buffer.from(k.key), expiresAt })));
  setTimeout(() => dropConsentKeys(consentId), CONSENT_TTL_MS).unref?.();
}

/** True while a consent still holds unexpired keys in this process. */
export function hasConsentKeys(consentId: string): boolean {
  const keys = consentKeys.get(consentId);
  return !!keys && keys.length > 0 && keys.every((k) => k.expiresAt > Date.now());
}

export function dropConsentKeys(consentId: string): void {
  for (const k of consentKeys.get(consentId) ?? []) k.key.fill(0);
  consentKeys.delete(consentId);
}

/** Take (and forget) the newest approved, unconsumed consent's keys for this
 *  (user, client). Marks the consent consumed. */
async function takeConsentKeys(
  userId: string,
  clientId: string,
  db: Queryable,
): Promise<ConsentKey[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE oauth_consents SET consumed_at = now()
      WHERE id = (SELECT id FROM oauth_consents
                   WHERE user_id = $1 AND client_id = $2 AND approved_at IS NOT NULL
                     AND consumed_at IS NULL AND expires_at > now()
                   ORDER BY approved_at DESC LIMIT 1)
      RETURNING id`,
    [userId, clientId],
  );
  const id = rows[0]?.id;
  if (!id) return [];
  const keys = (consentKeys.get(id) ?? []).filter((k) => k.expiresAt > Date.now());
  consentKeys.delete(id);
  return keys;
}

/**
 * After the token endpoint issued tokens: give the new grant its wraps.
 * Never throws away a key; when no key source applies, the grant simply has
 * none (an unkeyed vault needs none; a keyed one answers key_required).
 */
export async function rewrapOnIssue(grant: IssuedGrant, db: Queryable = defaultPool): Promise<void> {
  if (!vaultKeysEnabled()) return;
  const { rows } = await db.query<{ clientId: string; userId: string | null }>(
    `SELECT "clientId", "userId" FROM "oauthAccessToken" WHERE "id" = $1`,
    [grant.grantId],
  );
  const row = rows[0];
  if (!row?.userId) return;
  const orgId = await grantOrg(row.clientId, row.userId, db);
  if (!orgId) return;
  const checks = await orgVaultChecks(orgId, db);
  if (checks.length === 0) return;

  const fromConsent = grant.previous ? [] : await takeConsentKeys(row.userId, row.clientId, db);
  try {
    for (const v of checks) {
      let vk: Buffer | null = null;
      if (grant.previous) {
        const prev = grant.previous;
        vk =
          (await openWrap(prev.refreshToken, prev.grantId, "refresh", v, db)) ??
          (await allowListedKey(prev.grantId, prev.refreshHashHex, v, db));
        if (!vk) {
          // An allow entry or carry with no key held: verify it now if a key is
          // held, else pass it on to the new row. A claim that fails while a key
          // IS held is never passed on.
          const claim = await claimOf(prev.grantId, prev.refreshToken, prev.refreshHashHex, v.vaultId, db);
          if (claim) {
            try {
              const held = heldKey(v.vaultId, { check: v.check, generation: v.generation, pending: v.pending }, vaultKeyCache);
              if (held) {
                held.fill(0);
                vk = keyForClaim(claim, v);
              } else if (grant.refreshToken) {
                await storeCarry(grant.grantId, grant.refreshToken, v.vaultId, claim, db);
              }
            } finally {
              claim.rootRefresh.fill(0);
            }
          }
        }
        // The consumed row is covered too (its refresh token stays valid).
        if (vk) await storeWrap(prev.refreshToken, prev.grantId, "refresh", v.vaultId, vk, v.generation, db);
      } else {
        const c = fromConsent.find((k) => k.vaultId === v.vaultId && k.generation === v.generation);
        if (c && verifyVk(c.key, v.vaultId, v.check)) vk = Buffer.from(c.key);
      }
      if (!vk) continue;
      try {
        await storeWrap(grant.accessToken, grant.grantId, "access", v.vaultId, vk, v.generation, db);
        if (grant.refreshToken) {
          await storeWrap(grant.refreshToken, grant.grantId, "refresh", v.vaultId, vk, v.generation, db);
        }
      } finally {
        vk.fill(0);
      }
    }
  } finally {
    for (const k of fromConsent) k.key.fill(0);
  }
}
