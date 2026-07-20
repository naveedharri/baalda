import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import {
  docsForResource,
  orgRole,
  resolveResource,
} from "../../permissions/lookup.js";
import {
  buildAccessContext,
  resolveAccessForUser,
} from "../../permissions/resolver.js";
import { getSession } from "../session.js";

/**
 * Share management API (session-authenticated) — spec 04 §3/§4.
 * Create/list/revoke shares on folders/files. Authorized for workspace
 * owner/admin or the resource creator. On revoke we disconnect live sockets for
 * every affected doc (instant kill).
 */

export interface ShareDeps {
  /** Force-close live sync sockets for a doc (instant revocation). */
  disconnectDoc: (vaultId: string, docId: string) => void;
  /** Notify the vault channel that shares changed so subscribers re-evaluate
   *  their readable-doc set (spec 05 §3.1). Optional; no-op if unset. */
  onAclChanged?: (vaultId: string) => void;
}

export function createShareRoutes(deps: ShareDeps): Hono {
  const app = new Hono();

  async function canManage(
    userId: string,
    resourceType: "folder" | "file" | "workspace",
    resourceId: string,
  ): Promise<{
    ok: boolean;
    organizationId?: string;
    /** Vaults whose subscribers should re-evaluate on an ACL change. A folder/
     *  file touches one vault; a workspace grant touches all of the org's. */
    vaultIds?: string[];
    status?: number;
    error?: string;
  }> {
    const info = await resolveResource(resourceType, resourceId);
    if (!info) return { ok: false, status: 404, error: "Unknown resource" };
    const role = await orgRole(info.organizationId, userId);
    const isAdmin = role === "owner" || role === "admin";
    // Workspace posture (Open/Read-only/Private) is an owner/admin decision;
    // the per-resource "creator can manage" escape hatch doesn't apply.
    const isCreator =
      resourceType !== "workspace" &&
      info.createdBy !== null &&
      info.createdBy === userId;
    if (!isAdmin && !isCreator) {
      return { ok: false, status: 403, error: "Not allowed to manage shares here" };
    }
    const vaultIds =
      resourceType === "workspace"
        ? (
            await pool.query<{ id: string }>(
              "SELECT id FROM vaults WHERE organization_id = $1",
              [info.organizationId],
            )
          ).rows.map((r) => r.id)
        : [info.vaultId];
    return { ok: true, organizationId: info.organizationId, vaultIds };
  }

  // Create or update a share (upsert on the unique resource+principal key).
  // permission 'locked' is the deny overlay (spec 04 §3 extension): it caps
  // everyone it matches at read-only. principalType 'org' targets the whole
  // workspace (principalId may be omitted — it becomes the organization id).
  app.post("/shares", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const resourceType = body.resourceType;
    const resourceId = body.resourceId;
    const principalType = body.principalType ?? "user";
    const permission = body.permission;
    if (
      (resourceType !== "folder" && resourceType !== "file" && resourceType !== "workspace") ||
      typeof resourceId !== "string" ||
      (principalType !== "user" && principalType !== "org") ||
      (permission !== "view" && permission !== "edit" && permission !== "locked")
    ) {
      return c.json(
        {
          error:
            "resourceType(folder|file|workspace), resourceId, principalType(user|org), permission(view|edit|locked) required",
        },
        400,
      );
    }
    // On a folder/file, org-wide rows only make sense as locks; plain grants
    // stay per-user. A workspace resource is the exception: an org-wide
    // edit/view grant IS the "Open"/"Read-only" workspace posture.
    if (principalType === "org" && permission !== "locked" && resourceType !== "workspace") {
      return c.json({ error: "org-wide shares must be locks (permission=locked)" }, 400);
    }

    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const principalId =
      principalType === "org" ? gate.organizationId : body.principalId;
    if (typeof principalId !== "string" || !principalId) {
      return c.json({ error: "principalId required for user shares" }, 400);
    }

    // Locks are subsumption-aware: an Everyone/org lock on a resource makes any
    // per-user lock on the SAME resource redundant. Without this, a resource can
    // carry both an org lock and a user lock, and Unlock becomes misleading —
    // removing one leaves the resource locked by the other, so unlock appears to
    // do nothing. We keep a single authoritative lock per resource instead.
    if (permission === "locked" && principalType === "user") {
      // An org lock already covers everyone here — the per-user lock adds
      // nothing. No-op and report the effective (org) lock.
      const { rows: orgLock } = await pool.query<{ id: string }>(
        `SELECT id FROM shares
          WHERE resource_type = $1 AND resource_id = $2
            AND principal_type = 'org' AND permission = 'locked'
          LIMIT 1`,
        [resourceType, resourceId],
      );
      if (orgLock[0]) {
        return c.json(
          {
            id: orgLock[0].id,
            resourceType,
            resourceId,
            principalType: "org",
            principalId: gate.organizationId,
            permission: "locked",
            subsumed: true,
          },
          200,
        );
      }
    }

    const id = randomUUID();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO shares
         (id, workspace_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
       DO UPDATE SET permission = EXCLUDED.permission
       RETURNING id`,
      [
        id,
        gate.organizationId,
        resourceType,
        resourceId,
        principalType,
        principalId,
        permission,
        session.userId,
      ],
    );

    // An Everyone/org lock subsumes any per-user locks on the same resource —
    // drop them so a single Unlock actually unlocks. (Those users stay locked by
    // the org lock, so no access change and no socket kick is needed.)
    if (permission === "locked" && principalType === "org") {
      await pool.query(
        `DELETE FROM shares
          WHERE resource_type = $1 AND resource_id = $2
            AND principal_type = 'user' AND permission = 'locked'`,
        [resourceType, resourceId],
      );
    }

    // Any downgrade to read-only must reach live editors immediately — force
    // reconnect so open sessions come back with fresh (now read-only) sync
    // tokens, same as revocation does. This covers a lock, a per-user edit→view
    // change, and a workspace Open→Read-only posture flip (all land as
    // view/locked). An 'edit' grant only widens access, so it needs no kick;
    // the onAclChanged push below lets background subscribers pick it up.
    // Reconnect re-mints each client's own permission, so a peer who still has
    // edit gets edit back — this only tightens editors that should go read-only.
    if (permission === "locked" || permission === "view") {
      const docs = await docsForResource(resourceType, resourceId);
      for (const d of docs) {
        deps.disconnectDoc(d.vaultId, d.docId);
      }
    }

    // A new grant can expand a user's readable set — tell background subscribers.
    for (const v of gate.vaultIds ?? []) deps.onAclChanged?.(v);

    return c.json(
      { id: rows[0].id, resourceType, resourceId, principalType, principalId, permission },
      201,
    );
  });

  // List every lock in a vault. Any member of the vault's workspace may read
  // these — the client renders lock badges in the tree from this.
  app.get("/vaults/:vaultId/locks", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");

    const { rows: vrows } = await pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM vaults WHERE id = $1",
      [vaultId],
    );
    const org = vrows[0]?.organization_id;
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this workspace" }, 403);

    const { rows } = await pool.query(
      `SELECT s.id, s.resource_type, s.resource_id, s.principal_type, s.principal_id,
              s.permission, s.created_by, s.created_at
         FROM shares s
        WHERE s.permission = 'locked'
          AND (
            (s.resource_type = 'folder' AND s.resource_id IN
               (SELECT id FROM folders WHERE vault_id = $1))
            OR (s.resource_type = 'file' AND s.resource_id IN
               (SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
                UNION SELECT id FROM files WHERE vault_id = $1))
          )`,
      [vaultId],
    );
    return c.json({ locks: rows });
  });

  // List shares for a resource.
  app.get("/shares", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const resourceType = c.req.query("resourceType");
    const resourceId = c.req.query("resourceId");
    if (
      (resourceType !== "folder" && resourceType !== "file" && resourceType !== "workspace") ||
      !resourceId
    ) {
      return c.json({ error: "resourceType and resourceId query params required" }, 400);
    }
    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const { rows } = await pool.query(
      `SELECT id, resource_type, resource_id, principal_type, principal_id, permission, created_by, created_at
         FROM shares WHERE resource_type = $1 AND resource_id = $2`,
      [resourceType, resourceId],
    );
    return c.json({ shares: rows });
  });

  // Resolve WHO can access one resource: every workspace member with their
  // effective permission (role + shares + inherited folder shares, capped by
  // locks) and its source. Powers the "who can access" view. Same canManage
  // gate as listing shares.
  app.get("/resolve-access", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const resourceType = c.req.query("resourceType");
    const resourceId = c.req.query("resourceId");
    if ((resourceType !== "folder" && resourceType !== "file") || !resourceId) {
      return c.json({ error: "resourceType and resourceId query params required" }, 400);
    }
    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const ctx = await buildAccessContext(resourceType, resourceId);
    if (!ctx) return c.json({ error: "Unknown resource" }, 404);

    const { rows: memberRows } = await pool.query<{
      user_id: string;
      role: string;
      name: string | null;
      email: string | null;
    }>(
      `SELECT m."userId" AS user_id, m.role, u.name, u.email
         FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1`,
      [ctx.organizationId],
    );

    const members = await Promise.all(
      memberRows.map(async (m) => {
        const { permission, capped } = await resolveAccessForUser(ctx, m.user_id, m.role);
        return {
          userId: m.user_id,
          name: m.name,
          email: m.email,
          role: m.role,
          permission,
          capped,
        };
      }),
    );
    return c.json({ members });
  });

  // Revoke a share, then instant-kill affected live sockets.
  app.delete("/shares/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const shareId = c.req.param("id");

    const { rows } = await pool.query<{
      resource_type: "folder" | "file" | "workspace";
      resource_id: string;
    }>("SELECT resource_type, resource_id FROM shares WHERE id = $1", [shareId]);
    const share = rows[0];
    if (!share) return c.json({ error: "Share not found" }, 404);

    const gate = await canManage(session.userId, share.resource_type, share.resource_id);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    // Compute affected docs BEFORE deleting (folder subtree join needs the rows).
    const docs = await docsForResource(share.resource_type, share.resource_id);
    await pool.query("DELETE FROM shares WHERE id = $1", [shareId]);

    for (const d of docs) {
      deps.disconnectDoc(d.vaultId, d.docId);
    }
    // Revoking a grant can shrink a user's readable set — background subscribers
    // re-evaluate and drop the now-inaccessible docs.
    for (const v of gate.vaultIds ?? []) deps.onAclChanged?.(v);
    return c.json({ revoked: shareId, disconnectedDocs: docs.length });
  });

  return app;
}
