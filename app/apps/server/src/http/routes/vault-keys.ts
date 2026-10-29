// SPDX-License-Identifier: Apache-2.0
//
// Client-held vault keys (W3): key exchange routes. Every route answers 404
// unless BAALDA_VAULT_KEYS is on. The server never sees a plain vault key here:
// it stores `vk_check` and VK sealed to members' public keys BY members'
// devices, and only queues "please seal for me" requests.
//
// POST /api/vaults/:vaultId/keys/init      first member to key the vault
// GET  /api/vaults/:vaultId/keys/mine      my sealed wraps (or 202 pending)
// GET  /api/vaults/:vaultId/keys/requests  pending requests (wrap holders only)
// POST /api/vaults/:vaultId/keys/wraps     seal VK to a member (holder + valid VK)
// GET  /api/me/keys                         my key pair record
// PUT  /api/me/keys                         set my public key + recovery wrap
// PUT  /api/me/devices/:deviceId/key        my private key wrapped for a device
import { Hono } from "hono";
import type pg from "pg";
import { pool } from "../../db/pool.js";
import { vaultKeysEnabled } from "../../crypto/config.js";
import { requireVaultKey } from "../../crypto/transport.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";

type Queryable = Pick<pg.Pool, "query">;

const MAX_BLOB_B64 = 16 * 1024;

function b64(v: unknown): Buffer | null {
  if (typeof v !== "string" || v === "" || v.length > MAX_BLOB_B64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length > 0 ? buf : null;
}

function generationOk(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 0xffff;
}

async function membership(vaultId: string, userId: string, db: Queryable = pool) {
  const orgId = await vaultOrg(vaultId, db);
  if (!orgId) return null;
  const role = await orgRole(orgId, userId, db);
  return role ? { orgId, role } : null;
}

async function holdsWrap(vaultId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    [vaultId, userId],
  );
  return rows.length > 0;
}

