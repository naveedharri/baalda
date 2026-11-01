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
// PUT  /api/vaults/:vaultId/keys/invite-wraps/:invitationId  seal VK to an invitee (owner/admin + VK)
// GET  /api/vaults/:vaultId/keys/invite-wrap                 my invitations' secret wraps
// PUT  /api/vaults/:vaultId/keys/join-wraps                  VK wrapped under a join secret (owner/admin + VK)
// GET  /api/vaults/:vaultId/keys/join-wrap?h=                one join-secret wrap (member)
// POST /api/me/keys/unlock                  password → unlock key (F; ACCOUNT_KEY_PEPPER)
// PUT  /api/me/keys/password-wrap           account key wrapped under the unlock key (F)
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
import {
  ENCRYPTION_NOT_REQUESTED,
  conversionFlagOn,
  KEY_MATERIAL_EXISTS,
  initGate,
  lockGateRows,
  vaultHasKeyMaterial,
} from "../../crypto/conversion.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import {
  PASSWORD_UNLOCK_OFF,
  accountKeyPepper,
  deriveUnlockKey,
  upgradeLoginHash,
  verifyPassword,
} from "../../auth/login-pepper.js";
import {
  clearThrottle,
  lockedForSeconds,
  recordFailure,
  throttledResponse,
  withPasswordSlot,
} from "../../auth/signin-throttle.js";
import {
  KEY_REPLACEMENT_WINDOW_MS,
  MAX_KEY_REPLACEMENTS,
  RATE_LIMITED,
  plainWait,
  takeKeyChurn,
} from "../../crypto/key-churn.js";
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_PARAM, clientVersionPolicy, judgeClientVersion } from "../client-version.js";
import { dropSpentInvitationKeys } from "../../members/invitation-keys.js";

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

/** 403 body: keying (or converting) a vault is for owners and admins. */
export const KEYING_REQUIRES_ADMIN = {
  error: "Only an owner or admin can encrypt this vault",
  code: "keying_requires_admin",
} as const;

/**
 * Who may key a vault: an owner/admin, or the person who created it (POST
 * /api/vaults stamps `encryption_requested_by`; only owners/admins create
 * vaults, so this matters only if they were demoted since).
 */
export function mayKeyVault(role: string | null | undefined, userId: string, createdBy: string | null): boolean {
  return role === "owner" || role === "admin" || (createdBy !== null && createdBy === userId);
}

async function holdsWrap(vaultId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    [vaultId, userId],
  );
  return rows.length > 0;
}

/** Rows `keys/requests` answers at most (requests + missing members). */
export const MAX_KEY_REQUESTS_LISTED = 200;

/** Join-code secret wraps kept per vault (oldest dropped). */
export const MAX_JOIN_WRAPS = 20;
const SECRET_HASH_RE = /^[0-9a-f]{64}$/;

/** Pending (unapproved) device registrations allowed per user. */
export const MAX_PENDING_DEVICES = 5;

/**
 * Rollout gate for turning a vault's keys on: env VAULT_KEY_CONVERSION on, and
 * the caller's desktop at or above the MIN_CLIENT_VERSION floor (no grace, a
 * version is required). Default off.
 */
