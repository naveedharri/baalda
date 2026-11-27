// SPDX-License-Identifier: Apache-2.0
import { setAuditActor, withAuditActor } from "../audit/access.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { docsForResource, docsForResources, orgRole, resolveResource } from "./lookup.js";
import { ancestorFolderIds } from "./resolver.js";

export type AccessMode = "private" | "readonly" | "open";
export type AccessResource = {
  resourceType: "folder" | "file" | "vault";
  resourceId: string;
};
export type AccessAudience =
  | { type: "org" }
  | { type: "users"; userIds: string[] }
  /** One access group (migration 097). `open` writes an `edit` row,
   *  `readonly` a `view` row; `private` writes a group `denied` row where the
   *  group reaches the item from above (migration 100: its deepest row
   *  decides), else just removes what the group gave there. */
  | { type: "group"; groupId: string };

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export class AccessManagementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Default access (the org row on the vault resource) is fixed (2026-11-25):
 * new vaults start sealed, converted vaults were sealed by migration 101, and a
 * vault that was never shared keeps "members keep what they write". No surface
 * may change it any more — sealing a never-shared vault would take every
 * member's own notes off their disk. Access comes from groups and personal
 * levels instead. Shared by `POST /shares`, `DELETE /shares/:id`,
 * `PUT team-access`, the bulk API and MCP, so they cannot disagree.
 */
export const DEFAULT_ACCESS_FIXED_MESSAGE =
  "Default access can't be changed any more. Give people access with access groups or their own level.";

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

/**
 * May a caller with `viewerRole` change the access of a member with
 * `targetRole`? The one rule for every per-person access write (bulk access,
 * per-user `POST /shares`, the member share reset), mirrored by the desktop's
 * `lib/membersAccess.ts canManageMemberAccess`:
 *
 *   - owner: anyone, themselves included (their own row is the way back in);
 *   - admin: everyone except the owner (plain members, other admins and
 *     themselves) — decided 2026-10-09; role changes and removal keep the
 *     stricter matrix where an admin never touches another admin;
 *   - member: nobody.
 */
