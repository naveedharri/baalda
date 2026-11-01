// SPDX-License-Identifier: Apache-2.0
//
// Seamless vault keys, invitation side (B1–B3). The vault key reaches an
// invited person without a teammate being online:
//   - B1: the inviting device wraps VK under a random invite secret S that
//     travels only in the emailed link's fragment; the server stores the
//     wrap (`invitation_vault_keys.wrapped_vk`), never S.
//   - B2: when the invitee already has an account key, the inviting device
//     also seals VK straight to it (`sealed_vk` + the key it sealed to).
//   - B3: on acceptance, a B2 seal whose key is still the invitee's CURRENT
//     account key becomes their ordinary `vault_key_wraps` row.
// Every stored wrap came from a device that proved it holds VK
// (X-Baalda-VK, `requireVaultKey`). Nothing here can open a vault from rows.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "../crypto/config.js";

type Queryable = Pick<pg.Pool, "query">;

/** Crockford base32, 16 random bytes = 26 chars, no padding. */
export const SECRET_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_WRAP_B64 = 4 * 1024;

export function wrapB64(v: unknown): Buffer | null {
  if (typeof v !== "string" || v === "" || v.length > MAX_WRAP_B64 || !B64_RE.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length > 0 ? buf : null;
}

export function generationOk(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 0xffff;
}

export type InviteVaultKeys = {
  vaultId: string;
  generation: number;
  /** By lowercased email. */
  items: Map<string, { wrappedVk: Buffer; secret: string }>;
};

/**
 * `vaultKeys` of `POST /orgs/:orgId/invitations`, or null when malformed. An
 * item with a bad email, wrap or secret is dropped (that invitee simply gets
 * no secret wrap); the envelope itself must be well formed.
 */
export function parseInviteVaultKeys(raw: unknown): InviteVaultKeys | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.vaultId !== "string" || !r.vaultId || r.vaultId.length > 200) return null;
  if (!generationOk(r.generation)) return null;
  if (!Array.isArray(r.items) || r.items.length > 100) return null;
  const items = new Map<string, { wrappedVk: Buffer; secret: string }>();
  for (const it of r.items) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    const email = typeof i.email === "string" ? i.email.trim().toLowerCase() : "";
    const wrappedVk = wrapB64(i.wrappedVk);
    const secret = typeof i.secret === "string" ? i.secret : "";
    if (!email || !wrappedVk || !SECRET_RE.test(secret)) continue;
    items.set(email, { wrappedVk, secret });
  }
  return { vaultId: r.vaultId, generation: r.generation, items };
}

/** B1: store one invitation's secret wrap. Best-effort: false on failure. */
export async function storeInvitationWrap(
  input: { invitationId: string; vaultId: string; generation: number; wrappedVk: Buffer; createdBy: string },
  db: Queryable = defaultPool,
): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO invitation_vault_keys (invitation_id, vault_id, generation, wrapped_vk, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invitation_id) DO UPDATE
         SET generation = EXCLUDED.generation, wrapped_vk = EXCLUDED.wrapped_vk,
             created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()
       WHERE invitation_vault_keys.vault_id = EXCLUDED.vault_id`,
      [input.invitationId, input.vaultId, input.generation, input.wrappedVk, input.createdBy],
    );
    return true;
  } catch (err) {
    console.error(`[invitation-keys] storing the wrap for invitation ${input.invitationId} failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * B3: after acceptance (Better Auth `afterAcceptInvitation`, and the join-code
 * path with a live invite). Each accepted invitation's direct seal becomes the
 * new member's `vault_key_wraps` row when it was sealed to their CURRENT
 * account key; a seal to an older key is useless to them and is skipped.
 * `ON CONFLICT DO NOTHING`: an existing wrap is never overwritten. Once the
 * invitee holds a current wrap the invitation's key row is spent and deleted
 * (`dropSpentInvitationKeys`); until then its secret wrap stays fetchable.
 * Best-effort: membership is committed already, so a failure is logged and
 * never fails the accept. Returns the number of wraps stored.
 */
