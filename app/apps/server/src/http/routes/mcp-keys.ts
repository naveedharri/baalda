// SPDX-License-Identifier: Apache-2.0
//
// Converting a vault to a client-held key without breaking MCP tokens or
// public links (W3; the flow is described in crypto/conversion.ts). Every
// route answers 404 unless BAALDA_VAULT_KEYS is on.
//
// POST /api/vaults/:vaultId/keys/pending                {vkCheck, generation, deviceId} (VK);
//                                                       identical repeat 200, another check 409
// GET  /api/vaults/:vaultId/keys/allowlist-candidates   [{kind, id, hash}] (VK), kind =
//                                                       mcp_token | oauth_grant | public_link;
//                                                       owners/admins also get label, createdBy,
//                                                       createdAt, lastUsedAt, allowed, excluded
// POST /api/vaults/:vaultId/keys/allowlist              {entries:[{kind, id, mac}],
//                                                        excluded?:[{kind, id}]} (VK),
//                                                       mac = HMAC-SHA256(VK, utf8(id) || utf8(hash));
//                                                       `excluded` = unchecked in the owner's review
//                                                       (owner/admin, pending only): never allow-listed,
//                                                       no longer holds the gate, nothing revoked
// GET  /api/vaults/:vaultId/keys/conversion-ready       {ready, …} may `keys/init` run yet?
//
// "(VK)" = the request must carry `X-Baalda-VK`, verified against the vault's
// check (keyed, or pending). Never logged.
import { bareHashHex } from "../../mcp/oauth-token-hash.js";
import { Hono, type Context } from "hono";
import { pool } from "../../db/pool.js";
import { vaultKeysEnabled } from "../../crypto/config.js";
import {
  conversionBlockers,
  ENCRYPTION_NOT_REQUESTED,
  encryptionRequested,
  isReady,
  loadPendingCheck,
  vaultCheckState,
  vaultHasKeyMaterial,
  verifyPresentedKey,
  KEY_MATERIAL_EXISTS,
} from "../../crypto/conversion.js";
import { decodeVk, loadVkCheck, VK_HEADER, KEY_REQUIRED_CODE } from "../../crypto/transport.js";
import { verifyVk } from "../../crypto/vk-check.js";
import { verifyAllowMac } from "../../crypto/token-wrap.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { KEYING_REQUIRES_ADMIN, mayKeyVault } from "./vault-keys.js";

const MAX_ENTRIES = 2000;

function b64(v: unknown, max = 16 * 1024): Buffer | null {
  if (typeof v !== "string" || v === "" || v.length > max) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length > 0 ? buf : null;
}

function presented(c: Context): Buffer | null {
  return (c.get("presentedVk" as never) as Buffer | undefined) ?? decodeVk(c.req.header(VK_HEADER));
}

async function member(c: Context): Promise<{ userId: string; vaultId: string; orgId: string } | Response> {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.param("vaultId") ?? "";
  const orgId = await vaultOrg(vaultId);
  if (!orgId || !(await orgRole(orgId, session.userId))) return c.json({ error: "Unknown vault" }, 404);
  return { userId: session.userId, vaultId, orgId };
}

/** Desktop contract kinds (old "token"/"link" spellings accepted too). */
const KINDS: Record<string, "mcp_token" | "oauth_grant" | "public_link"> = {
  mcp_token: "mcp_token",
  token: "mcp_token",
  oauth_grant: "oauth_grant",
  public_link: "public_link",
  link: "public_link",
};

/**
 * The org's OAuth grants that can still act (refresh token unexpired), with
 * hash = bare sha256 hex of the refresh token (never the stored `h1:` form).
 * Optionally one grant by id.
 */
