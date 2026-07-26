import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "./lookup.js";
import {
  ancestorFolderIds,
  buildAccessContext,
  effectivePermission,
  isLocked,
  resolveAccessForUser,
} from "./resolver.js";

type Queryable = Pick<pg.Pool, "query">;

/**
 * Authorization gates for the session-authenticated HTTP registry/blob routes.
 *
 * These exist so the HTTP layer stops authorizing structural mutations on bare
 * vault membership and instead uses the SAME per-doc/per-folder ACL the MCP
 * layer already enforces (`effectivePermission` / `folderWritePermission`).
 * Owner/admin, a note's creator, and edit-share holders keep their access; a
 * plain member with no grant no longer can mutate content they cannot read.
 */

/** May `userId` edit (rename/move/delete) note or file `docId`? Mirrors the
 *  MCP `requireEditableNote` gate: owner/admin, the note's creator, or an
 *  edit share — with a lock capping to view (→ false). */
export async function canEditDoc(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  return (await effectivePermission(userId, docId, db)) === "edit";
}

/**
 * May `userId` modify folder `folderId` (rename / re-parent / delete)?
 *
 * Allowed for the vault owner/admin, the folder's creator (mirrors the note
 * creator rule so a member can still manage their own private folders), or a
 * user/team edit share on the folder or any ancestor. A lock on the folder or
 * any ancestor makes it read-only for everyone (owners/admins included),
 * matching `folderWritePermission` in the MCP service.
 */
export async function canEditFolder(
  userId: string,
  folderId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query<{
    created_by: string | null;
    organization_id: string;
  }>(
    `SELECT f.created_by, v.organization_id
       FROM folders f JOIN vaults v ON v.id = f.vault_id
      WHERE f.id = $1`,
    [folderId],
  );
  const row = rows[0];
  if (!row) return false;

  const role = await orgRole(row.organization_id, userId, db);
  if (role === null) return false; // not a member of the vault

  // Deny overlay first: a lock caps everyone at view (no edits at all).
  const chain = await ancestorFolderIds(db, folderId);
  if (await isLocked(db, userId, null, chain)) return false;

  if (role === "owner" || role === "admin") return true;
  if (row.created_by && row.created_by === userId) return true;

  // Else: an explicit user/team edit share on the folder or an ancestor.
  const ctx = await buildAccessContext("folder", folderId, db);
  if (!ctx) return false;
  const resolved = await resolveAccessForUser(ctx, userId, role, db);
  return resolved.permission === "edit";
}