export function createVaultKeyRoutes(): Hono {
  const routes = new Hono();

  // Scoped paths only: this router is mounted at /api, and a `*` middleware
  // here would answer for every other /api route too.
  const flagGate = async (c: import("hono").Context, next: () => Promise<void>) => {
    if (!vaultKeysEnabled()) return c.json({ error: "Not found" }, 404);
    await next();
  };
  routes.use("/vaults/:vaultId/keys/*", flagGate);
  routes.use("/me/keys", flagGate);
  routes.use("/me/devices/:deviceId/key", flagGate);

  routes.post("/vaults/:vaultId/keys/init", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const vkCheck = b64(body?.vkCheck);
    const sealedVk = b64(body?.sealedVkForSelf);
    if (!vkCheck || !sealedVk || !generationOk(body?.generation)) {
      return c.json({ error: "vkCheck, generation and sealedVkForSelf are required", code: "invalid_argument" }, 400);
    }
    const generation = body.generation as number;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ vk_check: Buffer | null }>(
        "SELECT vk_check FROM vaults WHERE id = $1 FOR UPDATE",
        [vaultId],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return c.json({ error: "Unknown vault" }, 404);
      }
      if (rows[0].vk_check) {
        await client.query("ROLLBACK");
        return c.json({ error: "This vault already has a key", code: "already_keyed" }, 409);
      }
      await client.query("UPDATE vaults SET vk_check = $2, key_generation = $3 WHERE id = $1", [
        vaultId,
        vkCheck,
        generation,
      ]);
      await client.query(
        `INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk, sealed_by_user_id)
         VALUES ($1, $2, $3, $4, $2)`,
        [vaultId, session.userId, generation, sealedVk],
      );
      await client.query(
        `INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', $2)
         ON CONFLICT (vault_id) DO UPDATE SET phase = 'keyed', generation = $2, updated_at = now()`,
        [vaultId, generation],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return c.json({ keyed: true, generation }, 201);
  });

  routes.get("/vaults/:vaultId/keys/mine", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    if (!(await membership(vaultId, session.userId))) return c.json({ error: "Unknown vault" }, 404);
    const { rows: v } = await pool.query<{ vk_check: Buffer | null; key_generation: number | null }>(
      "SELECT vk_check, key_generation FROM vaults WHERE id = $1",
      [vaultId],
    );
    if (!v[0]?.vk_check) return c.json({ keyed: false });
    const { rows } = await pool.query<{ generation: number; sealed_vk: Buffer; sealed_by_user_id: string | null }>(
      `SELECT generation, sealed_vk, sealed_by_user_id FROM vault_key_wraps
        WHERE vault_id = $1 AND user_id = $2 ORDER BY generation`,
      [vaultId, session.userId],
    );
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO vault_key_requests (vault_id, user_id) VALUES ($1, $2)
         ON CONFLICT (vault_id, user_id) DO NOTHING`,
        [vaultId, session.userId],
      );
      return c.json({ keyed: true, pending: true }, 202);
    }
    return c.json({
      keyed: true,
      generation: v[0].key_generation ?? 1,
      vkCheck: v[0].vk_check.toString("base64"),
      wraps: rows.map((r) => ({
        generation: r.generation,
        sealedVk: r.sealed_vk.toString("base64"),
        sealedByUserId: r.sealed_by_user_id,
      })),
    });
  });

  routes.get("/vaults/:vaultId/keys/requests", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    if (!(await holdsWrap(vaultId, session.userId))) {
      return c.json({ error: "Only a member who holds the key can see requests", code: "key_holder_required" }, 403);
    }
    // Current members only, and only those with a published public key.
    const { rows } = await pool.query<{ user_id: string; requested_at: Date; public_key: Buffer }>(
      `SELECT r.user_id, r.requested_at, k.public_key
         FROM vault_key_requests r
         JOIN member m ON m."organizationId" = $2 AND m."userId" = r.user_id
         JOIN user_keys k ON k.user_id = r.user_id
        WHERE r.vault_id = $1
        ORDER BY r.requested_at`,
      [vaultId, member.orgId],
    );
    return c.json({
      requests: rows.map((r) => ({
        userId: r.user_id,
        requestedAt: r.requested_at,
        publicKey: r.public_key.toString("base64"),
      })),
    });
  });

  routes.post("/vaults/:vaultId/keys/wraps", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    if (!(await holdsWrap(vaultId, session.userId))) {
      return c.json({ error: "Only a member who holds the key can share it", code: "key_holder_required" }, 403);
    }
    // Prove possession of the key itself, not just a wrap row in the database.
    const key = await requireVaultKey(c, vaultId);
    if (!key.ok) return key.response;
    if (!key.keyed) return c.json({ error: "This vault has no key yet", code: "not_keyed" }, 409);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sealedVk = b64(body?.sealedVk);
    const userId = typeof body?.userId === "string" ? body.userId : "";
    if (!userId || !sealedVk || !generationOk(body?.generation)) {
      return c.json({ error: "userId, generation and sealedVk are required", code: "invalid_argument" }, 400);
    }
    if (!(await orgRole(member.orgId, userId))) {
      return c.json({ error: "That person isn't a member of this vault", code: "not_member" }, 404);
    }
    await pool.query(
      `INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk, sealed_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault_id, user_id, generation) DO NOTHING`,
      [vaultId, userId, body.generation, sealedVk, session.userId],
    );
    await pool.query("DELETE FROM vault_key_requests WHERE vault_id = $1 AND user_id = $2", [vaultId, userId]);
    return c.json({ sealed: true }, 201);
  });

  routes.get("/me/keys", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query<{ public_key: Buffer; priv_wrapped_recovery: Buffer | null }>(
      "SELECT public_key, priv_wrapped_recovery FROM user_keys WHERE user_id = $1",
      [session.userId],
    );
    const { rows: devices } = await pool.query<{ device_id: string; priv_wrapped: Buffer }>(
      "SELECT device_id, priv_wrapped FROM user_device_keys WHERE user_id = $1 ORDER BY device_id",
      [session.userId],
    );
    if (!rows[0]) return c.json({ publicKey: null, privWrappedRecovery: null, devices: [] });
    return c.json({
      publicKey: rows[0].public_key.toString("base64"),
      privWrappedRecovery: rows[0].priv_wrapped_recovery?.toString("base64") ?? null,
      devices: devices.map((d) => ({ deviceId: d.device_id, privWrapped: d.priv_wrapped.toString("base64") })),
    });
  });

  routes.put("/me/keys", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const publicKey = b64(body?.publicKey);
    const recovery = body?.privWrappedRecovery == null ? null : b64(body.privWrappedRecovery);
    if (!publicKey || (body?.privWrappedRecovery != null && !recovery)) {
      return c.json({ error: "publicKey is required", code: "invalid_argument" }, 400);
    }
    await pool.query(
      `INSERT INTO user_keys (user_id, public_key, priv_wrapped_recovery) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [session.userId, publicKey, recovery],
    );
    // Never replace key material: wraps sealed to the old public key would be
    // orphaned. Same key again = idempotent success; a different one = 409.
    const { rows: cur } = await pool.query<{ public_key: Buffer }>(
      "SELECT public_key FROM user_keys WHERE user_id = $1",
      [session.userId],
    );
    if (!cur[0]?.public_key.equals(publicKey)) {
      return c.json({ error: "Your account already has keys", code: "keys_exist" }, 409);
    }
    return c.json({ saved: true });
  });

  routes.put("/me/devices/:deviceId/key", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const deviceId = c.req.param("deviceId");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) {
      return c.json({ error: "Invalid device id", code: "invalid_argument" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const privWrapped = b64(body?.privWrapped);
    if (!privWrapped) return c.json({ error: "privWrapped is required", code: "invalid_argument" }, 400);
    await pool.query(
      `INSERT INTO user_device_keys (user_id, device_id, priv_wrapped) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, device_id) DO NOTHING`,
      [session.userId, deviceId, privWrapped],
    );
    const { rows: cur } = await pool.query<{ priv_wrapped: Buffer }>(
      "SELECT priv_wrapped FROM user_device_keys WHERE user_id = $1 AND device_id = $2",
      [session.userId, deviceId],
    );
    if (!cur[0]?.priv_wrapped.equals(privWrapped)) {
      return c.json({ error: "This device already has a key", code: "device_key_exists" }, 409);
    }
    return c.json({ saved: true });
  });

  return routes;
}