async function oauthGrants(orgId: string, id?: string): Promise<Array<{ id: string; hash: string }>> {
  const { rows } = await pool.query<{ id: string; refresh: string }>(
    `SELECT a.id, a."refreshToken" AS refresh
       FROM "oauthAccessToken" a
       JOIN mcp_oauth_vault m ON m.client_id = a."clientId" AND m.user_id = a."userId"
      WHERE m.organization_id = $1 AND a."refreshTokenExpiresAt" > now()
        AND ($2::text IS NULL OR a.id = $2)
      ORDER BY a."createdAt", a.id`,
    [orgId, id ?? null],
  );
  // The stored refresh token is legacy plaintext or `h1:` + hex sha256 (lazy
  // hashing); either way the MAC input is the bare hex sha256.
  return rows.map((r) => ({ id: r.id, hash: bareHashHex(r.refresh) }));
}

const isManager = (role: string | null) => role === "owner" || role === "admin";

/** Is this token / grant / link one of this org's (vault's)? Never an outsider's id. */
async function belongsHere(kind: string, id: string, orgId: string, vaultId: string): Promise<boolean> {
  const q =
    kind === "mcp_token"
      ? pool.query("SELECT 1 FROM mcp_tokens WHERE id = $1 AND organization_id = $2", [id, orgId])
      : kind === "oauth_grant"
        ? pool.query(
            `SELECT 1 FROM "oauthAccessToken" a
               JOIN mcp_oauth_vault m ON m.client_id = a."clientId" AND m.user_id = a."userId"
              WHERE a.id = $1 AND m.organization_id = $2`,
            [id, orgId],
          )
        : pool.query("SELECT 1 FROM public_links WHERE id = $1 AND vault_id = $2", [id, vaultId]);
  return ((await q).rowCount ?? 0) > 0;
}

