import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

type Queryable = Pick<pg.Pool, "query">;

/**
 * The set of doc_ids in a vault a user may **read** (spec 05 §3.1). This is the
 * set-based dual of `effectivePermission` ([[resolver]]) for one whole vault, so
 * the vault channel can compute a subscriber's readable set in a couple of
 * queries instead of one resolve per doc.
 *
 * Mirrors the resolver exactly (here "vault" is the note collection; the
 * owner/admin/member role belongs to its owning organization, the user-facing
 * vault):
 *   - vault owner/admin  -> every (non-deleted) note + file in the vault;
 *   - a vault-scoped view/edit grant (org-wide "Open"/"Read-only" for
 *     members, or per-user) -> likewise every doc in the vault;
 *   - otherwise             -> docs reachable via a **user** share (view/edit)
 *     on the doc itself or any ancestor folder (folder grants inherit down).
 *
 * `locked` is a deny-overlay that only caps edit->view; it never grants read, so
 * it's absent here.
 *
 * Read = view OR edit, so the channel streams content to view-only grantees too.
 */
/** Resolve a user's vault-level posture: their org, role, and whether they have
 *  vault-wide read (owner/admin, or a vault-scoped Open/Read-only grant). */
export async function vaultAccess(
  db: Queryable,
  userId: string,
  vaultId: string,
): Promise<{ organizationId: string; role: string | null; vaultWide: boolean } | null> {
  const org = await db.query<{ organization_id: string; role: string | null }>(
    `SELECT v.organization_id, m.role
       FROM vaults v
       LEFT JOIN member m
         ON m."organizationId" = v.organization_id AND m."userId" = $2
      WHERE v.id = $1`,
    [vaultId, userId],
  );
  const row = org.rows[0];
  if (!row) return null;
  let vaultWide = row.role === "owner" || row.role === "admin";
  if (!vaultWide) {
    const orgClause = row.role !== null ? "principal_type = 'org' OR" : "";
    const grant = await db.query(
      `SELECT 1 FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1
          AND permission IN ('view', 'edit')
          AND (${orgClause} (principal_type = 'user' AND principal_id = $2))
        LIMIT 1`,
      [row.organization_id, userId],
    );
    vaultWide = (grant.rowCount ?? 0) > 0;
  }
  return { organizationId: row.organization_id, role: row.role, vaultWide };
}

export async function listReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const org = await db.query<{ organization_id: string; role: string | null }>(
    `SELECT v.organization_id, m.role
       FROM vaults v
       LEFT JOIN member m
         ON m."organizationId" = v.organization_id AND m."userId" = $2
      WHERE v.id = $1`,
    [vaultId, userId],
  );
  const row = org.rows[0];
  if (!row) return new Set(); // unknown vault

  let vaultWide = row.role === "owner" || row.role === "admin";
  if (!vaultWide) {
    // Vault-scoped grant (spec 04 "Access" model): the org-wide Open/
    // Read-only default (members only), or a per-user vault grant.
    const orgClause =
      row.role !== null ? "principal_type = 'org' OR" : "";
    const grant = await db.query(
      `SELECT 1 FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1
          AND permission IN ('view', 'edit')
          AND (${orgClause} (principal_type = 'user' AND principal_id = $2))
        LIMIT 1`,
      [row.organization_id, userId],
    );
    vaultWide = (grant.rowCount ?? 0) > 0;
  }

  if (vaultWide) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
       UNION
       SELECT id FROM files WHERE vault_id = $1`,
      [vaultId],
    );
    return new Set(rows.map((r) => r.id));
  }

  // Non-privileged (private-by-default): readable docs are the union of
  //   - notes the user created (created_by) — ONLY while still a member;
  //   - docs under a folder shared to the user OR the team (org grant), walking
  //     the subtree since folder grants inherit down;
  //   - files/notes shared directly to the user or the team.
  // Both the creator branch and the org ($3) branches are gated by membership
  // ($4) so a REMOVED member (session outlives removal) loses read on notes
  // they authored — matching resolver.effectivePermission's creator rule.
  const isMember = row.role !== null;
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE shared_folders AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission IN ('view', 'edit')
           AND (
             (principal_type = 'user' AND principal_id = $1)
             OR ($4 AND principal_type = 'org' AND principal_id = $3)
           )
     ),
     subtree AS (
        SELECT id FROM folders WHERE id IN (SELECT id FROM shared_folders)
        UNION ALL
        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
     ),
     shared_files AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'file' AND permission IN ('view', 'edit')
           AND (
             (principal_type = 'user' AND principal_id = $1)
             OR ($4 AND principal_type = 'org' AND principal_id = $3)
           )
     )
     SELECT n.id FROM notes n
       WHERE n.vault_id = $2 AND n.deleted_at IS NULL
         AND (
           ($4 AND n.created_by = $1)
           OR n.folder_id IN (SELECT id FROM subtree)
           OR n.id IN (SELECT id FROM shared_files)
         )
     UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (fi.folder_id IN (SELECT id FROM subtree) OR fi.id IN (SELECT id FROM shared_files))`,
    [userId, vaultId, row.organization_id, isMember],
  );
  return new Set(rows.map((r) => r.id));
}

export interface VaultFolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort: number;
  created_by: string | null;
}

/**
 * Folders a user may SEE in the tree (private-by-default). Owner/admin or an
 * Open/Read-only vault get every folder; otherwise a member sees folders
 * they created, folders shared to them or the team (+ their subtrees, since
 * grants inherit down), and the ANCESTORS of anything visible so the path to a
 * shared note/folder is never missing a link.
 */
export async function listVisibleFolders(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<VaultFolderRow[]> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return [];
  const all = await db.query<VaultFolderRow>(
    "SELECT id, vault_id, parent_id, name, path, sort, created_by FROM folders WHERE vault_id = $1 ORDER BY sort, path",
    [vaultId],
  );
  if (access.vaultWide) return all.rows;

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  const isMember = access.role !== null;
  const { rows: visibleIds } = await db.query<{ id: string }>(
    `WITH RECURSIVE seed AS (
        SELECT id FROM folders WHERE vault_id = $2 AND created_by = $1
        UNION
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission IN ('view', 'edit')
           AND (
             (principal_type = 'user' AND principal_id = $1)
             OR ($4 AND principal_type = 'org' AND principal_id = $3)
           )
     ),
     down AS (
        SELECT id, parent_id FROM folders WHERE vault_id = $2 AND id IN (SELECT id FROM seed)
        UNION ALL
        SELECT f.id, f.parent_id FROM folders f JOIN down d ON f.parent_id = d.id
     ),
     note_folders AS (
        SELECT DISTINCT folder_id AS id FROM notes
         WHERE vault_id = $2 AND deleted_at IS NULL AND folder_id IS NOT NULL
           AND id = ANY($5::text[])
     ),
     up AS (
        SELECT id, parent_id FROM folders
         WHERE vault_id = $2
           AND id IN (SELECT id FROM down UNION SELECT id FROM note_folders)
        UNION ALL
        SELECT f.id, f.parent_id FROM folders f JOIN up u ON f.id = u.parent_id
     )
     SELECT DISTINCT id FROM up`,
    [userId, vaultId, access.organizationId, isMember, [...readable]],
  );
  const visible = new Set(visibleIds.map((r) => r.id));
  return all.rows.filter((f) => visible.has(f.id));
}
