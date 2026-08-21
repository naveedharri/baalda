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
 * `locked` is a cap overlay that only takes edit->view; it never grants read, so
 * it's absent here. `denied` (per-member "No access") IS here: it removes read,
 * so every set below subtracts it last — see `deniedDocsInVault`.
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

/**
 * doc_ids in this vault the user is explicitly SHUT OUT of — the per-member
 * deny (`shares.permission = 'denied'`) folded down through folder inheritance.
 *
 * Subtracted from every readable/visible set below rather than woven into their
 * WHERE clauses on purpose: a deny has to beat the owner/admin branch, the
 * vault-wide grant branch AND the created_by branch, and those are three
 * different queries. One subtraction at the end can't be forgotten in one of
 * them.
 */
async function deniedDocsInVault(
  db: Queryable,
  userId: string,
  vaultId: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE denied_seed AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission = 'denied'
           AND principal_type = 'user' AND principal_id = $1
     ),
     denied_subtree AS (
        SELECT id, parent_id FROM folders WHERE id IN (SELECT id FROM denied_seed)
        UNION ALL
        SELECT f.id, f.parent_id FROM folders f JOIN denied_subtree d ON f.parent_id = d.id
     ),
     denied_files AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'file' AND permission = 'denied'
           AND principal_type = 'user' AND principal_id = $1
     )
     SELECT n.id FROM notes n
       WHERE n.vault_id = $2
         AND (n.folder_id IN (SELECT id FROM denied_subtree) OR n.id IN (SELECT id FROM denied_files))
     UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (fi.folder_id IN (SELECT id FROM denied_subtree) OR fi.id IN (SELECT id FROM denied_files))`,
    [userId, vaultId],
  );
  return new Set(rows.map((r) => r.id));
}

/** Folder ids this user is denied, including everything below them. */
async function deniedFolderIds(
  db: Queryable,
  userId: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE denied_seed AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission = 'denied'
           AND principal_type = 'user' AND principal_id = $1
     ),
     denied_subtree AS (
        SELECT id, parent_id FROM folders WHERE id IN (SELECT id FROM denied_seed)
        UNION ALL
        SELECT f.id, f.parent_id FROM folders f JOIN denied_subtree d ON f.parent_id = d.id
     )
     SELECT DISTINCT id FROM denied_subtree`,
    [userId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * One implementation, two questions. `deleted: false` answers "what may this user
 * read?"; `deleted: true` answers "which of this vault's docs that they'd be
 * allowed to read are now **gone**?" — the tombstone set the desktop reconciler
 * needs to tell a delete from a revoke.
 *
 * They MUST share one body. The client applies the difference between them by
 * removing files from disk, so if the two permission algebras ever drifted, the
 * drift would show up as a note being deleted off someone's disk. A single
 * predicate swap can't drift.
 */
async function listDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable,
  opts: { deleted: boolean },
): Promise<Set<string>> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return new Set(); // unknown vault
  const { organizationId, role, vaultWide } = access;

  // The ONLY difference between the two sets. `files` has no `deleted_at`
  // column, so a tombstone can never be a file — the UNIONs below drop out.
  const livePredicate = opts.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";

  if (vaultWide) {
    const { rows } = await db.query<{ id: string }>(
      opts.deleted
        ? `SELECT id FROM notes WHERE vault_id = $1 AND ${livePredicate}`
        : `SELECT id FROM notes WHERE vault_id = $1 AND ${livePredicate}
           UNION
           SELECT id FROM files WHERE vault_id = $1`,
      [vaultId],
    );
    return subtract(new Set(rows.map((r) => r.id)), await deniedDocsInVault(db, userId, vaultId));
  }

  // Non-privileged (private-by-default): readable docs are the union of
  //   - notes the user created (created_by) — ONLY while still a member;
  //   - docs under a folder shared to the user OR the team (org grant), walking
  //     the subtree since folder grants inherit down;
  //   - files/notes shared directly to the user or the team.
  // Both the creator branch and the org ($3) branches are gated by membership
  // ($4) so a REMOVED member (session outlives removal) loses read on notes
  // they authored — matching resolver.effectivePermission's creator rule.
  //
  // A soft-deleted note keeps `created_by`, `folder_id` and its `shares` rows, so
  // this resolves a tombstone's permission exactly as it did while the note lived.
  const isMember = role !== null;
  const filesUnion = opts.deleted
    ? ""
    : `UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (fi.folder_id IN (SELECT id FROM subtree) OR fi.id IN (SELECT id FROM shared_files))`;
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
       WHERE n.vault_id = $2 AND n.${livePredicate}
         AND (
           ($4 AND n.created_by = $1)
           OR n.folder_id IN (SELECT id FROM subtree)
           OR n.id IN (SELECT id FROM shared_files)
         )
     ${filesUnion}`,
    [userId, vaultId, organizationId, isMember],
  );
  return subtract(new Set(rows.map((r) => r.id)), await deniedDocsInVault(db, userId, vaultId));
}

/** `a` minus `b`, in place on `a`. */
function subtract(a: Set<string>, b: Set<string>): Set<string> {
  for (const id of b) a.delete(id);
  return a;
}

export async function listReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  return listDocsInVault(userId, vaultId, db, { deleted: false });
}

/**
 * doc_ids in this vault the caller could read but that are now **soft-deleted**.
 *
 * Why this exists: "absent from `GET /api/notes`" is ambiguous — it means either
 * *deleted* or *you lost read access*, because that route is ACL-filtered. The
 * desktop reconciler has to remove local files for the first and must NOT for the
 * second (losing a share deliberately leaves the `.md` alone). Absence alone
 * can't distinguish them, and neither can `effectivePermission`: `locateDoc`
 * filters `deleted_at IS NULL`, so a deleted doc resolves to "none", exactly like
 * no access. So deletion has to be *stated*, never inferred.
 *
 * Permission-filtered rather than "every deleted id in the vault": the filtered
 * version's failure mode is the safe one. If a teammate lost the share AND the
 * note was deleted, the id is withheld, the client falls into its
 * "absent from both" branch, and it keeps the file. Filtering can only ever
 * cause a MISSED delete, never a wrong one.
 */
export async function listDeletedReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  return listDocsInVault(userId, vaultId, db, { deleted: true });
}

export interface VaultFolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort: number;
  created_by: string | null;
  /** Palette id from the client's `lib/appearance`, or null. Vault-wide, so a
   *  folder tinted on one machine is tinted for the whole team. */
  color: string | null;
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
    "SELECT id, vault_id, parent_id, name, path, sort, created_by, color FROM folders WHERE vault_id = $1 ORDER BY sort, path",
    [vaultId],
  );
  const denied = await deniedFolderIds(db, userId);
  if (access.vaultWide) return all.rows.filter((f) => !denied.has(f.id));

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
  return all.rows.filter((f) => visible.has(f.id) && !denied.has(f.id));
}
