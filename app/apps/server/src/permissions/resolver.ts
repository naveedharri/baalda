import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * Effective-permission resolver (spec 04 §3, plus locks).
 *
 *   1. Workspace owner/admin  -> `edit` on everything in the workspace.
 *   2. Else take the MAX of: a share on the file itself, a share on a
 *      containing folder (walking parent_id up to the root), and a
 *      workspace-scoped grant (org-wide "Open"/"Read-only", or per-user).
 *   3. `edit > view > none`. Folder grants inherit to descendants; a file
 *      share can only RAISE permission. No matching grant -> `none`.
 *
 * A plain `member` inherits the workspace grant (Open by default) and so gets
 * `edit`; with no grant at all it has no content access (`none`).
 *
 * Locks (permission = 'locked') are a DENY overlay resolved AFTER the rules
 * above: when a lock matches the doc or any ancestor folder — for this user
 * (principal_type 'user') or the whole workspace (principal_type 'org') — the
 * result is capped at `view`. Owners/admins are capped too (the point of a
 * lock is protecting content from accidental edits); they can still unlock
 * via the shares API. A lock never GRANTS access: `none` stays `none`.
 */
export type Permission = "edit" | "view" | "none";

const RANK: Record<Permission, number> = { none: 0, view: 1, edit: 2 };

export function maxPermission(a: Permission, b: Permission): Permission {
  return RANK[a] >= RANK[b] ? a : b;
}

type Queryable = Pick<pg.Pool, "query">;

interface DocLocation {
  vaultId: string;
  folderId: string | null;
  organizationId: string;
}

/**
 * Locate a doc's vault/folder/workspace. A doc_id maps to a `notes` row
 * (rich registry) or a `files` row (id == doc_id); we accept either.
 */
async function locateDoc(
  db: Queryable,
  docId: string,
): Promise<DocLocation | null> {
  const { rows } = await db.query<{
    vault_id: string;
    folder_id: string | null;
    organization_id: string;
  }>(
    `SELECT loc.vault_id, loc.folder_id, v.organization_id
       FROM (
         SELECT vault_id, folder_id FROM notes  WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT vault_id, folder_id FROM files  WHERE id = $1
       ) loc
       JOIN vaults v ON v.id = loc.vault_id
      LIMIT 1`,
    [docId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    folderId: row.folder_id,
    organizationId: row.organization_id,
  };
}

/** Walk parent_id up from a folder, collecting all ancestor folder ids (inclusive). */
export async function ancestorFolderIds(
  db: Queryable,
  folderId: string | null,
): Promise<string[]> {
  if (!folderId) return [];
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
     )
     SELECT id FROM chain`,
    [folderId],
  );
  return rows.map((r) => r.id);
}

async function memberRole(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Highest share permission for a user across a file (if `docId` is set), a set
 * of folders, and the workspace itself. Passing `docId = null` resolves a
 * folder resource directly: only the folder rows in `folderIds` (the folder
 * itself + its ancestors) match.
 *
 * Grants come from three scopes, all combined with highest-wins:
 *   - per-user file / folder shares (the classic ACL);
 *   - a workspace-scoped grant (resource_type 'workspace', resource_id =
 *     `organizationId`) — either org-wide (`principal_type 'org'`, the "Open"/
 *     "Read-only" default) or for this user specifically. A workspace grant is
 *     the only thing that reaches notes at the vault root (folder_id NULL),
 *     which have no folder to hang a share on.
 */
async function sharePermission(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
  organizationId: string,
  isMember: boolean,
): Promise<Permission> {
  // The org-wide ("Open"/"Read-only") grant applies ONLY to actual workspace
  // members — never to outsiders who merely know a doc id. Per-user grants are
  // inherently scoped to the user, so they need no membership gate.
  const orgGrantClause = isMember
    ? "OR (resource_type = 'workspace' AND resource_id = $4 AND principal_type = 'org')"
    : "";
  // $2 (the doc id) is always referenced with an explicit cast + null guard so
  // Postgres can infer its type even for a folder resource, where docId is null
  // and the file branch is inert.
  const { rows } = await db.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE permission IN ('view', 'edit')
        AND (
          (principal_type = 'user' AND principal_id = $1 AND (
            ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
            OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
            OR (resource_type = 'workspace' AND resource_id = $4)
          ))
          ${orgGrantClause}
        )`,
    [userId, docId, folderIds, organizationId],
  );
  let best: Permission = "none";
  for (const r of rows) {
    if (r.permission === "edit" || r.permission === "view") {
      best = maxPermission(best, r.permission);
    }
  }
  return best;
}

