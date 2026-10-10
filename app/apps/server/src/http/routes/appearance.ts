// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { parseAppearance } from "../../appearance/schema.js";
import { announceAppearanceChanged } from "../../sync/member-events.js";
import { getSession } from "../session.js";

/**
 * Vault-level appearance (migration 053).
 *
 *  - GET /api/orgs/:orgId/appearance (any member) → `{ settings, updatedAt,
 *    updatedBy }`; `{}` settings and nulls when nothing was ever saved.
 *  - PUT /api/orgs/:orgId/appearance `{ settings }` (owner/admin) REPLACES the
 *    whole object, then announces `appearance-changed` on the vault channel
 *    with the settings inline, the same org-wide fan-out a vault rename/icon
 *    change uses (`announceOrgChanged`). No plan gate.
 */
export const appearanceRoutes = new Hono();

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

type Row = { settings: Record<string, unknown>; updated_by: string | null; updated_at: Date };

function body(row: Row | undefined) {
  return {
    settings: row?.settings ?? {},
    updatedAt: row ? row.updated_at.toISOString() : null,
    updatedBy: row?.updated_by ?? null,
  };
}

appearanceRoutes.get("/orgs/:orgId/appearance", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "not_member" }, 404);
  const role = await orgRole(orgId, session.userId);
  if (!role) return c.json({ error: "not_member" }, 404);
  const { rows } = await pool.query<Row>(
    "SELECT settings, updated_by, updated_at FROM vault_appearance WHERE organization_id = $1",
    [orgId],
  );
  return c.json(body(rows[0]));
});

appearanceRoutes.put("/orgs/:orgId/appearance", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "not_member" }, 404);
  const role = await orgRole(orgId, session.userId);
  if (!role) return c.json({ error: "not_member" }, 404);
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "access_manager_required" }, 403);
  }
  const raw = (await c.req.json().catch(() => null)) as { settings?: unknown } | null;
  const parsed = parseAppearance(raw?.settings);
  if (!parsed.ok) {
    return c.json({ error: "invalid_appearance", ...(parsed.key ? { key: parsed.key } : {}) }, 400);
  }
  const { rows } = await pool.query<Row>(
    `INSERT INTO vault_appearance (organization_id, settings, updated_by, updated_at)
          VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (organization_id)
       DO UPDATE SET settings = EXCLUDED.settings,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = EXCLUDED.updated_at
     RETURNING settings, updated_by, updated_at`,
    [orgId, JSON.stringify(parsed.settings), session.userId],
  );
  const out = body(rows[0]);
  await announceAppearanceChanged({
    orgId,
    settings: out.settings,
    updatedAt: out.updatedAt as string,
  });
  return c.json(out);
});
