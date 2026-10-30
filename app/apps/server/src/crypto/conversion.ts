// SPDX-License-Identifier: Apache-2.0
//
// Converting an existing vault to a client-held key (W3) without breaking a
// single MCP connection or public link ("MCP behaves exactly as today").
//
//   1. PENDING. The converting desktop generates VK and registers the future
//      check (`POST /vaults/:id/keys/pending`). `vaults.vk_check` stays NULL,
//      so the vault is still plaintext and every path (sync, MCP, links) is
//      exactly today's. The server can now verify a presented VK.
//   2. ALLOW-LIST. The desktop reads `GET …/keys/allowlist-candidates` (the
//      org's live `mcp_` tokens, OAuth grants and the vault's public links,
//      with their hashes) and posts HMAC(VK, utf8(id) || utf8(hash)) for each
//      (`POST …/keys/allowlist`). A row inserted without VK never has a MAC.
//   3. UPGRADE. On each allow-listed token's next call (link's next view),
//      while a member's VK is held in memory, the server checks the MAC and
//      stores VK wrapped under that token's own secret. The desktop keeps the
//      pending key warm by polling `GET …/keys/conversion-ready` with
//      `X-Baalda-VK` (each verified poll holds it for the cache grace period).
//   4. CONVERT. `conversion-ready` turns true once no token used, no link
//      viewed, and no OAuth grant active in the last 30 days lacks a wrap.
//      Only then does `keys/init` accept, with the SAME check bytes as the
//      pending row; it refuses otherwise (409 `conversion_not_ready` /
//      `pending_mismatch`). Backfill and sealing start only after init, so the
//      vault's content is readable to MCP and links the whole time.
//
// OAuth grants (slice 2) have no wraps yet, so any grant active in the last 30
// days keeps the vault pending: conservative on purpose.
import type pg from "pg";
import { VaultKeyCache } from "./key-cache.js";
import { loadVkCheck } from "./transport.js";
import { verifyVk } from "./vk-check.js";

type Queryable = Pick<pg.Pool, "query">;

export const ACTIVE_WINDOW_DAYS = 30;

/**
 * Keys a converting device presented for a vault that is NOT keyed yet. Kept
 * apart from the main `vaultKeyCache` on purpose: background work that finds
 * a key there (compaction, backfill) seals, and a pending vault must never be
 * sealed before conversion.
 */
export const pendingKeyCache = new VaultKeyCache();

export interface VaultCheckState {
  check: Buffer;
  generation: number;
  /** True while the vault is not keyed yet (the check is the pending one). */
  pending: boolean;
}

export async function loadPendingCheck(
  vaultId: string,
  db: Queryable,
): Promise<{ vkCheck: Buffer; generation: number } | null> {
  const { rows } = await db.query<{ vk_check: Buffer; generation: number }>(
    "SELECT vk_check, generation FROM vault_pending_keys WHERE vault_id = $1",
    [vaultId],
  );
  return rows[0] ? { vkCheck: rows[0].vk_check, generation: rows[0].generation } : null;
}

/** The check a presented VK is verified against: keyed wins over pending. */
export async function vaultCheckState(vaultId: string, db: Queryable): Promise<VaultCheckState | null> {
  const keyed = await loadVkCheck(vaultId, db);
  if (keyed) return { check: keyed.vkCheck, generation: keyed.generation, pending: false };
  const pending = await loadPendingCheck(vaultId, db);
  return pending ? { check: pending.vkCheck, generation: pending.generation, pending: true } : null;
}

/**
 * Verify a key a member's device presented, and while the vault is pending
 * hold it in {@link pendingKeyCache} for the grace period (acquire + release),
 * so allow-listed tokens and links can upgrade on their next use.
 */
export async function verifyPresentedKey(
  vaultId: string,
  vk: Buffer | null,
  db: Queryable,
): Promise<VaultCheckState | null> {
  if (!vk) return null;
  const state = await vaultCheckState(vaultId, db);
  if (!state || !verifyVk(vk, vaultId, state.check)) return null;
  if (state.pending) pendingKeyCache.acquire(vaultId, vk, state.generation)();
  return state;
}

/** A copy of an in-memory VK for upgrade work (caller zeroes it), or null. */
export function heldKey(vaultId: string, state: VaultCheckState, keyed: VaultKeyCache): Buffer | null {
  const held = (state.pending ? pendingKeyCache : keyed).get(vaultId);
  if (!held) return null;
  if (!verifyVk(held.key, vaultId, state.check)) {
    held.key.fill(0);
    return null;
  }
  return held.key;
}

export interface ConversionBlockers {
  tokens: string[];
  links: string[];
  oauthGrants: number;
}

