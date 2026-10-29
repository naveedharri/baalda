// SPDX-License-Identifier: Apache-2.0
//
// Converting a vault to a client-held key without breaking MCP tokens or
// public links (W3; the flow is described in crypto/conversion.ts). Every
// route answers 404 unless BAALDA_VAULT_KEYS is on.
//
// POST /api/vaults/:vaultId/keys/pending                register the future check (VK)
// GET  /api/vaults/:vaultId/keys/allowlist-candidates   live tokens + links to vouch for (VK)
// POST /api/vaults/:vaultId/keys/allowlist              {entries:[{kind, id, mac}]} (VK)
// GET  /api/vaults/:vaultId/keys/conversion-ready       may `keys/init` run yet?
//
// "(VK)" = the request must carry `X-Baalda-VK`, verified against the vault's
// check (keyed, or pending). Never logged.
import { Hono, type Context } from "hono";
import { pool } from "../../db/pool.js";
import { vaultKeysEnabled } from "../../crypto/config.js";
import {
  conversionBlockers,
  isReady,
  loadPendingCheck,
  vaultCheckState,
  verifyPresentedKey,
} from "../../crypto/conversion.js";
import { decodeVk, loadVkCheck, VK_HEADER, KEY_REQUIRED_CODE } from "../../crypto/transport.js";
import { verifyVk } from "../../crypto/vk-check.js";
import { verifyAllowMac } from "../../crypto/token-wrap.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";

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
    if (await loadVkCheck(m.vaultId, pool)) {
      return c.json({ error: "This vault already has a key", code: "already_keyed" }, 409);
    }
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
    return c.json({ pending: true, generation }, 201);
  });

  routes.get("/vaults/:vaultId/keys/allowlist-candidates", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    const state = await verifyPresentedKey(m.vaultId, presented(c), pool);
    if (!state) return keyRequired(c);
    const { rows: tokens } = await pool.query<{
      id: string;
      token_hash: string;
      last_used_at: Date | null;
      wrapped: boolean;
      allowed: boolean;
    }>(
      `SELECT t.id, t.token_hash, t.last_used_at,
              EXISTS (SELECT 1 FROM mcp_token_keys k WHERE k.token_id = t.id AND k.vault_id = $1 AND k.generation = $3) AS wrapped,
              EXISTS (SELECT 1 FROM mcp_token_allow a WHERE a.token_id = t.id AND a.vault_id = $1) AS allowed
         FROM mcp_tokens t WHERE t.organization_id = $2 ORDER BY t.created_at`,
      [m.vaultId, m.orgId, state.generation],
    );
    const { rows: links } = await pool.query<{
      id: string;
      token_hash: string | null;
      last_viewed_at: Date | null;
      wrapped: boolean;
      allowed: boolean;
    }>(
      `SELECT id, token_hash, last_viewed_at,
              (wrapped_vk IS NOT NULL AND wrap_generation = $2) AS wrapped,
              allow_mac IS NOT NULL AS allowed
         FROM public_links WHERE vault_id = $1 AND token_hash IS NOT NULL ORDER BY created_at`,
      [m.vaultId, state.generation],
    );
    return c.json({
      generation: state.generation,
      pending: state.pending,
      // The MAC is HMAC-SHA256(VK, id || 0x00 || tokenHash) — see crypto/token-wrap.ts.
      tokens: tokens.map((t) => ({
        kind: "token",
        id: t.id,
        tokenHash: t.token_hash,
        lastUsedAt: t.last_used_at,
        wrapped: t.wrapped,
        allowed: t.allowed,
      })),
      links: links.map((l) => ({
        kind: "link",
        id: l.id,
        tokenHash: l.token_hash,
        lastViewedAt: l.last_viewed_at,
        wrapped: l.wrapped,
        allowed: l.allowed,
      })),
    });
  });

  routes.post("/vaults/:vaultId/keys/allowlist", async (c) => {
    const m = await member(c);
    if (m instanceof Response) return m;
    const vk = presented(c);
    const state = await verifyPresentedKey(m.vaultId, vk, pool);
    if (!state || !vk) return keyRequired(c);
    const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
    const entries = Array.isArray(body?.entries) ? (body.entries as Array<Record<string, unknown>>) : null;
    if (!entries || entries.length > MAX_ENTRIES) {
      return c.json({ error: `entries (at most ${MAX_ENTRIES}) are required`, code: "invalid_argument" }, 400);
    }
    let accepted = 0;
    const rejected: string[] = [];
    for (const e of entries) {
      const kind = e.kind === "link" ? "link" : "token";
      const id = typeof e.id === "string" ? e.id : typeof e.tokenId === "string" ? e.tokenId : "";
      const mac = b64(e.mac, 64);
      if (!id || !mac) {
        rejected.push(id || "?");
        continue;
      }
      // The server holds VK for this request, so it checks every MAC: an entry
      // it cannot verify is refused rather than stored.
      if (kind === "token") {
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
      accepted += 1;
    }
    return c.json({ accepted, rejected });
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
