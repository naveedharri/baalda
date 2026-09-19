// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { docsForResource, docsForResources, orgRole, resolveResource } from "./lookup.js";

export type AccessMode = "private" | "readonly" | "open";
export type AccessResource = {
  resourceType: "folder" | "file" | "vault";
  resourceId: string;
};
export type AccessAudience = { type: "org" } | { type: "users"; userIds: string[] };

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export class AccessManagementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface AccessChangeDeps {
  disconnectDoc?: (vaultId: string, docId: string) => void;
  onAclChanged?: (vaultId: string) => void;
}

export async function requireAccessManager(
  organizationId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  const role = await orgRole(organizationId, userId, db);
  if (role !== "owner" && role !== "admin") {
    throw new AccessManagementError(
      "Only the vault owner or an admin can manage access",
      403,
      "access_manager_required",
    );
  }
}

async function ensureSettings(db: Queryable, organizationId: string): Promise<void> {
  await db.query(
    `INSERT INTO organization_access_settings (organization_id)
     SELECT id FROM organization WHERE id = $1
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId],
  );
}

export async function getJoinDefault(
  organizationId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<AccessMode> {
  await requireAccessManager(organizationId, userId, db);
  await ensureSettings(db, organizationId);
  const { rows } = await db.query<{ join_default: AccessMode }>(
    "SELECT join_default FROM organization_access_settings WHERE organization_id = $1",
    [organizationId],
  );
  if (!rows[0]) throw new AccessManagementError("Vault not found", 404, "vault_not_found");
  return rows[0].join_default;
}

export async function setJoinDefault(
  organizationId: string,
  userId: string,
  mode: AccessMode,
  db: Queryable = defaultPool,
): Promise<AccessMode> {
  await requireAccessManager(organizationId, userId, db);
  await ensureSettings(db, organizationId);
  const { rows } = await db.query<{ join_default: AccessMode }>(
    `UPDATE organization_access_settings
        SET join_default = $2, updated_at = now()
      WHERE organization_id = $1
      RETURNING join_default`,
    [organizationId, mode],
  );
  if (!rows[0]) throw new AccessManagementError("Vault not found", 404, "vault_not_found");
  return rows[0].join_default;
}

/** Allocate one ordering point for an ACL mutation within an organization. */
export async function nextAccessRevision(db: Queryable, organizationId: string): Promise<number> {
  await ensureSettings(db, organizationId);
  const { rows } = await db.query<{ access_revision: string | number }>(
    `UPDATE organization_access_settings
        SET access_revision = access_revision + 1, updated_at = now()
      WHERE organization_id = $1
      RETURNING access_revision`,
    [organizationId],
  );
  if (!rows[0]) throw new AccessManagementError("Vault not found", 404, "vault_not_found");
  return Number(rows[0].access_revision);
}

async function validateResources(
  db: Queryable,
  organizationId: string,
  resources: AccessResource[],
): Promise<void> {
  if (resources.length === 0 || resources.length > 1000) {
    throw new AccessManagementError(
      "resources must contain between 1 and 1000 items",
      400,
      "invalid_resources",
    );
  }
  const vaultRows = resources.filter((r) => r.resourceType === "vault");
  if (vaultRows.length && (resources.length !== 1 || vaultRows[0].resourceId !== organizationId)) {
    throw new AccessManagementError(
      "The whole vault must be selected by itself",
      400,
      "mixed_vault_selection",
    );
  }
  for (const resource of resources) {
    const info = await resolveResource(resource.resourceType, resource.resourceId, db);
    if (!info || info.organizationId !== organizationId) {
      throw new AccessManagementError(
        `Unknown resource: ${resource.resourceId}`,
        404,
        "resource_not_found",
      );
    }
  }
}

async function validateAudience(
  db: Queryable,
  organizationId: string,
  audience: AccessAudience,
): Promise<string[]> {
  if (audience.type === "org") return [];
  const ids = [...new Set(audience.userIds.filter(Boolean))];
  if (ids.length === 0 || ids.length > 500) {
    throw new AccessManagementError(
      "userIds must contain between 1 and 500 members",
      400,
      "invalid_audience",
    );
  }
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT "userId" AS user_id FROM member
      WHERE "organizationId" = $1 AND "userId" = ANY($2::text[])`,
    [organizationId, ids],
  );
  if (rows.length !== ids.length) {
    throw new AccessManagementError(
      "Every selected person must be a current vault member",
      404,
      "member_not_found",
    );
  }
  return ids;
}