/**
 * What still lacks a wrap for `generation` and was used in the last 30 days,
 * minus what an owner/admin unchecked in the conversion review
 * (`vault_conversion_exclusions`): those were never allow-listed, so they could
 * never be wrapped, and waiting for them would hold the vault pending forever.
 * They need reconnecting after conversion (the review says so).
 */
export async function conversionBlockers(
  vaultId: string,
  generation: number,
  db: Queryable,
): Promise<ConversionBlockers> {
  const { rows: tokens } = await db.query<{ id: string }>(
    `SELECT t.id FROM mcp_tokens t JOIN vaults v ON v.organization_id = t.organization_id
      WHERE v.id = $1
        AND t.last_used_at > now() - make_interval(days => $3)
        AND NOT EXISTS (SELECT 1 FROM mcp_token_keys k
                         WHERE k.token_id = t.id AND k.vault_id = $1 AND k.generation = $2)
        AND NOT EXISTS (SELECT 1 FROM vault_conversion_exclusions x
                         WHERE x.vault_id = $1 AND x.kind = 'mcp_token' AND x.item_id = t.id)
      ORDER BY t.id`,
    [vaultId, generation, ACTIVE_WINDOW_DAYS],
  );
  const { rows: links } = await db.query<{ id: string }>(
    `SELECT id FROM public_links l
      WHERE vault_id = $1
        AND (last_viewed_at > now() - make_interval(days => $3)
             OR view_tracking_since > now() - make_interval(days => $3))
        AND (wrapped_vk IS NULL OR wrap_generation IS DISTINCT FROM $2)
        AND NOT EXISTS (SELECT 1 FROM vault_conversion_exclusions x
                         WHERE x.vault_id = $1 AND x.kind = 'public_link' AND x.item_id = l.id)
      ORDER BY id`,
    [vaultId, generation, ACTIVE_WINDOW_DAYS],
  );
  const { rows: oauth } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM "oauthAccessToken" a
       JOIN mcp_oauth_vault m ON m.client_id = a."clientId" AND m.user_id = a."userId"
       JOIN vaults v ON v.organization_id = m.organization_id
      WHERE v.id = $1
        AND GREATEST(a."createdAt", a."updatedAt", a."accessTokenExpiresAt")
            > now() - make_interval(days => $2)
        -- A grant is covered once every token that can still act holds a wrap
        -- for this generation: a live access token needs an access wrap, a
        -- usable refresh token (offline_access, unexpired) a refresh wrap.
        AND NOT EXISTS (SELECT 1 FROM vault_conversion_exclusions x
                         WHERE x.vault_id = $1 AND x.kind = 'oauth_grant' AND x.item_id = a.id)
        AND (
          (a."accessTokenExpiresAt" > now() AND NOT EXISTS (
             SELECT 1 FROM oauth_grant_keys k WHERE k.grant_id = a.id AND k.vault_id = $1
               AND k.generation = $3 AND k.kind = 'access'))
          OR (a."refreshTokenExpiresAt" > now()
              AND ' ' || a.scopes || ' ' LIKE '% offline_access %'
              AND NOT EXISTS (
             SELECT 1 FROM oauth_grant_keys k WHERE k.grant_id = a.id AND k.vault_id = $1
               AND k.generation = $3 AND k.kind = 'refresh'))
        )`,
    [vaultId, ACTIVE_WINDOW_DAYS, generation],
  );
  return {
    tokens: tokens.map((r) => r.id),
    links: links.map((r) => r.id),
    oauthGrants: Number(oauth[0]?.n ?? 0),
  };
}

export function isReady(b: ConversionBlockers): boolean {
  return b.tokens.length === 0 && b.links.length === 0 && b.oauthGrants === 0;
}

/**
 * Opt-in (migration 081): an existing vault is keyed only after an owner/admin
 * asked for it (`keys/request-encryption`), or it was created with vault keys
 * on. `keys/pending` and `keys/init` refuse otherwise, whatever the client, so
 * an old, buggy or hostile desktop cannot encrypt a vault nobody opted in. The
 * request is one-way (never cleared), so a check outside the init lock cannot
 * be invalidated by a later write.
 */
export const ENCRYPTION_NOT_REQUESTED = {
  error: "Nobody has asked to encrypt this vault yet. An owner or admin can turn it on in Vault Settings.",
  code: "encryption_not_requested",
} as const;

/**
 * A vault that already holds sealed data or key material must never be keyed
 * again: a NEW key would leave every sealed row unreadable. `vk_check` being
 * NULL alone proves nothing (anyone with database access can clear it), so
 * `keys/init` and `keys/pending` also ask this. Sealed rows are the anchor a
 * database writer cannot fake away without destroying the data itself.
 */
export const KEY_MATERIAL_EXISTS = {
  error: "This vault already holds encrypted data. Open Baalda on a device that has its key, or restore it with the vault key.",
  code: "key_material_exists",
} as const;

export async function vaultHasKeyMaterial(vaultId: string, db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ found: boolean }>(
    `SELECT (
          EXISTS (SELECT 1 FROM vault_key_wraps WHERE vault_id = $1)
       OR EXISTS (SELECT 1 FROM vault_key_wrap_history WHERE vault_id = $1)
       OR EXISTS (SELECT 1 FROM vault_crypto_state WHERE vault_id = $1)
       OR EXISTS (SELECT 1 FROM note_index WHERE vault_id = $1 AND search_enc IS NOT NULL)
       OR EXISTS (SELECT 1 FROM blob_text WHERE vault_id = $1 AND search_enc IS NOT NULL)
       OR EXISTS (SELECT 1 FROM note_texts WHERE vault_id = $1 AND content_enc IS NOT NULL)
       -- Driven from the vault's notes/files (indexed by vault), so a large
       -- unkeyed vault costs index probes, never a scan of the whole log.
       OR EXISTS (SELECT 1 FROM notes n JOIN doc_updates d ON d.doc_id = n.id
                   WHERE n.vault_id = $1 AND d.update_enc IS NOT NULL)
       OR EXISTS (SELECT 1 FROM files f JOIN doc_updates d ON d.doc_id = f.id
                   WHERE f.vault_id = $1 AND d.update_enc IS NOT NULL)
       OR EXISTS (SELECT 1 FROM notes n JOIN doc_snapshots d ON d.doc_id = n.id
                   WHERE n.vault_id = $1 AND d.snapshot_enc IS NOT NULL)
       OR EXISTS (SELECT 1 FROM files f JOIN doc_snapshots d ON d.doc_id = f.id
                   WHERE f.vault_id = $1 AND d.snapshot_enc IS NOT NULL)
     ) AS found`,
    [vaultId],
  );
  return rows[0]?.found === true;
}

export async function encryptionRequested(vaultId: string, db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ requested: boolean }>(
    "SELECT encryption_requested_at IS NOT NULL AS requested FROM vaults WHERE id = $1",
    [vaultId],
  );
  return rows[0]?.requested === true;
}

/**
 * Lock what the `keys/init` gate reads, inside the init transaction (after the
 * vault row's FOR UPDATE): the pending row and every token/link row whose
 * `last_used_at` / `last_viewed_at` / wrap the gate judges. A concurrent
 * token use or link view then waits for the init to commit instead of landing
 * between the gate's read and the `vk_check` write.
 */
export async function lockGateRows(db: Queryable, vaultId: string): Promise<void> {
  await db.query("SELECT 1 FROM vault_pending_keys WHERE vault_id = $1 FOR UPDATE", [vaultId]);
  await db.query(
    `SELECT 1 FROM mcp_tokens t JOIN vaults v ON v.organization_id = t.organization_id
      WHERE v.id = $1 FOR UPDATE OF t`,
    [vaultId],
  );
  await db.query("SELECT 1 FROM public_links WHERE vault_id = $1 FOR UPDATE", [vaultId]);
  await db.query("SELECT 1 FROM vault_conversion_exclusions WHERE vault_id = $1 FOR UPDATE", [vaultId]);
}

/**
 * The `keys/init` gate (call it inside the init transaction, after
 * {@link lockGateRows}): null = may key the vault now; else the 409 body. With
 * a pending row, init must present the SAME check bytes and generation (the
 * wraps made while pending are under that key). With or without one, nothing
 * active may lack a wrap: keying it would cut that connection off.
 */
export async function initGate(
  vaultId: string,
  vkCheck: Buffer,
  generation: number,
  db: Queryable,
): Promise<{ error: string; code: string; blockers?: { tokens: number; links: number; oauthGrants: number } } | null> {
  const pending = await loadPendingCheck(vaultId, db);
  if (pending && (!pending.vkCheck.equals(vkCheck) || pending.generation !== generation)) {
    return { error: "This vault is being converted with a different key", code: "pending_mismatch" };
  }
  const b = await conversionBlockers(vaultId, generation, db);
  if (!isReady(b)) {
    return {
      error: "Connected AI tools and public links are still being upgraded; try again later",
      code: "conversion_not_ready",
      blockers: { tokens: b.tokens.length, links: b.links.length, oauthGrants: b.oauthGrants },
    };
  }
  return null;
}