export interface ReviewCandidate {
  kind: "mcp_token" | "oauth_grant" | "public_link";
  id: string;
  hash: string;
  /** Token name, the OAuth app's name (Claude, ChatGPT…), or the note's path. */
  label: string | null;
  /** Display name (else email) of who made it; null when unknown/deleted. */
  createdBy: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** Already allow-listed for this vault. */
  allowed: boolean;
  /** Unchecked in an earlier review (`vault_conversion_exclusions`). */
  excluded: boolean;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** The allow-list candidates with what an owner/admin needs to review them. */
async function reviewCandidates(orgId: string, vaultId: string): Promise<ReviewCandidate[]> {
  const creator = `COALESCE(NULLIF(btrim(u.name), ''), u.email)`;
  type Row = {
    id: string;
    hash: string;
    label: string | null;
    created_by: string | null;
    created_at: Date | null;
    last_used_at: Date | null;
    allowed: boolean;
    excluded: boolean;
  };
  const excludedSql = (kind: string, idCol: string, vaultParam = "$2") =>
    `EXISTS (SELECT 1 FROM vault_conversion_exclusions x
              WHERE x.vault_id = ${vaultParam} AND x.kind = '${kind}' AND x.item_id = ${idCol})`;
  const { rows: tokens } = await pool.query<Row>(
    `SELECT t.id, t.token_hash AS hash, t.name AS label, ${creator} AS created_by,
            t.created_at, t.last_used_at,
            EXISTS (SELECT 1 FROM mcp_token_allow a WHERE a.token_id = t.id AND a.vault_id = $2) AS allowed,
            ${excludedSql("mcp_token", "t.id")} AS excluded
       FROM mcp_tokens t LEFT JOIN "user" u ON u.id = t.user_id
      WHERE t.organization_id = $1
      ORDER BY t.created_at, t.id`,
    [orgId, vaultId],
  );
  const { rows: grants } = await pool.query<Row & { refresh: string }>(
    `SELECT a.id, a."refreshToken" AS refresh, app.name AS label, ${creator} AS created_by,
            a."createdAt" AS created_at, GREATEST(a."createdAt", a."updatedAt") AS last_used_at,
            EXISTS (SELECT 1 FROM oauth_grant_allow g WHERE g.grant_id = a.id AND g.vault_id = $2) AS allowed,
            ${excludedSql("oauth_grant", "a.id")} AS excluded
       FROM "oauthAccessToken" a
       JOIN mcp_oauth_vault m ON m.client_id = a."clientId" AND m.user_id = a."userId"
       LEFT JOIN "oauthApplication" app ON app."clientId" = a."clientId"
       LEFT JOIN "user" u ON u.id = a."userId"
      WHERE m.organization_id = $1 AND a."refreshTokenExpiresAt" > now()
      ORDER BY a."createdAt", a.id`,
    [orgId, vaultId],
  );
  const { rows: links } = await pool.query<Row>(
    `SELECT l.id, l.token_hash AS hash, n.rel_path AS label, ${creator} AS created_by,
            l.created_at, l.last_viewed_at AS last_used_at,
            l.allow_mac IS NOT NULL AS allowed,
            ${excludedSql("public_link", "l.id", "$1")} AS excluded
       FROM public_links l
       LEFT JOIN notes n ON n.id = l.doc_id
       LEFT JOIN "user" u ON u.id = l.created_by
      WHERE l.vault_id = $1 AND l.token_hash IS NOT NULL
      ORDER BY l.created_at, l.id`,
    [vaultId],
  );
  const shape = (kind: ReviewCandidate["kind"], r: Row, hash: string): ReviewCandidate => ({
    kind,
    id: r.id,
    hash,
    label: r.label,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    lastUsedAt: iso(r.last_used_at),
    allowed: r.allowed,
    excluded: r.excluded,
  });
  return [
    ...tokens.map((r) => shape("mcp_token", r, r.hash)),
    // The MAC input is the bare hex sha256 of the refresh token (never `h1:`).
    ...grants.map((r) => shape("oauth_grant", r, bareHashHex(r.refresh))),
    ...links.map((r) => shape("public_link", r, r.hash)),
  ];
}

const keyRequired = (c: Context) =>
  c.json({ error: "This needs the vault's key from your device", code: KEY_REQUIRED_CODE }, 409);

export function createMcpKeyRoutes(): Hono {
  const routes = new Hono();
  const paths = ["pending", "allowlist-candidates", "allowlist", "conversion-ready"];
  for (const p of paths) {
    routes.use(`/vaults/:vaultId/keys/${p}`, async (c, next) => {
      if (!vaultKeysEnabled()) return c.json({ error: "Not found" }, 404);
      await next();
    });
  }

  routes.post("/vaults/:vaultId/keys/pending", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const vkCheck = b64(body?.vkCheck);
    const generation = body?.generation;
    if (!vkCheck || typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 0xffff) {
      return c.json({ error: "vkCheck and generation are required", code: "invalid_argument" }, 400);
    }
    // Prove the caller holds the key this check is for.
    const vk = presented(c);
    if (!vk || !verifyVk(vk, m.vaultId, vkCheck)) return keyRequired(c);
    // Converting is for owners/admins (`mayKeyVault`): the converting device
    // is the only key holder until it shares the key.
    const role = await orgRole(m.orgId, m.userId);
    const { rows: creator } = await pool.query<{ by: string | null }>(
      "SELECT encryption_requested_by AS by FROM vaults WHERE id = $1",
      [m.vaultId],
    );
    if (!mayKeyVault(role, m.userId, creator[0]?.by ?? null)) return c.json(KEYING_REQUIRES_ADMIN, 403);
    if (await loadVkCheck(m.vaultId, pool)) {
      return c.json({ error: "This vault already has a key", code: "already_keyed" }, 409);
    }
    // Opt-in: nothing is stored for a vault nobody asked to encrypt.
    if (!(await encryptionRequested(m.vaultId, pool))) return c.json(ENCRYPTION_NOT_REQUESTED, 409);
    // Sealed data already here (a wiped vk_check): never register a new key.
    if (await vaultHasKeyMaterial(m.vaultId, pool)) return c.json(KEY_MATERIAL_EXISTS, 409);
    await pool.query(
      `INSERT INTO vault_pending_keys (vault_id, vk_check, generation, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (vault_id) DO NOTHING`,
      [m.vaultId, vkCheck, generation, m.userId],
    );
    // Never replace key material: the same check again is idempotent, another is 409.
    const cur = await loadPendingCheck(m.vaultId, pool);
    if (!cur || !cur.vkCheck.equals(vkCheck) || cur.generation !== generation) {
      return c.json({ error: "This vault is already being converted with another key", code: "pending_mismatch" }, 409);
    }
    await verifyPresentedKey(m.vaultId, vk, pool);
    // 200 on the first and every identical repeat (desktop contract).
    return c.json({ pending: true, generation }, 200);
  });

