// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { EMPTY_SYNC_RULES, parseSyncRules, type SyncRules } from "../../sync-rules/schema.js";
import { announceSyncRulesChanged } from "../../sync/member-events.js";
import { getSession } from "../session.js";

/**
 * The vault's sync rules (#401, migration 098).
 *
 *  - GET /api/orgs/:orgId/sync-rules (any member) → `{ rules, revision,
 *    updatedAt, updatedBy }`; empty rules and revision 0 when never saved.
 *  - PUT /api/orgs/:orgId/sync-rules `{ rules, baseRevision }` (owner/admin)
 *    replaces the rules when `baseRevision` is the stored revision (0 for
 *    "never saved"), else 409 `stale_sync_rules` with the current state. The
 *    change is recorded in `access_audit` in the same transaction and
 *    announced as `sync-rules-changed` on the vault channel, org-wide.
 *
 * The server stores the rules; desktops apply them. Nothing here moves or
 * deletes a note: a rule only stops devices syncing the paths it names.
 */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** What the access history records: the patterns, plus the type switches when any is on. */
const auditState = (r: SyncRules) => ({
  patterns: r.patterns,
  ...(r.types ? { types: r.types } : {}),
  ...(r.folders ? { folders: r.folders } : {}),
});

type Row = { rules: SyncRules; revision: number; updated_by: string | null; updated_at: Date };

function body(row: Row | undefined) {
  return {
    rules: row ? { ...EMPTY_SYNC_RULES, ...row.rules } : EMPTY_SYNC_RULES,
    revision: row?.revision ?? 0,
    updatedAt: row ? row.updated_at.toISOString() : null,
    updatedBy: row?.updated_by ?? null,
  };
}

const SELECT = "SELECT rules, revision, updated_by, updated_at FROM vault_sync_rules WHERE organization_id = $1";

export function createSyncRulesRoutes(): Hono {
  const routes = new Hono();

  routes.get("/orgs/:orgId/sync-rules", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    if (!ID_RE.test(orgId)) return c.json({ error: "not_member" }, 404);
    if (!(await orgRole(orgId, session.userId))) return c.json({ error: "not_member" }, 404);
    const { rows } = await pool.query<Row>(SELECT, [orgId]);
    return c.json(body(rows[0]));
  });

  routes.put("/orgs/:orgId/sync-rules", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    if (!ID_RE.test(orgId)) return c.json({ error: "not_member" }, 404);
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "not_member" }, 404);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "sync_rules_admin_required", message: "Only owners and admins can change what syncs." }, 403);
    }
    const raw = (await c.req.json().catch(() => null)) as { rules?: unknown; baseRevision?: unknown } | null;
    const parsed = parseSyncRules(raw?.rules);
    if (!parsed.ok) return c.json({ error: parsed.error, message: parsed.message }, 400);
    const base = raw?.baseRevision;
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0) {
      return c.json({ error: "invalid_sync_rules", message: "baseRevision is required" }, 400);
    }
    const db = await pool.connect();
    let row: Row | undefined;
    let changed = false;
    try {
      await db.query("BEGIN");
      const current = (await db.query<Row>(SELECT + " FOR UPDATE", [orgId])).rows[0];
      const currentRevision = current?.revision ?? 0;
      if (base !== currentRevision) {
        await db.query("ROLLBACK");
        return c.json({ error: "stale_sync_rules", current: body(current) }, 409);
      }
      const before = current ? { ...EMPTY_SYNC_RULES, ...current.rules } : EMPTY_SYNC_RULES;
      const sameTypes = JSON.stringify(before.types ?? null) === JSON.stringify(parsed.rules.types ?? null);
      const sameFolders = JSON.stringify(before.folders ?? null) === JSON.stringify(parsed.rules.folders ?? null);
      const sameVersion = (before.version ?? 1) === parsed.rules.version;
      if (before.patterns === parsed.rules.patterns && sameTypes && sameFolders && sameVersion) {
        await db.query("ROLLBACK");
        return c.json(body(current));
      }
      const { rows } = await db.query<Row>(
        `INSERT INTO vault_sync_rules (organization_id, rules, revision, updated_by, updated_at)
              VALUES ($1, $2::jsonb, 1, $3, now())
         ON CONFLICT (organization_id) DO UPDATE SET
              rules = EXCLUDED.rules,
              revision = vault_sync_rules.revision + 1,
              updated_by = EXCLUDED.updated_by,
              updated_at = EXCLUDED.updated_at
         RETURNING rules, revision, updated_by, updated_at`,
        [orgId, JSON.stringify(parsed.rules), session.userId],
      );
      row = rows[0];
      // Who changed what syncs, beside the other access history (056). The
      // patterns are paths, never note content.
      await db.query(
        `INSERT INTO access_audit (organization_id, actor_user_id, actor_name, entity_type, entity_id, action, before_state, after_state)
         SELECT $1, $2, (SELECT name FROM "user" WHERE id = $2), 'vault_sync_rules', $1, $3, $4::jsonb, $5::jsonb`,
        [orgId, session.userId, current ? "update" : "insert", JSON.stringify(auditState(before)), JSON.stringify(auditState(parsed.rules))],
      );
      await db.query("COMMIT");
      changed = true;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    const out = body(row);
    if (changed) await announceSyncRulesChanged(orgId, out.revision);
    return c.json(out);
  });

  return routes;
}