async function clearResourceOverrides(
  db: Queryable,
  organizationId: string,
  resource: AccessResource,
  userIds: string[],
): Promise<number> {
  const audience = userIds.length
    ? `AND principal_type = 'user' AND principal_id = ANY($3::text[])`
    : "";
  if (resource.resourceType === "file") {
    const result = await db.query(
      `DELETE FROM shares
        WHERE org_id = $1 AND resource_type = 'file' AND resource_id = $2 ${audience}`,
      userIds.length ? [organizationId, resource.resourceId, userIds] : [organizationId, resource.resourceId],
    );
    return result.rowCount ?? 0;
  }
  if (resource.resourceType === "folder") {
    const result = await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM folders WHERE id = $2
         UNION
         SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
       ), target_files AS (
         SELECT id FROM notes WHERE folder_id IN (SELECT id FROM subtree)
         UNION SELECT id FROM files WHERE folder_id IN (SELECT id FROM subtree)
       )
       DELETE FROM shares
        WHERE org_id = $1
          AND ((resource_type = 'folder' AND resource_id IN (SELECT id FROM subtree))
            OR (resource_type = 'file' AND resource_id IN (SELECT id FROM target_files)))
          ${audience}`,
      userIds.length ? [organizationId, resource.resourceId, userIds] : [organizationId, resource.resourceId],
    );
    return result.rowCount ?? 0;
  }

  const result = await db.query(
    `DELETE FROM shares s
      WHERE s.org_id = $1
        AND (
          (s.resource_type = 'vault' AND s.resource_id = $1)
          OR (s.resource_type = 'folder' AND EXISTS (
              SELECT 1 FROM folders f JOIN vaults v ON v.id = f.vault_id
               WHERE f.id = s.resource_id AND v.organization_id = $1))
          OR (s.resource_type = 'file' AND EXISTS (
              SELECT 1 FROM (
                SELECT id, vault_id FROM notes UNION ALL SELECT id, vault_id FROM files
              ) d JOIN vaults v ON v.id = d.vault_id
               WHERE d.id = s.resource_id AND v.organization_id = $1))
        ) ${audience}`,
    userIds.length ? [organizationId, resource.resourceId, userIds] : [organizationId],
  );
  return result.rowCount ?? 0;
}

function storedPermission(mode: AccessMode): "denied" | "readonly" | "edit" {
  return mode === "private" ? "denied" : mode === "readonly" ? "readonly" : "edit";
}

export async function applyBulkAccess(
  input: {
    organizationId: string;
    actorUserId: string;
    resources: AccessResource[];
    audience: AccessAudience;
    mode: AccessMode;
  },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<{
  mode: AccessMode;
  resourcesChanged: number;
  overridesCleared: number;
  membersAffected: number;
  disconnectedDocs: number;
}> {
  const resources = [
    ...new Map(
      input.resources.map((resource) => [
        `${resource.resourceType}\u0000${resource.resourceId}`,
        resource,
      ]),
    ).values(),
  ];
  await requireAccessManager(input.organizationId, input.actorUserId, db);
  await validateResources(db, input.organizationId, resources);
  const selectedUsers = await validateAudience(db, input.organizationId, input.audience);
  const currentMembers = await db.query<{ user_id: string }>(
    `SELECT "userId" AS user_id FROM member WHERE "organizationId" = $1`,
    [input.organizationId],
  );

  const client = await db.connect();
  let cleared = 0;
  try {
    await client.query("BEGIN");
    const revision = await nextAccessRevision(client, input.organizationId);
    for (const resource of resources) {
      cleared += await clearResourceOverrides(
        client,
        input.organizationId,
        resource,
        selectedUsers,
      );
    }

    const wholeVault = resources[0].resourceType === "vault";
    if (wholeVault) {
      if (input.audience.type === "org") {
        await client.query(
          "DELETE FROM member_access_snapshots WHERE organization_id = $1",
          [input.organizationId],
        );
      } else {
        await client.query(
          `DELETE FROM member_access_snapshots
            WHERE organization_id = $1 AND user_id = ANY($2::text[])`,
          [input.organizationId, selectedUsers],
        );
      }
    }

    const principalIds =
      input.audience.type === "org" ? [input.organizationId] : selectedUsers;
    const principalType = input.audience.type === "org" ? "org" : "user";
    for (const resource of resources) {
      // The vault's existing `view` posture already has grant+cap semantics in
      // `vaultBaseline`; item rows need the combined `readonly` permission.
      const permission =
        resource.resourceType === "vault" && input.mode === "readonly"
          ? "view"
          : storedPermission(input.mode);
      for (const principalId of principalIds) {
        await client.query(
          `INSERT INTO shares
             (id, org_id, resource_type, resource_id, principal_type, principal_id,
              permission, created_by, access_revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            input.organizationId,
            resource.resourceType,
            resource.resourceId,
            principalType,
            principalId,
            permission,
            input.actorUserId,
            revision,
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const wholeVault = resources[0].resourceType === "vault";
  const docs = wholeVault
    ? await docsForResource("vault", input.organizationId, db)
    : await docsForResources(
        resources.filter(
          (resource): resource is AccessResource & { resourceType: "folder" | "file" } =>
            resource.resourceType !== "vault",
        ),
        db,
      );
  let disconnectedDocs = 0;
  // Every mode can narrow somebody after replacement, so re-auth all affected
  // editors. A transport failure must not roll back the committed ACL.
  for (const doc of docs) {
    try {
      deps.disconnectDoc?.(doc.vaultId, doc.docId);
      disconnectedDocs += deps.disconnectDoc ? 1 : 0;
    } catch {
      // best effort
    }
  }
  for (const vaultId of new Set(docs.map((doc) => doc.vaultId))) deps.onAclChanged?.(vaultId);

  return {
    mode: input.mode,
    resourcesChanged: resources.length,
    overridesCleared: cleared,
    membersAffected:
      input.audience.type === "org" ? currentMembers.rows.length : selectedUsers.length,
    disconnectedDocs,
  };
}