/**
 * True when a lock row covers this resource (a file when `docId` is set, plus
 * any folder in `folderIds`) for this user or the whole workspace.
 */
export async function isLocked(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
): Promise<boolean> {
  // $2 (doc id) is always referenced with a cast + null guard so Postgres can
  // infer its type for a folder resource (docId null → file branch inert).
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'locked'
        AND (
          principal_type = 'org'
          OR (principal_type = 'user' AND principal_id = $1)
        )
        AND (
          ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [userId, docId, folderIds],
  );
  return rows.length > 0;
}

export async function effectivePermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const loc = await locateDoc(db, docId);
  if (!loc) return "none";

  const folderIds = await ancestorFolderIds(db, loc.folderId);

  const role = await memberRole(db, loc.organizationId, userId);
  let granted: Permission;
  if (role === "owner" || role === "admin") {
    granted = "edit";
  } else {
    granted = await sharePermission(
      db,
      userId,
      docId,
      folderIds,
      loc.organizationId,
      role !== null, // isMember — gates the org-wide grant
    );
  }

  // Deny overlay: a matching lock caps at view; it never grants.
  if (granted !== "none" && (await isLocked(db, userId, docId, folderIds))) {
    return "view";
  }
  return granted;
}

/**
 * Precomputed context for resolving many users against ONE resource (used by the
 * "who can access" view). Built once, then reused per member so we don't re-walk
 * the folder ancestry for each user.
 *
 * - file resource:   `docId` = the doc id, `folderIds` = ancestors of its folder.
 * - folder resource: `docId` = null,       `folderIds` = the folder + its ancestors.
 */
export interface AccessContext {
  organizationId: string;
  docId: string | null;
  folderIds: string[];
}

export interface ResolvedAccess {
  permission: Permission;
  /** True when a lock reduced an otherwise-`edit` member down to `view`. */
  capped: boolean;
}

export async function buildAccessContext(
  resourceType: "folder" | "file",
  resourceId: string,
  db: Queryable = defaultPool,
): Promise<AccessContext | null> {
  if (resourceType === "file") {
    const loc = await locateDoc(db, resourceId);
    if (!loc) return null;
    return {
      organizationId: loc.organizationId,
      docId: resourceId,
      folderIds: await ancestorFolderIds(db, loc.folderId),
    };
  }
  // folder: resolve its workspace, then walk itself + ancestors.
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT v.organization_id
       FROM folders f JOIN vaults v ON v.id = f.vault_id
      WHERE f.id = $1 LIMIT 1`,
    [resourceId],
  );
  const org = rows[0]?.organization_id;
  if (!org) return null;
  return {
    organizationId: org,
    docId: null,
    folderIds: await ancestorFolderIds(db, resourceId),
  };
}

/** Resolve one user's effective access against a prebuilt {@link AccessContext}. */
export async function resolveAccessForUser(
  ctx: AccessContext,
  userId: string,
  role: string | null,
  db: Queryable = defaultPool,
): Promise<ResolvedAccess> {
  const granted: Permission =
    role === "owner" || role === "admin"
      ? "edit"
      : await sharePermission(
          db,
          userId,
          ctx.docId,
          ctx.folderIds,
          ctx.organizationId,
          role !== null, // isMember — gates the org-wide grant
        );

  if (granted === "none") return { permission: "none", capped: false };

  const locked = await isLocked(db, userId, ctx.docId, ctx.folderIds);
  if (locked && granted === "edit") return { permission: "view", capped: true };
  if (locked) return { permission: "view", capped: false };
  return { permission: granted, capped: false };
}