export function conversionAllowed(versionHeader: string | null | undefined): boolean {
  if (!conversionFlagOn()) return false;
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
  routes.use("/me/keys/*", flagGate);
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
      const { rows } = await client.query<{
        vk_check: Buffer | null;
        encryption_requested_at: Date | null;
        encryption_requested_by: string | null;
      }>(
        "SELECT vk_check, encryption_requested_at, encryption_requested_by FROM vaults WHERE id = $1 FOR UPDATE",
        [vaultId],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return c.json({ error: "Unknown vault" }, 404);
      }
      // Only an owner/admin (or the person who created this vault) may key it:
      // whoever keys it is its only key holder until they share it, so a plain
      // member keying the team's vault would lock everyone else out.
      if (!mayKeyVault(member.role, session.userId, rows[0].encryption_requested_by)) {
        await client.query("ROLLBACK");
        return c.json(KEYING_REQUIRES_ADMIN, 403);
      }
      if (rows[0].vk_check) {
        await client.query("ROLLBACK");
        return c.json({ error: "This vault already has a key", code: "already_keyed" }, 409);
      }
      // Never key a vault nobody asked to encrypt, whatever the client. While
      // conversion is on every vault counts as asked (`encryptionRequested`).
      // Read under the vault row lock.
      if (!rows[0].encryption_requested_at && !conversionFlagOn()) {
        await client.query("ROLLBACK");
        return c.json(ENCRYPTION_NOT_REQUESTED, 409);
      }
      // A NULL vk_check beside sealed rows or key material is a wiped check:
      // a new key would make every sealed row unreadable. Never re-key.
      if (await vaultHasKeyMaterial(vaultId, client)) {
        await client.query("ROLLBACK");
        return c.json(KEY_MATERIAL_EXISTS, 409);
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
      // Every vault counts as asked while conversion is on; otherwise only one
      // an owner/admin asked for (or created with vault keys on).
      const encryptionRequested = v[0]?.encryption_requested_at != null || conversionFlagOn();
      const gate = conversionAllowed(c.req.header(CLIENT_VERSION_HEADER) ?? c.req.query(CLIENT_VERSION_PARAM));
      // Teammates who would receive the key at conversion: the desktop converts
      // only when a lost laptop would still be recoverable (a count, never ids).
      const { rows: others } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM member m JOIN user_keys k ON k.user_id = m."userId"
          WHERE m."organizationId" = (SELECT organization_id FROM vaults WHERE id = $1) AND m."userId" <> $2`,
        [vaultId, session.userId],
      );
      return c.json({
        keyed: false,
        conversionAllowed: gate && encryptionRequested,
        encryptionRequested,
        otherMembersWithKeys: others[0]?.n ?? 0,
      });
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
    // `request`: the person asked (keys/mine). `missing`: a current member with
    // an account key and no wrap for the vault's current generation who never
    // asked (e.g. their app was never opened on this vault) — sealed the same
    // way, so the key is waiting for them when they arrive.
    const { rows } = await pool.query<{
      user_id: string;
      requested_at: Date;
      public_key: Buffer;
      key_changed_at: Date | null;
      kind: "request" | "missing";
    }>(
      `SELECT * FROM (
         SELECT r.user_id, r.requested_at, k.public_key, k.key_changed_at, 'request' AS kind
           FROM vault_key_requests r
           JOIN member m ON m."organizationId" = $2 AND m."userId" = r.user_id
           JOIN user_keys k ON k.user_id = r.user_id
          WHERE r.vault_id = $1
         UNION ALL
         SELECT m."userId", m."createdAt", k.public_key, k.key_changed_at, 'missing'
           FROM member m
           JOIN user_keys k ON k.user_id = m."userId"
          WHERE m."organizationId" = $2
            AND NOT EXISTS (
              SELECT 1 FROM vault_key_wraps w
               WHERE w.vault_id = $1 AND w.user_id = m."userId"
                 AND w.generation = (SELECT COALESCE(key_generation, 1) FROM vaults WHERE id = $1))
            AND NOT EXISTS (
              SELECT 1 FROM vault_key_requests r WHERE r.vault_id = $1 AND r.user_id = m."userId")
       ) q
       ORDER BY requested_at, user_id
       LIMIT ${MAX_KEY_REQUESTS_LISTED}`,
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
        kind: r.kind,
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
    // Their invitation's secret wrap / seal is spent once they hold a current
    // wrap (the self-wrap after adopting it, or a teammate's seal).
    await dropSpentInvitationKeys({ vaultId, userId }).catch((err: unknown) =>
      console.error(`[vault-keys] dropping spent invitation keys failed: ${(err as Error).message}`),
    );
    return c.json({ sealed: true }, 201);
  });

  // ── Seamless keys (B2): seal VK straight to an invitee's existing account
  // key, applied on acceptance (`members/invitation-keys.ts`). Owner/admin who
  // proves the key. Upsert on the invitation id.
  routes.put("/vaults/:vaultId/keys/invite-wraps/:invitationId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const invitationId = c.req.param("invitationId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    if (member.role !== "owner" && member.role !== "admin") {
      return c.json({ error: "Only an owner or admin can do this", code: "access_manager_required" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sealedVk = b64(body?.sealedVk);
    const publicKey = b64(body?.publicKey);
    if (!sealedVk || !publicKey || !generationOk(body?.generation)) {
      return c.json({ error: "sealedVk, publicKey and generation are required", code: "invalid_argument" }, 400);
    }
    const key = await requireVaultKey(c, vaultId);
    if (!key.ok) return key.response;
    if (!key.keyed) return c.json({ error: "This vault has no key yet", code: "not_keyed" }, 409);
    const { rows: inv } = await pool.query(
      `SELECT 1 FROM invitation
        WHERE id = $1 AND "organizationId" = $2 AND status = 'pending' AND "expiresAt" > now()`,
      [invitationId, member.orgId],
    );
    if (!inv[0]) return c.json({ error: "No such pending invitation", code: "not_found" }, 404);
    const { rowCount } = await pool.query(
      `INSERT INTO invitation_vault_keys
         (invitation_id, vault_id, sealed_vk, sealed_for_public_key, sealed_generation, sealed_by_user_id, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (invitation_id) DO UPDATE
         SET sealed_vk = EXCLUDED.sealed_vk, sealed_for_public_key = EXCLUDED.sealed_for_public_key,
             sealed_generation = EXCLUDED.sealed_generation, sealed_by_user_id = EXCLUDED.sealed_by_user_id,
             sealed_at = now()
       WHERE invitation_vault_keys.vault_id = EXCLUDED.vault_id`,
      [invitationId, vaultId, sealedVk, publicKey, body!.generation, session.userId],
    );
    if (!rowCount) return c.json({ error: "No such pending invitation", code: "not_found" }, 404);
    return c.json({ stored: true }, 201);
  });

  // ── Seamless keys (B4): the caller's own invitations' secret wraps for this
  // vault. Opened on the device with the secret from the email link's fragment.
  routes.get("/vaults/:vaultId/keys/invite-wrap", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    const { rows } = await pool.query<{ invitation_id: string; generation: number; wrapped_vk: Buffer }>(
      `SELECT ivk.invitation_id, ivk.generation, ivk.wrapped_vk
         FROM invitation_vault_keys ivk
         JOIN invitation i ON i.id = ivk.invitation_id
        WHERE ivk.vault_id = $1 AND i."organizationId" = $2
          AND lower(i.email) = lower($3)
          AND i.status IN ('pending', 'accepted')
          AND ivk.wrapped_vk IS NOT NULL
        ORDER BY i."createdAt" DESC
        LIMIT 20`,
      [vaultId, member.orgId, session.email],
    );
    return c.json({
      wraps: rows.map((r) => ({
        invitationId: r.invitation_id,
        generation: r.generation,
        wrappedVk: r.wrapped_vk.toString("base64"),
      })),
    });
  });

  // ── Seamless keys (C): VK wrapped under a join code's device secret J,
  // uploaded by an owner/admin device that proves the key. Only sha256(J).
  routes.put("/vaults/:vaultId/keys/join-wraps", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    if (member.role !== "owner" && member.role !== "admin") {
      return c.json({ error: "Only an owner or admin can do this", code: "access_manager_required" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const secretHash = typeof body?.secretHash === "string" ? body.secretHash.toLowerCase() : "";
    const wrappedVk = b64(body?.wrappedVk);
    const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!SECRET_HASH_RE.test(secretHash) || !wrappedVk || !code || !generationOk(body?.generation)) {
      return c.json({ error: "secretHash, wrappedVk, generation and code are required", code: "invalid_argument" }, 400);
    }
    const key = await requireVaultKey(c, vaultId);
    if (!key.ok) return key.response;
    if (!key.keyed) return c.json({ error: "This vault has no key yet", code: "not_keyed" }, 409);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Under a share lock on the code row, so a regeneration racing this
      // upload either waits (and its trigger then deletes this row) or wins
      // (and this sees the new code: stale).
      const { rows: cur } = await client.query<{ code: string }>(
        "SELECT code FROM org_join_codes WHERE organization_id = $1 FOR SHARE",
        [member.orgId],
      );
      if (cur[0]?.code !== code) {
        await client.query("ROLLBACK");
        return c.json({ error: "This join code is no longer current", code: "stale_code" }, 409);
      }
      await client.query(
        `INSERT INTO vault_join_wraps (vault_id, secret_hash, code, generation, wrapped_vk, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vault_id, secret_hash) DO UPDATE
           SET code = EXCLUDED.code, generation = EXCLUDED.generation, wrapped_vk = EXCLUDED.wrapped_vk,
               created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()`,
        [vaultId, secretHash, code, body!.generation, wrappedVk, session.userId],
      );
      await client.query(
        `DELETE FROM vault_join_wraps WHERE vault_id = $1 AND secret_hash IN (
           SELECT secret_hash FROM vault_join_wraps WHERE vault_id = $1
            ORDER BY created_at DESC, secret_hash OFFSET ${MAX_JOIN_WRAPS})`,
        [vaultId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return c.json({ stored: true }, 201);
  });

  routes.get("/vaults/:vaultId/keys/join-wrap", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const member = await membership(vaultId, session.userId);
    if (!member) return c.json({ error: "Unknown vault" }, 404);
    const h = (c.req.query("h") ?? "").toLowerCase();
    if (!SECRET_HASH_RE.test(h)) return c.json({ error: "h is required", code: "invalid_argument" }, 400);
    // Only a wrap for the org's CURRENT code answers.
    const { rows } = await pool.query<{ generation: number; wrapped_vk: Buffer }>(
      `SELECT w.generation, w.wrapped_vk
         FROM vault_join_wraps w
         JOIN org_join_codes j ON j.organization_id = $2 AND j.code = w.code
        WHERE w.vault_id = $1 AND w.secret_hash = $3`,
      [vaultId, member.orgId, h],
    );
    return c.json({
      wrap: rows[0] ? { generation: rows[0].generation, wrappedVk: rows[0].wrapped_vk.toString("base64") } : null,
    });
  });

  routes.get("/me/keys", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query<{
      public_key: Buffer;
      priv_wrapped_recovery: Buffer | null;
      priv_wrapped_password: Buffer | null;
      key_changed_at: Date | null;
    }>(
      "SELECT public_key, priv_wrapped_recovery, priv_wrapped_password, key_changed_at FROM user_keys WHERE user_id = $1",
      [session.userId],
    );
    const { rows: devices } = await pool.query<{ device_id: string; priv_wrapped: Buffer }>(
      "SELECT device_id, priv_wrapped FROM user_device_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY device_id",
      [session.userId],
    );
    if (!rows[0]) {
      return c.json({ publicKey: null, privWrappedRecovery: null, privWrappedPassword: null, keyChangedAt: null, devices: [] });
    }
    return c.json({
      keyChangedAt: rows[0].key_changed_at,
      publicKey: rows[0].public_key.toString("base64"),
      privWrappedRecovery: rows[0].priv_wrapped_recovery?.toString("base64") ?? null,
      privWrappedPassword: rows[0].priv_wrapped_password?.toString("base64") ?? null,
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
    let refusedFor = 0;
    try {
      await client.query("BEGIN");
      const { rows: cur } = await client.query<{
        public_key: Buffer;
        priv_wrapped_recovery: Buffer | null;
        priv_wrapped_password: Buffer | null;
        created_at: Date;
      }>(
        "SELECT public_key, priv_wrapped_recovery, priv_wrapped_password, created_at FROM user_keys WHERE user_id = $1 FOR UPDATE",
        [session.userId],
      );
      if (!cur[0]) {
        await client.query(
          "INSERT INTO user_keys (user_id, public_key, priv_wrapped_recovery) VALUES ($1, $2, $3)",
          [session.userId, publicKey, recovery],
        );
      } else if (!cur[0].public_key.equals(publicKey)) {
        // Churn brake (`crypto/key-churn.ts`): counted under the row lock taken
        // above, so two racing replacements cannot both pass the last slot.
        const { rows: recent } = await client.query<{ n: number; retry: number | null }>(
          `SELECT count(*)::int AS n,
                  ceil(extract(epoch FROM min(replaced_at) + make_interval(secs => $2::double precision) - now()))::int AS retry
             FROM user_key_history
            WHERE user_id = $1 AND replaced_at > now() - make_interval(secs => $2::double precision)`,
          [session.userId, KEY_REPLACEMENT_WINDOW_MS / 1000],
        );
        if ((recent[0]?.n ?? 0) >= MAX_KEY_REPLACEMENTS) {
          refusedFor = Math.max(1, recent[0]?.retry ?? 1);
          await client.query("ROLLBACK");
        } else {
          await client.query(
            `INSERT INTO user_key_history (user_id, public_key, priv_wrapped_recovery, priv_wrapped_password, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [session.userId, cur[0].public_key, cur[0].priv_wrapped_recovery, cur[0].priv_wrapped_password, cur[0].created_at],
          );
          // The password wrap held the OLD private key: kept in history, cleared
          // here so no device unlocks a key that no longer matches publicKey.
          await client.query(
            `UPDATE user_keys SET public_key = $2, priv_wrapped_recovery = $3, created_at = now(), key_changed_at = now(),
                    priv_wrapped_password = NULL, password_wrap_at = NULL
              WHERE user_id = $1`,
            [session.userId, publicKey, recovery],
          );
          replaced = true;
        }
      }
      if (!refusedFor) await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (refusedFor) {
      c.header("Retry-After", String(refusedFor));
      return c.json(
        {
          error: `Your security key was replaced ${MAX_KEY_REPLACEMENTS} times in the last day. Try again in ${plainWait(refusedFor)}.`,
          code: RATE_LIMITED,
          retryAfter: refusedFor,
        },
        429,
      );
    }
    return c.json({ saved: true, replaced });
  });

  // ── Seamless keys F: the password unlocks the account key. The unlock key is
  // derived with the server-only pepper, so the database alone (hashes +
  // `priv_wrapped_password`) never yields it. Never log the body or the key.
  routes.post("/me/keys/unlock", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const pepper = accountKeyPepper();
    if (!pepper) return c.json({ error: "Password unlock is off on this server", code: PASSWORD_UNLOCK_OFF }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password || password.length > 1024) {
      return c.json({ error: "password is required", code: "invalid_argument" }, 400);
    }
    // Shares the email sign-in throttle (#237): a locked account is refused
    // before any check, and a wrong password here counts as a failed sign-in.
    // Check → verify → record run in the account's password slot (one at a
    // time per email, across instances), so a burst cannot outrun the lock.
    const verdict = await withPasswordSlot(session.email, async () => {
      const wait = await lockedForSeconds(session.email);
      if (wait > 0) return throttledResponse(wait);
      const { rows } = await pool.query<{ password: string | null }>(
        `SELECT password FROM account WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL LIMIT 1`,
        [session.userId],
      );
      if (!rows[0]?.password) {
        return c.json({ error: "This account signs in without a password", code: "no_password" }, 409);
      }
      if (!(await verifyPassword({ hash: rows[0].password, password }))) {
        await recordFailure(session.email);
        return c.json({ error: "Wrong password", code: "wrong_password" }, 401);
      }
      await clearThrottle(session.email);
      return "ok" as const;
    });
    if (verdict === null) return throttledResponse(1); // slot stayed busy
    if (verdict !== "ok") return verdict;
    await upgradeLoginHash({ userId: session.userId }, password);
    const key = deriveUnlockKey(pepper, session.userId, password);
    const unlockKey = key.toString("base64");
    key.fill(0);
    c.header("Cache-Control", "no-store");
    return c.json({ unlockKey });
  });

  routes.put("/me/keys/password-wrap", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    if (!accountKeyPepper()) {
      return c.json({ error: "Password unlock is off on this server", code: PASSWORD_UNLOCK_OFF }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const privWrapped = b64(body?.privWrapped);
    if (!privWrapped) return c.json({ error: "privWrapped is required", code: "invalid_argument" }, 400);
    const { rowCount } = await pool.query(
      "UPDATE user_keys SET priv_wrapped_password = $2, password_wrap_at = now() WHERE user_id = $1",
      [session.userId, privWrapped],
    );
    if (!rowCount) return c.json({ error: "This account has no security key yet", code: "no_account_key" }, 409);
    return c.json({ stored: true });
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
    // Hourly brake on NEW registrations (an idempotent repeat answered above):
    // denying and re-registering must not loop approval prompts at the person.
    const budget = takeKeyChurn("device-register", session.userId);
    if (!budget.ok) {
      c.header("Retry-After", String(budget.retryAfter));
      return c.json(
        {
          error: `Too many computers asked to sign in as you this hour. Try again in ${plainWait(budget.retryAfter)}.`,
          code: RATE_LIMITED,
          retryAfter: budget.retryAfter,
        },
        429,
      );
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
    // Hourly brake on NEW approvals; a repeat of an existing wrap is answered below unspent.
    const { rows: had } = await pool.query(
      "SELECT 1 FROM user_device_keys WHERE user_id = $1 AND device_id = $2",
      [session.userId, deviceId],
    );
    if (!had[0]) {
      const budget = takeKeyChurn("device-approve", session.userId);
      if (!budget.ok) {
        c.header("Retry-After", String(budget.retryAfter));
        return c.json(
          {
            error: `Too many computers approved this hour. Try again in ${plainWait(budget.retryAfter)}.`,
            code: RATE_LIMITED,
            retryAfter: budget.retryAfter,
          },
          429,
        );
      }
    }
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
