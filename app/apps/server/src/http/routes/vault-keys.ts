// SPDX-License-Identifier: Apache-2.0
//
// Client-held vault keys (W3): key exchange routes. Every route answers 404
// unless BAALDA_VAULT_KEYS is on. The server never sees a plain vault key here:
// it stores `vk_check` and VK sealed to members' public keys BY members'
// devices, and only queues "please seal for me" requests.
//
// POST /api/vaults/:vaultId/keys/init      first member to key the vault
// GET  /api/vaults/:vaultId/keys/mine      my sealed wraps (or 202 pending)
// POST /api/vaults/:vaultId/keys/request-encryption  owner/admin opts an existing vault in (one-way)
// GET  /api/vaults/:vaultId/keys/requests  pending requests (wrap holders only)
// POST /api/vaults/:vaultId/keys/wraps     seal VK to a member (holder + valid VK)
// GET  /api/me/keys                         my key pair record
// PUT  /api/me/keys                         set my public key (recovery wrap optional)
// PUT  /api/me/devices/:deviceId/key        my private key wrapped for a device
import { Hono } from "hono";
import type pg from "pg";
import { pool } from "../../db/pool.js";
import { vaultKeysEnabled } from "../../crypto/config.js";
import { VK_HEADER, decodeVk, requireVaultKey } from "../../crypto/transport.js";
import { vaultKeyCache } from "../../crypto/key-cache.js";
import { verifyVk } from "../../crypto/vk-check.js";
import { encryptionProgress } from "../../crypto/null-out.js";
import { ENCRYPTION_NOT_REQUESTED, initGate, lockGateRows } from "../../crypto/conversion.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_PARAM, clientVersionPolicy, judgeClientVersion } from "../client-version.js";

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

/** Pending (unapproved) device registrations allowed per user. */
export const MAX_PENDING_DEVICES = 5;

/**
 * Rollout gate for turning a vault's keys on: env VAULT_KEY_CONVERSION on, and
 * the caller's desktop at or above the MIN_CLIENT_VERSION floor (no grace, a
 * version is required). Default off.
 */
