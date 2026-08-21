import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "./lookup.js";
import {
  ancestorFolderIds,
  buildAccessContext,
  effectivePermission,
  isDenied,
  isLocked,
  resolveAccessForUser,
} from "./resolver.js";
import { listReadableDocsInVault, vaultAccess } from "./vault-docs.js";

type Queryable = Pick<pg.Pool, "query">;

/** Escape SQL LIKE metacharacters so a value is matched literally under
 *  `LIKE … ESCAPE '\'`. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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

  // Overlays first, both of which outrank the role below: a per-member deny
  // removes the folder outright, and a lock caps everyone at view (no edits).
  const chain = await ancestorFolderIds(db, folderId);
  if (await isDenied(db, userId, null, chain)) return false;
  if (await isLocked(db, userId, null, chain)) return false;

  if (role === "owner" || role === "admin") return true;
  if (row.created_by && row.created_by === userId) return true;

  // Else: an explicit user/team edit share on the folder or an ancestor.
  const ctx = await buildAccessContext("folder", folderId, db);
  if (!ctx) return false;
  const resolved = await resolveAccessForUser(ctx, userId, role, db);
  return resolved.permission === "edit";
}

/**
 * May `userId` read attachment blob `relPath` in vault `vaultId`?
 *
 * Attachments have no per-blob ACL row, so their access derives from the notes
 * that embed them: a caller with vault-wide read (owner/admin, or an
 * Open/Read-only grant) sees every blob — including orphaned ones — while a
 * scoped member may fetch a blob only if some note they can READ references it.
 * This closes the IDOR where any member could download every attachment
 * (including those in private notes) while keeping attachment sync working for
 * legitimately-shared notes.
 *
 * Best-effort by design: the reference check reads `note_index.content`, so a
 * just-embedded attachment becomes fetchable to other readers once its note is
 * indexed (attachment sync is already eventually-consistent).
 */
export async function canReadAttachment(
  userId: string,
  vaultId: string,
  relPath: string | null,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return false; // unknown vault or not a member
  if (access.vaultWide) return true; // owner/admin or vault-wide grant
  if (!relPath) return false; // legacy blob w/o a path — no readable note to tie it to

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  if (readable.size === 0) return false;
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM note_index
      WHERE vault_id = $1 AND doc_id = ANY($2::text[])
        AND content LIKE '%' || $3 || '%' ESCAPE '\\'
      LIMIT 1`,
    [vaultId, [...readable], likeEscape(relPath)],
  );
  return rows.length > 0;
}

/**
 * Filter a vault's blob list to the ones `userId` may read (see
 * {@link canReadAttachment}). Vault-wide readers get everything; a scoped
 * member gets only blobs referenced by a note they can read.
 */
export async function filterReadableBlobs<T extends { rel_path: string | null }>(
  userId: string,
  vaultId: string,
  blobs: T[],
  db: Queryable = defaultPool,
): Promise<T[]> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return [];
  if (access.vaultWide) return blobs;

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  if (readable.size === 0) return [];
  const { rows } = await db.query<{ content: string | null }>(
    `SELECT content FROM note_index WHERE vault_id = $1 AND doc_id = ANY($2::text[])`,
    [vaultId, [...readable]],
  );
  const haystack = rows.map((r) => r.content ?? "").join("\n");
  return blobs.filter((b) => !!b.rel_path && haystack.includes(b.rel_path));
}