  routes.get("/vaults/:vaultId/keys/allowlist-candidates", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    const state = await verifyPresentedKey(m.vaultId, presented(c), pool);
    if (!state) return keyRequired(c);
    // Owners/admins review the list before anything is allow-listed: they get
    // what each connection is, who made it and when it was last used.
    if (isManager(await orgRole(m.orgId, m.userId))) return c.json(await reviewCandidates(m.orgId, m.vaultId));
    const { rows: tokens } = await pool.query<{ id: string; token_hash: string }>(
      "SELECT id, token_hash FROM mcp_tokens WHERE organization_id = $1 ORDER BY created_at, id",
      [m.orgId],
    );
    const grants = await oauthGrants(m.orgId);
    const { rows: links } = await pool.query<{ id: string; token_hash: string }>(
      `SELECT id, token_hash FROM public_links
        WHERE vault_id = $1 AND token_hash IS NOT NULL ORDER BY created_at, id`,
      [m.vaultId],
    );
    // Desktop contract: a flat list; mac = HMAC-SHA256(VK, utf8(id) || utf8(hash)).
    return c.json([
      ...tokens.map((t) => ({ kind: "mcp_token", id: t.id, hash: t.token_hash })),
      ...grants.map((g) => ({ kind: "oauth_grant", id: g.id, hash: g.hash })),
      ...links.map((l) => ({ kind: "public_link", id: l.id, hash: l.token_hash })),
    ]);
  });

  routes.post("/vaults/:vaultId/keys/allowlist", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    const vk = presented(c);
    const state = await verifyPresentedKey(m.vaultId, vk, pool);
    if (!state || !vk) return keyRequired(c);
    const body = (await c.req.json().catch(() => null)) as { entries?: unknown; excluded?: unknown } | null;
    const excludedIn = Array.isArray(body?.excluded) ? (body.excluded as Array<Record<string, unknown>>) : null;
    const entries = Array.isArray(body?.entries)
      ? (body.entries as Array<Record<string, unknown>>)
      : excludedIn
        ? []
        : null;
    if (!entries || entries.length + (excludedIn?.length ?? 0) > MAX_ENTRIES) {
      return c.json({ error: `entries (at most ${MAX_ENTRIES}) are required`, code: "invalid_argument" }, 400);
    }
    let accepted = 0;
    const rejected: string[] = [];
    let excluded = 0;
    if (excludedIn?.length) {
      // The owner's review: what they unchecked is never allow-listed and no
      // longer holds the conversion. Owner/admin only, and only while pending.
      if (!isManager(await orgRole(m.orgId, m.userId))) {
        return c.json({ error: "Only an owner or admin can review connections", code: "access_manager_required" }, 403);
      }
      if (!state.pending) return c.json({ error: "This vault already has a key", code: "already_keyed" }, 409);
      for (const e of excludedIn) {
        const kind = KINDS[String(e?.kind)];
        const id = typeof e?.id === "string" ? e.id : "";
        if (!kind || !id || !(await belongsHere(kind, id, m.orgId, m.vaultId))) {
          rejected.push(id || "?");
          continue;
        }
        await pool.query(
          `INSERT INTO vault_conversion_exclusions (vault_id, kind, item_id, created_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (vault_id, kind, item_id) DO NOTHING`,
          [m.vaultId, kind, id, m.userId],
        );
        // Unchecked after an earlier allow: withdraw it so it is not upgraded.
        if (kind === "mcp_token") {
          await pool.query("DELETE FROM mcp_token_allow WHERE token_id = $1 AND vault_id = $2", [id, m.vaultId]);
        } else if (kind === "oauth_grant") {
          await pool.query("DELETE FROM oauth_grant_allow WHERE grant_id = $1 AND vault_id = $2", [id, m.vaultId]);
        } else {
          await pool.query("UPDATE public_links SET allow_mac = NULL WHERE id = $1 AND vault_id = $2", [id, m.vaultId]);
        }
        excluded += 1;
      }
    }
    for (const e of entries) {
      const kind = KINDS[String(e.kind)];
      const id = typeof e.id === "string" ? e.id : "";
      const mac = b64(e.mac, 64);
      if (!kind || !id || !mac) {
        rejected.push(id || "?");
        continue;
      }
      // The server holds VK for this request, so it checks every MAC: an entry
      // it cannot verify is refused rather than stored.
      if (kind === "oauth_grant") {
        const grant = (await oauthGrants(m.orgId, id))[0];
        if (!grant || !verifyAllowMac(vk, id, grant.hash, mac)) {
          rejected.push(id);
          continue;
        }
        await pool.query(
          `INSERT INTO oauth_grant_allow (grant_id, vault_id, mac, created_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (grant_id, vault_id) DO UPDATE SET mac = EXCLUDED.mac, created_by = EXCLUDED.created_by`,
          [id, m.vaultId, mac, m.userId],
        );
      } else if (kind === "mcp_token") {
        const { rows } = await pool.query<{ token_hash: string }>(
          "SELECT token_hash FROM mcp_tokens WHERE id = $1 AND organization_id = $2",
          [id, m.orgId],
        );
        if (!rows[0] || !verifyAllowMac(vk, id, rows[0].token_hash, mac)) {
          rejected.push(id);
          continue;
        }
        await pool.query(
          `INSERT INTO mcp_token_allow (token_id, vault_id, mac, created_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (token_id, vault_id) DO UPDATE SET mac = EXCLUDED.mac, created_by = EXCLUDED.created_by`,
          [id, m.vaultId, mac, m.userId],
        );
      } else {
        const { rows } = await pool.query<{ token_hash: string | null }>(
          "SELECT token_hash FROM public_links WHERE id = $1 AND vault_id = $2",
          [id, m.vaultId],
        );
        if (!rows[0]?.token_hash || !verifyAllowMac(vk, id, rows[0].token_hash, mac)) {
          rejected.push(id);
          continue;
        }
        await pool.query("UPDATE public_links SET allow_mac = $2 WHERE id = $1", [id, mac]);
      }
      // Re-checked in a later review: no longer excluded.
      await pool.query(
        "DELETE FROM vault_conversion_exclusions WHERE vault_id = $1 AND kind = $2 AND item_id = $3",
        [m.vaultId, kind, id],
      );
      accepted += 1;
    }
    return c.json(excludedIn ? { accepted, rejected, excluded } : { accepted, rejected });
  });

  routes.get("/vaults/:vaultId/keys/conversion-ready", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    // A verified key keeps the pending key warm so allow-listed tokens upgrade.
    await verifyPresentedKey(m.vaultId, presented(c), pool);
    const state = await vaultCheckState(m.vaultId, pool);
    const generation = state?.generation ?? 1;
    const b = await conversionBlockers(m.vaultId, generation, pool);
    return c.json({
      keyed: Boolean(state && !state.pending),
      pending: Boolean(state?.pending),
      generation,
      ready: isReady(b),
      blockers: { tokens: b.tokens.length, links: b.links.length, oauthGrants: b.oauthGrants },
    });
  });

  return routes;
}
