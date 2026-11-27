// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import type { AccessChangeDeps } from "../../permissions/access-management.js";
import { announceSkillsChanged } from "../../sync/member-events.js";
import { getSession } from "../session.js";
import {
  GroupError,
  addGroupMembers,
  createGroup,
  deleteGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../../groups/service.js";
import { heldByOwnSettings, letGroupDecide } from "../../groups/held.js";

/** `/health` feature flag: access groups (migration 097). */
export const ACCESS_GROUPS_FEATURE = "access-groups";

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Access groups — `/api/orgs/:orgId/groups…` (`groups/service.ts`).
 *
 *  - GET    /orgs/:orgId/groups                      any member; grants for managers only
 *  - POST   /orgs/:orgId/groups                      {name, color?, autoJoin?, memberIds?}
 *  - PATCH  /orgs/:orgId/groups/:groupId             {name?, color?, autoJoin?}
 *  - DELETE /orgs/:orgId/groups/:groupId
 *  - POST   /orgs/:orgId/groups/:groupId/members     {userIds}
 *  - DELETE /orgs/:orgId/groups/:groupId/members/:userId
 *  - GET    /orgs/:orgId/groups/:groupId/activity    managers; from access_audit
 *  - GET    /orgs/:orgId/groups/:groupId/skills      managers; every live skill + this group's row
 *
 * A group's access is written through `POST /orgs/:orgId/access/bulk` with
 * `audience: {type: "group", groupId}` and read through
 * `GET /vaults/:id/access-board?groupId=`.
 */
export function createGroupRoutes(deps: AccessChangeDeps = {}): Hono {
  const app = new Hono();

  const fail = (c: { json: (b: unknown, s: 400 | 403 | 404 | 409) => Response }, err: unknown) => {
    if (err instanceof GroupError) return c.json({ error: err.code, message: err.message }, err.status);
    throw err;
  };
  const skillsHint = async (orgId: string, changed: boolean) => {
    if (changed) await announceSkillsChanged(orgId);
  };

  app.get("/orgs/:orgId/groups", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    if (!ID_RE.test(orgId)) return c.json({ error: "Malformed id" }, 400);
    try {
      return c.json(await listGroups(orgId, session.userId));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/orgs/:orgId/groups", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    if (!ID_RE.test(orgId)) return c.json({ error: "Malformed id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await createGroup(orgId, session.userId, body, deps), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.patch("/orgs/:orgId/groups/:groupId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      await updateGroup(orgId, session.userId, groupId, body);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete("/orgs/:orgId/groups/:groupId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    try {
      const out = await deleteGroup(orgId, session.userId, groupId, deps);
      await skillsHint(orgId, out.skillsChanged);
      return c.json({ ok: true, disconnectedDocs: out.disconnectedDocs });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/orgs/:orgId/groups/:groupId/members", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      const out = await addGroupMembers(orgId, session.userId, groupId, body.userIds, deps);
      await skillsHint(orgId, out.skillsChanged);
      return c.json({ added: out.added });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete("/orgs/:orgId/groups/:groupId/members/:userId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId, userId } = c.req.param();
    if (![orgId, groupId, userId].every((x) => ID_RE.test(x))) return c.json({ error: "Malformed id" }, 400);
    try {
      const out = await removeGroupMember(orgId, session.userId, groupId, userId, deps);
      await skillsHint(orgId, out.skillsChanged);
      return c.json({ removed: out.removed, disconnectedDocs: out.disconnectedDocs });
    } catch (e) {
      return fail(c, e);
    }
  });

  // Ask first (2026-11-27): who a proposed group change would not reach
  // because of a setting just for them. Body: {access?: {resources, mode}} or
  // {addUserIds}. Writes nothing.
  app.post("/orgs/:orgId/groups/:groupId/held", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { access?: { resources?: unknown; mode?: unknown }; addUserIds?: unknown };
    try {
      const access = body.access && Array.isArray(body.access.resources) &&
        (body.access.mode === "open" || body.access.mode === "readonly" || body.access.mode === "private")
        ? { resources: body.access.resources as never, mode: body.access.mode as "open" | "readonly" | "private" }
        : undefined;
      const addUserIds = Array.isArray(body.addUserIds) ? body.addUserIds.filter((x): x is string => typeof x === "string") : undefined;
      return c.json({ held: await heldByOwnSettings({ orgId, actorUserId: session.userId, groupId, access, addUserIds }) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // "Let the group decide" for chosen people and places (removes their own
  // setting there, or saves a "may raise" mark), then reports what changed.
  app.post("/orgs/:orgId/groups/:groupId/let-decide", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown };
    try {
      const results = await letGroupDecide(
        { orgId, actorUserId: session.userId, groupId, entries: (body.entries ?? []) as never },
        deps,
      );
      return c.json({ results });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/orgs/:orgId/groups/:groupId/activity", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const role = await orgRole(orgId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "access_manager_required", message: "Only the vault owner or an admin can see this" }, 403);
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
    const { rows } = await pool.query<{
      occurred_at: Date;
      actor_user_id: string | null;
      actor_name: string | null;
      entity_type: string;
      action: string;
      before_state: Record<string, unknown> | null;
      after_state: Record<string, unknown> | null;
      target_name: string | null;
      target_email: string | null;
      path: string | null;
    }>(
      `SELECT a.occurred_at, a.actor_user_id, a.actor_name, a.entity_type, a.action,
              a.before_state, a.after_state, u.name AS target_name, u.email AS target_email,
              CASE coalesce(a.after_state->>'resourceType', a.before_state->>'resourceType')
                WHEN 'folder' THEN (SELECT f.path FROM folders f
                  WHERE f.id = coalesce(a.after_state->>'resourceId', a.before_state->>'resourceId'))
                WHEN 'file' THEN coalesce(
                  (SELECT n.rel_path FROM notes n WHERE n.deleted_at IS NULL
                     AND n.id = coalesce(a.after_state->>'resourceId', a.before_state->>'resourceId')),
                  (SELECT fi.path FROM files fi
                     WHERE fi.id = coalesce(a.after_state->>'resourceId', a.before_state->>'resourceId')))
                ELSE NULL
              END AS path
         FROM access_audit a
         LEFT JOIN "user" u ON a.entity_type = 'access_group_members'
              AND u.id = coalesce(a.after_state->>'userId', a.before_state->>'userId')
        WHERE a.organization_id = $1 AND (
              (a.entity_type IN ('access_groups', 'access_group_members') AND a.entity_id = $2)
           OR (a.entity_type = 'shares' AND (
                (a.after_state->>'principalType' = 'group' AND a.after_state->>'principalId' = $2)
             OR (a.before_state->>'principalType' = 'group' AND a.before_state->>'principalId' = $2))))
        ORDER BY a.id DESC
        LIMIT $3`,
      [orgId, groupId, limit],
    );
    return c.json({
      events: rows.map((r) => {
        const base = {
          at: new Date(r.occurred_at).toISOString(),
          by: r.actor_user_id ? { userId: r.actor_user_id, name: r.actor_name } : null,
        };
        if (r.entity_type === "access_group_members") {
          return {
            ...base,
            kind: r.action === "delete" ? "memberRemoved" : "memberAdded",
            person: { userId: String((r.after_state ?? r.before_state)?.userId ?? ""), name: r.target_name, email: r.target_email },
          };
        }
        if (r.entity_type === "shares") {
          const state = r.after_state ?? r.before_state;
          return {
            ...base,
            kind: r.action === "delete" ? "accessRemoved" : "accessGranted",
            permission: r.action === "delete" ? null : (r.after_state?.permission ?? null),
            resourceType: state?.resourceType ?? null,
            path: state?.resourceType === "vault" ? null : r.path,
          };
        }
        return {
          ...base,
          kind: r.action === "insert" ? "created" : r.action === "delete" ? "deleted" : "updated",
          name: (r.after_state ?? r.before_state)?.name ?? null,
        };
      }),
    });
  });

  app.get("/orgs/:orgId/groups/:groupId/skills", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { orgId, groupId } = c.req.param();
    if (!ID_RE.test(orgId) || !ID_RE.test(groupId)) return c.json({ error: "Malformed id" }, 400);
    const role = await orgRole(orgId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "access_manager_required", message: "Only the vault owner or an admin can see this" }, 403);
    }
    const group = await pool.query("SELECT 1 FROM access_groups WHERE id = $1 AND organization_id = $2", [groupId, orgId]);
    if (group.rowCount === 0) return c.json({ error: "group_not_found", message: "That group no longer exists" }, 404);
    const { rows } = await pool.query<{
      id: string; name: string; description: string; latest_version: number | null; level: string | null;
    }>(
      `SELECT s.id, s.name, s.draft_description AS description, s.latest_version, sga.level
         FROM skills s
         LEFT JOIN skill_group_access sga ON sga.skill_id = s.id AND sga.group_id = $2
        WHERE s.organization_id = $1 AND s.deleted_at IS NULL
        ORDER BY s.name`,
      [orgId, groupId],
    );
    return c.json({
      skills: rows.map((r) => ({
        skillId: r.id,
        name: r.name,
        description: r.description,
        latestVersion: r.latest_version,
        level: r.level === "required" || r.level === "optional" ? r.level : null,
      })),
    });
  });

  return app;
}
