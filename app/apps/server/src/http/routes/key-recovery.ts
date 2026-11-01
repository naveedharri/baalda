// SPDX-License-Identifier: Apache-2.0
//
// The launch safety net's rescue routes (crypto/key-recovery.ts). Used only by
// `scripts/key-recovery.ts` on the owner's computer, which holds the offline
// private key:
//
//   GET  /api/admin/key-recovery/:vaultId        sealed copies + the org's members' account keys
//   POST /api/admin/key-recovery/:vaultId/grant  store a wrap the script sealed to one member
//
// Both answer 404 unless KEY_RECOVERY_PUBLIC_KEY is set AND the request carries
// `X-Baalda-Recovery-Admin` equal to KEY_RECOVERY_ADMIN_TOKEN. The grant also
// needs the vault key itself in `X-Baalda-VK` (checked against `vk_check`), so
// the admin token alone writes nothing: only someone who opened a copy with
// the offline key, or a member who already holds the key, can grant.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { pool } from "../../db/pool.js";
import { vaultKeysEnabled } from "../../crypto/config.js";
import { recoveryPublicKey } from "../../crypto/key-recovery.js";
import { VK_HEADER, decodeVk, loadVkCheck } from "../../crypto/transport.js";
import { verifyVk } from "../../crypto/vk-check.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";

export const RECOVERY_ADMIN_HEADER = "x-baalda-recovery-admin";

function adminAllowed(c: Context): boolean {
  if (!vaultKeysEnabled() || !recoveryPublicKey()) return false;
  const expected = (process.env.KEY_RECOVERY_ADMIN_TOKEN ?? "").trim();
  const given = c.req.header(RECOVERY_ADMIN_HEADER) ?? "";
  if (expected.length < 32 || !given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);

function b64(v: unknown): Buffer | null {
  if (typeof v !== "string" || v === "" || v.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length > 0 ? buf : null;
}

export function createKeyRecoveryRoutes(): Hono {
  const routes = new Hono();

  routes.get("/admin/key-recovery/:vaultId", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    const vaultId = c.req.param("vaultId");
    const orgId = await vaultOrg(vaultId, pool);
    if (!orgId) return notFound(c);
    const state = await loadVkCheck(vaultId, pool);
    const { rows: copies } = await pool.query<{ generation: number; recovery_key_fp: string; sealed_vk: Buffer }>(
      `SELECT generation, recovery_key_fp, sealed_vk FROM vault_key_recovery
        WHERE vault_id = $1 ORDER BY generation DESC, created_at DESC`,
      [vaultId],
    );
    const { rows: members } = await pool.query<{
      user_id: string;
      email: string;
      name: string | null;
      role: string;
      public_key: Buffer | null;
    }>(
      `SELECT m."userId" AS user_id, u.email, u.name, m.role, k.public_key
         FROM member m JOIN "user" u ON u.id = m."userId"
         LEFT JOIN user_keys k ON k.user_id = m."userId"
        WHERE m."organizationId" = $1 ORDER BY m."createdAt"`,
      [orgId],
    );
    return c.json({
      vaultId,
      organizationId: orgId,
      keyed: !!state && state.vkCheck.length > 0,
      generation: state?.generation ?? null,
      copies: copies.map((r) => ({
        generation: r.generation,
        recoveryKeyFp: r.recovery_key_fp,
        sealedVk: r.sealed_vk.toString("base64"),
      })),
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        publicKey: m.public_key?.toString("base64") ?? null,
      })),
    });
  });

  routes.post("/admin/key-recovery/:vaultId/grant", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    const vaultId = c.req.param("vaultId");
    const orgId = await vaultOrg(vaultId, pool);
    if (!orgId) return notFound(c);
    const state = await loadVkCheck(vaultId, pool);
    const vk = decodeVk(c.req.header(VK_HEADER));
    if (!state || !vk || !verifyVk(vk, vaultId, state.vkCheck)) {
      vk?.fill(0);
      return c.json({ error: "The vault key does not match this vault", code: "key_required" }, 409);
    }
    vk.fill(0);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const userId = typeof body?.userId === "string" ? body.userId : "";
    const sealedVk = b64(body?.sealedVk);
    if (!userId || !sealedVk || body?.generation !== state.generation) {
      return c.json(
        { error: "userId, sealedVk and the vault's current generation are required", code: "invalid_argument" },
        400,
      );
    }
    if (!(await orgRole(orgId, userId, pool))) {
      return c.json({ error: "That person isn't a member of this vault", code: "not_member" }, 404);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Their old wrap (sealed to a lost account key) goes to history, never deleted.
      await client.query(
        `WITH old AS (
           DELETE FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2 AND generation = $3 RETURNING *
         )
         INSERT INTO vault_key_wrap_history (vault_id, user_id, generation, sealed_vk, sealed_by_user_id, created_at)
         SELECT vault_id, user_id, generation, sealed_vk, sealed_by_user_id, created_at FROM old`,
        [vaultId, userId, state.generation],
      );
      await client.query(
        `INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk, sealed_by_user_id)
         VALUES ($1, $2, $3, $4, NULL)`,
        [vaultId, userId, state.generation, sealedVk],
      );
      await client.query("DELETE FROM vault_key_requests WHERE vault_id = $1 AND user_id = $2", [vaultId, userId]);
      await client.query(
        `INSERT INTO access_audit (organization_id, actor_user_id, actor_name, entity_type, entity_id, action, before_state, after_state)
         VALUES ($1, NULL, 'Baalda key recovery', 'vault', $2, 'key_recovered', NULL, $3::jsonb)`,
        [orgId, vaultId, JSON.stringify({ userId, generation: state.generation })],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log(`[key-recovery] granted vault ${vaultId} generation ${state.generation} to user ${userId}`);
    return c.json({ granted: true }, 201);
  });

  return routes;
}