export function conversionAllowed(versionHeader: string | null | undefined): boolean {
  const flag = (process.env.VAULT_KEY_CONVERSION ?? "").trim().toLowerCase();
  if (!["1", "true", "on", "yes"].includes(flag)) return false;
  const policy = clientVersionPolicy();
  return judgeClientVersion(versionHeader, { ...policy, allowUnversioned: false, graceUntil: 0 }).ok;
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
  routes.use("/me/devices", flagGate);
  routes.use("/me/devices/*", flagGate);

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
      const { rows } = await client.query<{ vk_check: Buffer | null; encryption_requested_at: Date | null }>(
        "SELECT vk_check, encryption_requested_at FROM vaults WHERE id = $1 FOR UPDATE",
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
      // Opt-in (migration 081): never key a vault nobody asked to encrypt,
      // whatever the client. Read under the vault row lock.
      if (!rows[0].encryption_requested_at) {
        await client.query("ROLLBACK");
        return c.json(ENCRYPTION_NOT_REQUESTED, 409);
      }
      // MCP/links conversion gate (crypto/conversion.ts): no active token,
      // link or OAuth grant may be cut off by keying the vault. It runs INSIDE
      // this transaction, under the vault row lock plus locks on the pending
      // row, the org's tokens and the vault's links, so a token used (or a
      // pending key replaced) between the check and the write cannot slip
      // through: such a write waits for this commit and then sees a keyed vault.
      await lockGateRows(client, vaultId);
      const gated = await initGate(vaultId, vkCheck, generation, client);
      if (gated) {
        await client.query("ROLLBACK");
        return c.json(gated, 409);
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
      await client.query("DELETE FROM vault_pending_keys WHERE vault_id = $1", [vaultId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // The converting device presents the key it just set: warm the cache so
    // notes written around the conversion (queued in index_pending while the
    // key lived only in the pending cache) are drained now, not when a vault
    // channel next connects. Verified against the check this request stored.
    const vk = (c.get("presentedVk" as never) as Buffer | undefined) ?? decodeVk(c.req.header(VK_HEADER));
    if (vk && verifyVk(vk, vaultId, vkCheck)) vaultKeyCache.holdForRequest(vaultId, vk, generation);
    return c.json({ keyed: true, generation }, 201);
  });

  routes.get("/vaults/:vaultId/keys/mine", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    if (!(await membership(vaultId, session.userId))) return c.json({ error: "Unknown vault" }, 404);
    const { rows: v } = await pool.query<{
      vk_check: Buffer | null;
      key_generation: number | null;
      encryption_requested_at: Date | null;
    }>(
      "SELECT vk_check, key_generation, encryption_requested_at FROM vaults WHERE id = $1",
      [vaultId],
    );
    if (!v[0]?.vk_check) {
      // Opt-in: an existing vault is keyed only after an owner/admin asked
      // for it (or it was created with vault keys on). Until then a desktop
      // must not key it, whatever the rollout gate says.
      const encryptionRequested = v[0]?.encryption_requested_at != null;
      const gate = conversionAllowed(c.req.header(CLIENT_VERSION_HEADER) ?? c.req.query(CLIENT_VERSION_PARAM));
      return c.json({ keyed: false, conversionAllowed: gate && encryptionRequested, encryptionRequested });
    }
    // Wraps sealed before the caller last replaced their account key cannot be
    // opened by them any more; they are kept (never deleted) but do not count.
    const { rows } = await pool.query<{ generation: number; sealed_vk: Buffer; sealed_by_user_id: string | null }>(
      `SELECT w.generation, w.sealed_vk, w.sealed_by_user_id
         FROM vault_key_wraps w
         LEFT JOIN user_keys k ON k.user_id = w.user_id
        WHERE w.vault_id = $1 AND w.user_id = $2
          AND (k.key_changed_at IS NULL OR w.created_at >= k.key_changed_at)
        ORDER BY w.generation`,
      [vaultId, session.userId],
    );
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO vault_key_requests (vault_id, user_id) VALUES ($1, $2)
         ON CONFLICT (vault_id, user_id) DO NOTHING`,
        [vaultId, session.userId],
      );
      return c.json(
        {
          keyed: true,
          pending: true,
          generation: v[0].key_generation ?? 1,
          vkCheck: v[0].vk_check.toString("base64"),
        },
        202,
      );
    }
    // Conversion progress for the UI, as last recorded by the background
    // worker (never counted per request).
    const progress = await encryptionProgress(vaultId);
    return c.json({
      keyed: true,
      generation: v[0].key_generation ?? 1,
      vkCheck: v[0].vk_check.toString("base64"),
      fullyEncrypted: progress.fullyEncrypted,
      plaintextRemaining: progress.plaintextRemaining,
      wraps: rows.map((r) => ({
        generation: r.generation,
        sealedVk: r.sealed_vk.toString("base64"),
        sealedByUserId: r.sealed_by_user_id,
      })),
    });
  });

  // "Encrypt this vault": an owner/admin opts an existing vault in. One-way and
  // idempotent: the first call records who and when (and one access_audit
  // row); later calls change nothing. There is deliberately no undo route.
  // This only records the decision; a member's desktop does the keying once
  // the rollout gate (conversionAllowed) also opens.
  routes.post("/vaults/:vaultId/keys/request-encryption", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    if (member.role !== "owner" && member.role !== "admin") {
      return c.json({ error: "Only an owner or admin can encrypt this vault", code: "access_manager_required" }, 403);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ encryption_requested_at: Date | null; encryption_requested_by: string | null }>(
        "SELECT encryption_requested_at, encryption_requested_by FROM vaults WHERE id = $1 FOR UPDATE",
        [vaultId],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return c.json({ error: "Unknown vault" }, 404);
      }
      if (rows[0].encryption_requested_at) {
        await client.query("ROLLBACK");
        return c.json({
          encryptionRequested: true,
          requestedAt: rows[0].encryption_requested_at,
          requestedBy: rows[0].encryption_requested_by,
        });
      }
      const { rows: done } = await client.query<{ encryption_requested_at: Date }>(
        `UPDATE vaults SET encryption_requested_at = now(), encryption_requested_by = $2
          WHERE id = $1 RETURNING encryption_requested_at`,
        [vaultId, session.userId],
      );
      await client.query(
        `INSERT INTO access_audit (organization_id, actor_user_id, actor_name, entity_type, entity_id, action, before_state, after_state)
         VALUES ($1, $2, (SELECT name FROM "user" WHERE id = $2), 'vault', $3, 'encryption_requested', $4::jsonb, $5::jsonb)`,
        [
          member.orgId,
          session.userId,
          vaultId,
          JSON.stringify({ encryptionRequested: false }),
          JSON.stringify({ encryptionRequested: true }),
        ],
      );
      await client.query("COMMIT");
      return c.json({ encryptionRequested: true, requestedAt: done[0].encryption_requested_at, requestedBy: session.userId }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
    const { rows } = await pool.query<{ user_id: string; requested_at: Date; public_key: Buffer; key_changed_at: Date | null }>(
      `SELECT r.user_id, r.requested_at, k.public_key, k.key_changed_at
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
        // Set when the person replaced their account key (lost all devices):
        // teammates' devices show "security key changed" before sealing.
        keyChangedAt: r.key_changed_at,
      })),
    });
  });

  routes.post("/vaults/:vaultId/keys/wraps", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sealedVk = b64(body?.sealedVk);
    const userId = typeof body?.userId === "string" ? body.userId : "";
    if (!userId || !sealedVk || !generationOk(body?.generation)) {
      return c.json({ error: "userId, generation and sealedVk are required", code: "invalid_argument" }, 400);
    }
    // A self-wrap (restore with the vault key) needs only the key itself; any
    // other wrap also needs the caller to be an existing key holder.
    const selfWrap = userId === session.userId;
    if (!selfWrap && !(await holdsWrap(vaultId, session.userId))) {
      return c.json({ error: "Only a member who holds the key can share it", code: "key_holder_required" }, 403);
    }
    // Prove possession of the key itself, not just a wrap row in the database.
    const key = await requireVaultKey(c, vaultId);
    if (!key.ok) return key.response;
    if (!key.keyed) return c.json({ error: "This vault has no key yet", code: "not_keyed" }, 409);
    if (!(await orgRole(member.orgId, userId))) {
      return c.json({ error: "That person isn't a member of this vault", code: "not_member" }, 404);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A wrap sealed before the target's current account key is unusable to
      // them: move it to history (never deleted), then store the new one. A
      // current wrap is never overwritten.
      await client.query(
        `WITH stale AS (
           DELETE FROM vault_key_wraps w
            USING user_keys k
            WHERE w.vault_id = $1 AND w.user_id = $2 AND w.generation = $3
              AND k.user_id = w.user_id AND k.key_changed_at IS NOT NULL
              AND w.created_at < k.key_changed_at
           RETURNING w.*
         )
         INSERT INTO vault_key_wrap_history (vault_id, user_id, generation, sealed_vk, sealed_by_user_id, created_at)
         SELECT vault_id, user_id, generation, sealed_vk, sealed_by_user_id, created_at FROM stale`,
        [vaultId, userId, body.generation],
      );
      await client.query(
        `INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk, sealed_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault_id, user_id, generation) DO NOTHING`,
        [vaultId, userId, body.generation, sealedVk, session.userId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    await pool.query("DELETE FROM vault_key_requests WHERE vault_id = $1 AND user_id = $2", [vaultId, userId]);
    return c.json({ sealed: true }, 201);
  });

  routes.get("/me/keys", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query<{ public_key: Buffer; priv_wrapped_recovery: Buffer | null; key_changed_at: Date | null }>(
      "SELECT public_key, priv_wrapped_recovery, key_changed_at FROM user_keys WHERE user_id = $1",
      [session.userId],
    );
    const { rows: devices } = await pool.query<{ device_id: string; priv_wrapped: Buffer }>(
      "SELECT device_id, priv_wrapped FROM user_device_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY device_id",
      [session.userId],
    );
    if (!rows[0]) return c.json({ publicKey: null, privWrappedRecovery: null, keyChangedAt: null, devices: [] });
    return c.json({
      keyChangedAt: rows[0].key_changed_at,
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
    // Same key again = idempotent. A different key (lost every device) is a
    // REPLACEMENT: the previous key moves to `user_key_history` (never
    // deleted), `key_changed_at` tells teammates, and their devices re-seal.
    const client = await pool.connect();
    let replaced = false;
    try {
      await client.query("BEGIN");
      const { rows: cur } = await client.query<{ public_key: Buffer; priv_wrapped_recovery: Buffer | null; created_at: Date }>(
        "SELECT public_key, priv_wrapped_recovery, created_at FROM user_keys WHERE user_id = $1 FOR UPDATE",
        [session.userId],
      );
      if (!cur[0]) {
        await client.query(
          "INSERT INTO user_keys (user_id, public_key, priv_wrapped_recovery) VALUES ($1, $2, $3)",
          [session.userId, publicKey, recovery],
        );
      } else if (!cur[0].public_key.equals(publicKey)) {
        await client.query(
          `INSERT INTO user_key_history (user_id, public_key, priv_wrapped_recovery, created_at)
           VALUES ($1, $2, $3, $4)`,
          [session.userId, cur[0].public_key, cur[0].priv_wrapped_recovery, cur[0].created_at],
        );
        await client.query(
          `UPDATE user_keys SET public_key = $2, priv_wrapped_recovery = $3, created_at = now(), key_changed_at = now()
            WHERE user_id = $1`,
          [session.userId, publicKey, recovery],
        );
        replaced = true;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return c.json({ saved: true, replaced });
  });

  const deviceIdOk = (d: string) => /^[A-Za-z0-9._-]{1,128}$/.test(d);

  // A new device asks to join the caller's account (idempotent, capped).
  routes.post("/me/devices", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    const publicKey = b64(body?.publicKey);
    const name = typeof body?.name === "string" ? body.name.slice(0, 120) : null;
    if (!deviceIdOk(deviceId) || !publicKey) {
      return c.json({ error: "deviceId and publicKey are required", code: "invalid_argument" }, 400);
    }
    const { rows: existing } = await pool.query<{ public_key: Buffer }>(
      "SELECT public_key FROM user_device_registrations WHERE user_id = $1 AND device_id = $2",
      [session.userId, deviceId],
    );
    if (existing[0]) {
      if (!existing[0].public_key.equals(publicKey)) {
        return c.json({ error: "This device is already registered with another key", code: "device_exists" }, 409);
      }
      return c.json({ registered: true });
    }
    const { rows: pending } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_device_registrations r
        WHERE r.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM user_device_keys k WHERE k.user_id = r.user_id AND k.device_id = r.device_id)`,
      [session.userId],
    );
    if ((pending[0]?.n ?? 0) >= MAX_PENDING_DEVICES) {
      return c.json({ error: "Too many devices waiting for approval", code: "too_many_pending" }, 429);
    }
    await pool.query(
      `INSERT INTO user_device_registrations (user_id, device_id, public_key, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, device_id) DO NOTHING`,
      [session.userId, deviceId, publicKey, name],
    );
    return c.json({ registered: true }, 201);
  });

  // The caller's own devices still waiting for approval.
  routes.get("/me/devices/pending", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query<{ device_id: string; public_key: Buffer; requested_at: Date; name: string | null }>(
      `SELECT r.device_id, r.public_key, r.requested_at, r.name FROM user_device_registrations r
        WHERE r.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM user_device_keys k WHERE k.user_id = r.user_id AND k.device_id = r.device_id)
        ORDER BY r.requested_at`,
      [session.userId],
    );
    return c.json({
      devices: rows.map((r) => ({
        deviceId: r.device_id,
        publicKey: r.public_key.toString("base64"),
        requestedAt: r.requested_at,
        name: r.name,
      })),
    });
  });

  // Approve: the account private key wrapped for one of the caller's OWN
  // registered devices. Never overwrites an existing wrap.
  routes.put("/me/devices/:deviceId/key", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const deviceId = c.req.param("deviceId");
    if (!deviceIdOk(deviceId)) return c.json({ error: "Invalid device id", code: "invalid_argument" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const privWrapped = b64(body?.privWrapped);
    if (!privWrapped) return c.json({ error: "privWrapped is required", code: "invalid_argument" }, 400);
    const { rows: reg } = await pool.query(
      "SELECT 1 FROM user_device_registrations WHERE user_id = $1 AND device_id = $2",
      [session.userId, deviceId],
    );
    if (!reg[0]) return c.json({ error: "No such device waiting for approval", code: "unknown_device" }, 404);
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

  // The approved wrap for this device: 404 until approved (or once revoked).
  routes.get("/me/devices/:deviceId/key", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const deviceId = c.req.param("deviceId");
    const { rows } = await pool.query<{ priv_wrapped: Buffer }>(
      "SELECT priv_wrapped FROM user_device_keys WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
      [session.userId, deviceId],
    );
    if (!rows[0]) return c.json({ error: "Not approved yet", code: "not_approved" }, 404);
    return c.json({ privWrapped: rows[0].priv_wrapped.toString("base64") });
  });

  // Deny a pending device or remove an approved one. The registration goes;
  // an approved device's wrap is marked revoked, never deleted.
  routes.delete("/me/devices/:deviceId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const deviceId = c.req.param("deviceId");
    await pool.query(
      "UPDATE user_device_keys SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
      [session.userId, deviceId],
    );
    await pool.query("DELETE FROM user_device_registrations WHERE user_id = $1 AND device_id = $2", [
      session.userId,
      deviceId,
    ]);
    return c.json({ removed: true });
  });

  return routes;
}