export function canManageMemberAccess(
  viewerRole: string | null | undefined,
  targetRole: string | null | undefined,
  isSelf: boolean,
): boolean {
  if (viewerRole === "owner") return true;
  if (viewerRole === "admin") return isSelf || targetRole === "member" || targetRole === "admin";
  return false;
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
  db: pg.Pool = defaultPool,
): Promise<AccessMode> {
  await requireAccessManager(organizationId, userId, db);
  // New members always start on Only what's shared (2026-11-25): they get
  // access from the groups they join. Older desktops still offer the setting.
  if (mode !== "private") {
    throw new AccessManagementError(
      "New members start on No access unless you give them a level or add them to an access group.",
      409,
      "join_default_fixed",
    );
  }
  return withAuditActor(userId, async (client) => {
    await ensureSettings(client, organizationId);
    const { rows } = await client.query<{ join_default: AccessMode }>(
      `UPDATE organization_access_settings
          SET join_default = $2, updated_at = now()
        WHERE organization_id = $1
        RETURNING join_default`,
      [organizationId, mode],
    );
    if (!rows[0]) throw new AccessManagementError("Vault not found", 404, "vault_not_found");
    return rows[0].join_default;
  }, db);
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
  actorUserId: string,
): Promise<string[]> {
  if (audience.type === "org") return [];
  if (audience.type === "group") {
    const { rowCount } = await db.query(
      "SELECT 1 FROM access_groups WHERE id = $1 AND organization_id = $2",
      [audience.groupId, organizationId],
    );
    if (!rowCount) throw new AccessManagementError("Unknown group", 404, "group_not_found");
    return [];
  }
  const ids = [...new Set(audience.userIds.filter(Boolean))];
  if (ids.length === 0 || ids.length > 500) {
    throw new AccessManagementError(
      "userIds must contain between 1 and 500 members",
      400,
      "invalid_audience",
    );
  }
  const { rows } = await db.query<{ user_id: string; role: string }>(
    `SELECT "userId" AS user_id, role FROM member
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
  const actorRole = await orgRole(organizationId, actorUserId, db);
  for (const row of rows) {
    if (!canManageMemberAccess(actorRole, row.role, row.user_id === actorUserId)) {
      throw new AccessManagementError(
        "An admin can only change the access of members or themselves",
        403,
        "access_manager_required",
      );
    }
  }
  return ids;
}

async function clearResourceOverrides(
  db: Queryable,
  organizationId: string,
  resource: AccessResource,
  userIds: string[],
  /** Clear only this group's rows (a group audience). */
  groupId: string | null = null,
  /** Receives the permission of every row removed (lets a group write tell a narrowing apart). */
  removed?: string[],
): Promise<number> {
  // The vault branch has no `$2` (the resource IS the org), so its audience is
  // `$2`; a gap in the numbering leaves Postgres unable to type the unused slot.
  // The Everyone (org) audience never clears a GROUP's rows: those belong to the
  // group's own Access tab.
  if (groupId !== null) userIds = [groupId];
  const principal = groupId !== null ? "group" : "user";
  const audienceAt = (n: number) =>
    userIds.length
      ? `AND principal_type = '${principal}' AND principal_id = ANY($${n}::text[])`
      : "AND principal_type <> 'group'";
  const audience = audienceAt(3);
  if (resource.resourceType === "file") {
    const result = await db.query(
      `DELETE FROM shares
        WHERE org_id = $1 AND resource_type = 'file' AND resource_id = $2 ${audience}
       RETURNING permission`,
      userIds.length ? [organizationId, resource.resourceId, userIds] : [organizationId, resource.resourceId],
    );
    for (const row of result.rows as Array<{ permission: string }>) removed?.push(row.permission);
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
          ${audience}
       RETURNING permission`,
      userIds.length ? [organizationId, resource.resourceId, userIds] : [organizationId, resource.resourceId],
    );
    for (const row of result.rows as Array<{ permission: string }>) removed?.push(row.permission);
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
        ) ${audienceAt(2)}
     RETURNING s.permission`,
    userIds.length ? [organizationId, userIds] : [organizationId],
  );
  for (const row of result.rows as Array<{ permission: string }>) removed?.push(row.permission);
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
  if (input.audience.type === "org" && resources.some((r) => r.resourceType === "vault")) {
    throw new AccessManagementError(DEFAULT_ACCESS_FIXED_MESSAGE, 409, "default_access_fixed");
  }
  await validateResources(db, input.organizationId, resources);
  const selectedUsers = await validateAudience(db, input.organizationId, input.audience, input.actorUserId);
  const currentMembers = await db.query<{ user_id: string }>(
    `SELECT "userId" AS user_id FROM member WHERE "organizationId" = $1`,
    [input.organizationId],
  );

  const client = await db.connect();
  let cleared = 0;
  let groupDenied = false;
  const removedPermissions: string[] = [];
  try {
    await client.query("BEGIN");
    await setAuditActor(client, input.actorUserId);
    // Hold the group while its rows are written: a delete at the same moment
    // either waits for this write (and its trigger then removes these rows
    // too) or has already gone, and this write is refused. Without the lock a
    // write could land after the delete, leaving rows for a group that no
    // longer exists.
    if (input.audience.type === "group") {
      const { rowCount } = await client.query(
        "SELECT 1 FROM access_groups WHERE id = $1 AND organization_id = $2 FOR SHARE",
        [input.audience.groupId, input.organizationId],
      );
      if (!rowCount) throw new AccessManagementError("Unknown group", 404, "group_not_found");
    }
    const revision = await nextAccessRevision(client, input.organizationId);
    for (const resource of resources) {
      cleared += await clearResourceOverrides(
        client,
        input.organizationId,
        resource,
        selectedUsers,
        input.audience.type === "group" ? input.audience.groupId : null,
        removedPermissions,
      );
    }

    const wholeVault = resources[0].resourceType === "vault";
    if (wholeVault && input.audience.type !== "group") {
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

    // A group's No access is the absence of a row, unless the group still
    // reaches the item from above (a folder or the vault): then a `denied` row
    // stops that group's reach from here down (resolver `rowsGroupGrant`:
    // within one group the deepest row wins).
    const groupNoAccess: AccessResource[] = [];
    if (input.audience.type === "group" && input.mode === "private") {
      for (const resource of resources) {
        if (resource.resourceType === "vault") continue;
        if (await groupReachesFromAbove(client, input.organizationId, input.audience.groupId, resource)) {
          groupNoAccess.push(resource);
        }
      }
    }
    for (const resource of groupNoAccess) {
      groupDenied = true;
      await client.query(
        `INSERT INTO shares
           (id, org_id, resource_type, resource_id, principal_type, principal_id,
            permission, created_by, access_revision)
         VALUES ($1,$2,$3,$4,'group',$5,'denied',$6,$7)`,
        [randomUUID(), input.organizationId, resource.resourceType, resource.resourceId,
          (input.audience as { groupId: string }).groupId, input.actorUserId, revision],
      );
    }
    const principalIds =
      input.audience.type === "org"
        ? [input.organizationId]
        : input.audience.type === "group"
          ? input.mode === "private"
            ? []
            : [input.audience.groupId]
          : selectedUsers;
    const principalType =
      input.audience.type === "org" ? "org" : input.audience.type === "group" ? "group" : "user";
    for (const resource of resources) {
      // The vault's existing `view` posture already has grant+cap semantics in
      // `vaultBaseline`; item rows need the combined `readonly` permission.
      // A group row is a pure grant: `view` or `edit`, never a cap.
      const permission =
        input.audience.type === "group"
          ? input.mode === "open" ? "edit" : "view"
          : resource.resourceType === "vault" && input.mode === "readonly"
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
  // A group row only ADDS, so a group write narrows nobody unless it removed a
  // row that gave more than the new level (edit → view, anything → No access).
  // Widening arrives by itself on the next token mint, like team-access.
  const groupRank = (permission: string) => (permission === "edit" ? 2 : permission === "view" ? 1 : 0);
  const narrowed =
    input.audience.type !== "group" ||
    groupDenied ||
    removedPermissions.some(
      (permission) => groupRank(permission) > (input.mode === "open" ? 2 : input.mode === "readonly" ? 1 : 0),
    );
  for (const doc of narrowed ? docs : []) {
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
      input.audience.type === "org"
        ? currentMembers.rows.length
        : input.audience.type === "group"
          ? (
              await db.query("SELECT 1 FROM access_group_members WHERE group_id = $1", [input.audience.groupId])
            ).rowCount ?? 0
          : selectedUsers.length,
    disconnectedDocs,
  };
}

/** True when `groupId` holds a `view`/`edit` row on an ANCESTOR of the
 *  resource (a parent folder, or the vault), i.e. it reaches it from above. */
async function groupReachesFromAbove(
  db: pg.PoolClient,
  organizationId: string,
  groupId: string,
  resource: AccessResource,
): Promise<boolean> {
  const { rows: loc } = await db.query<{ folder_id: string | null }>(
    resource.resourceType === "folder"
      ? "SELECT parent_id AS folder_id FROM folders WHERE id = $1"
      : `SELECT folder_id FROM notes WHERE id = $1 AND deleted_at IS NULL
         UNION ALL SELECT folder_id FROM files WHERE id = $1 LIMIT 1`,
    [resource.resourceId],
  );
  const chain = await ancestorFolderIds(db, loc[0]?.folder_id ?? null);
  const { rowCount } = await db.query(
    `SELECT 1 FROM shares
      WHERE principal_type = 'group' AND principal_id = $1 AND permission IN ('view', 'edit')
        AND ((resource_type = 'vault' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[])))
      LIMIT 1`,
    [groupId, organizationId, chain],
  );
  return (rowCount ?? 0) > 0;
}
