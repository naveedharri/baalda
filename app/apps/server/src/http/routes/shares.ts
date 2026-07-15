import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import {
  docsForResource,
  orgRole,
  resolveResource,
} from "../../permissions/lookup.js";
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
    resourceType: "folder" | "file",
    resourceId: string,
  ): Promise<{
    ok: boolean;
    organizationId?: string;
    vaultId?: string;
    status?: number;
    error?: string;
  }> {
    const info = await resolveResource(resourceType, resourceId);
    if (!info) return { ok: false, status: 404, error: "Unknown resource" };
    const role = await orgRole(info.organizationId, userId);
    const isAdmin = role === "owner" || role === "admin";
    const isCreator = info.createdBy !== null && info.createdBy === userId;
    if (!isAdmin && !isCreator) {
      return { ok: false, status: 403, error: "Not allowed to manage shares here" };
    }
    return { ok: true, organizationId: info.organizationId, vaultId: info.vaultId };
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
      (resourceType !== "folder" && resourceType !== "file") ||
      typeof resourceId !== "string" ||
      (principalType !== "user" && principalType !== "org") ||
      (permission !== "view" && permission !== "edit" && permission !== "locked")
    ) {
      return c.json(
        {
          error:
            "resourceType(folder|file), resourceId, principalType(user|org), permission(view|edit|locked) required",
        },
        400,
      );
    }
    // Org-wide rows only make sense as locks; plain grants stay per-user.
    if (principalType === "org" && permission !== "locked") {
      return c.json({ error: "org-wide shares must be locks (permission=locked)" }, 400);
    }

    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const principalId =
      principalType === "org" ? gate.organizationId : body.principalId;
    if (typeof principalId !== "string" || !principalId) {
      return c.json({ error: "principalId required for user shares" }, 400);
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

    // A new lock downgrades live editors — force reconnect so sessions come
    // back with their now read-only sync tokens, same as revocation does.
    if (permission === "locked") {
      const docs = await docsForResource(resourceType, resourceId);
      for (const d of docs) {
        deps.disconnectDoc(d.vaultId, d.docId);
      }
    }

    // A new grant can expand a user's readable set — tell background subscribers.
    if (gate.vaultId) deps.onAclChanged?.(gate.vaultId);

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
    if ((resourceType !== "folder" && resourceType !== "file") || !resourceId) {
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

  // Revoke a share, then instant-kill affected live sockets.
  app.delete("/shares/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const shareId = c.req.param("id");

    const { rows } = await pool.query<{
      resource_type: "folder" | "file";
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
    if (gate.vaultId) deps.onAclChanged?.(gate.vaultId);
    return c.json({ revoked: shareId, disconnectedDocs: docs.length });
  });

  return app;
}