export async function applyInvitationKeys(
  input: { invitationIds: readonly string[]; organizationId: string; userId: string },
  db: Queryable = defaultPool,
): Promise<number> {
  if (input.invitationIds.length === 0) return 0;
  try {
    // Inside the try: even a malformed BAALDA_VAULT_KEYS (which throws) can
    // never fail an accept.
    if (!vaultKeysEnabled()) return 0;
    const { rows } = await db.query<{ vault_id: string }>(
      `INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk, sealed_by_user_id)
       SELECT ivk.vault_id, $3, ivk.sealed_generation, ivk.sealed_vk,
              COALESCE(ivk.sealed_by_user_id, i."inviterId")
         FROM invitation_vault_keys ivk
         JOIN invitation i ON i.id = ivk.invitation_id
         JOIN vaults v ON v.id = ivk.vault_id AND v.organization_id = i."organizationId"
         JOIN user_keys k ON k.user_id = $3
        WHERE ivk.invitation_id = ANY($1::text[])
          AND i."organizationId" = $2
          AND ivk.sealed_vk IS NOT NULL
          AND ivk.sealed_for_public_key = k.public_key
       ON CONFLICT (vault_id, user_id, generation) DO NOTHING
       RETURNING vault_id`,
      [[...input.invitationIds], input.organizationId, input.userId],
    );
    if (rows.length) {
      await db.query("DELETE FROM vault_key_requests WHERE user_id = $1 AND vault_id = ANY($2::text[])", [
        input.userId,
        rows.map((r) => r.vault_id),
      ]);
    }
    const { rows: vaults } = await db.query<{ vault_id: string }>(
      "SELECT DISTINCT vault_id FROM invitation_vault_keys WHERE invitation_id = ANY($1::text[])",
      [[...input.invitationIds]],
    );
    for (const v of vaults) await dropSpentInvitationKeys({ vaultId: v.vault_id, userId: input.userId }, db);
    return rows.length;
  } catch (err) {
    console.error(`[invitation-keys] applying invitation keys in ${input.organizationId} failed: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * A fresh wrap at the vault's CURRENT generation for `u`: not one sealed
 * before they last replaced their account key (`keys/mine` never counts those).
 */
const HOLDS_CURRENT_WRAP = `EXISTS (
  SELECT 1 FROM vault_key_wraps w
    JOIN vaults cv ON cv.id = w.vault_id
    LEFT JOIN user_keys k ON k.user_id = w.user_id
   WHERE w.vault_id = ivk.vault_id AND w.user_id = u.id
     AND w.generation = COALESCE(cv.key_generation, 1)
     AND (k.key_changed_at IS NULL OR w.created_at >= k.key_changed_at))`;

/**
 * Lifetime: an invitation's key row (secret wrap and direct seal) exists only
 * to get the key to the invitee. Once they hold a current wrap of their own it
 * is spent, and the secret behind it still sits in an email: delete it. Run
 * after B3's insert and whenever a wrap lands for someone (POST keys/wraps).
 * Returns the rows deleted.
 */
export async function dropSpentInvitationKeys(
  input: { vaultId: string; userId: string },
  db: Queryable = defaultPool,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM invitation_vault_keys ivk
      USING invitation i, vaults v, "user" u
      WHERE ivk.invitation_id = i.id AND ivk.vault_id = $1
        AND v.id = ivk.vault_id AND i."organizationId" = v.organization_id
        AND u.id = $2 AND lower(i.email) = lower(u.email)
        AND ${HOLDS_CURRENT_WRAP}`,
    [input.vaultId, input.userId],
  );
  return rowCount ?? 0;
}

/**
 * Periodic sweep (the invitation sweep tick): key rows whose invitation can no
 * longer deliver anything (cancelled, rejected, expired unaccepted) or whose
 * job is done or void (accepted and the invitee holds a current wrap, or
 * accepted and the invitee is no longer a member). A deleted invitation's row
 * goes by cascade. Returns the rows deleted.
 */
export async function sweepInvitationKeys(db: Queryable = defaultPool): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM invitation_vault_keys ivk
      USING invitation i
      WHERE ivk.invitation_id = i.id
        AND (
          i.status IN ('canceled', 'rejected')
          OR (i.status = 'pending' AND i."expiresAt" <= now())
          OR (i.status = 'accepted' AND NOT EXISTS (
                SELECT 1 FROM member m JOIN "user" mu ON mu.id = m."userId"
                 WHERE m."organizationId" = i."organizationId" AND lower(mu.email) = lower(i.email)))
          OR (i.status = 'accepted' AND EXISTS (
                SELECT 1 FROM "user" u WHERE lower(u.email) = lower(i.email) AND ${HOLDS_CURRENT_WRAP}))
        )`,
  );
  return rowCount ?? 0;
}
