import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

type Queryable = Pick<pg.Pool, "query">;

export async function orgRole(
  organizationId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

export async function vaultOrg(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  return rows[0]?.organization_id ?? null;
}

export interface ResourceInfo {
  vaultId: string;
  organizationId: string;
  createdBy: string | null;
}

/**
 * Resolve a share resource (folder, file/note, or the vault-wide grant itself)
 * to its note collection, organization, and creator. Returns null if the
 * resource does not exist.
 *
 * Terminology: "vault (organization, user-facing)" vs "note collection (vaults
 * row, storage child)". For a `vault` resource (the vault-wide grant) the
 * `resourceId` IS the organization id; there is no single note collection (an
 * organization may own several), so `vaultId` is the empty string and callers
 * use {@link docsForResource} to enumerate affected docs.
 */
export async function resolveResource(
  resourceType: "folder" | "file" | "vault",
  resourceId: string,
  db: Queryable = defaultPool,
): Promise<ResourceInfo | null> {
  if (resourceType === "vault") {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM organization WHERE id = $1",
      [resourceId],
    );
    if (!rows[0]) return null;
    return { vaultId: "", organizationId: resourceId, createdBy: null };
  }

  if (resourceType === "folder") {
    const { rows } = await db.query<{
      vault_id: string;
      organization_id: string;
    }>(
      `SELECT f.vault_id, v.organization_id
         FROM folders f JOIN vaults v ON v.id = f.vault_id
        WHERE f.id = $1`,
      [resourceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      vaultId: row.vault_id,
      organizationId: row.organization_id,
      createdBy: null, // folders have no creator column in MVP
    };
  }

  // file: a file/note doc_id
  const { rows } = await db.query<{
    vault_id: string;
    organization_id: string;
    created_by: string | null;
  }>(
    `SELECT loc.vault_id, v.organization_id, loc.created_by
       FROM (
         SELECT vault_id, created_by FROM notes WHERE id = $1
         UNION ALL
         SELECT vault_id, NULL::text AS created_by FROM files WHERE id = $1
       ) loc
       JOIN vaults v ON v.id = loc.vault_id
      LIMIT 1`,
    [resourceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
  };
}

/** Docs affected by a share, so live sockets can be killed on revoke. */
export async function docsForResource(
  resourceType: "folder" | "file" | "vault",
  resourceId: string,
  db: Queryable = defaultPool,
): Promise<Array<{ docId: string; vaultId: string }>> {
  if (resourceType === "file") {
    const info = await resolveResource("file", resourceId, db);
    return info ? [{ docId: resourceId, vaultId: info.vaultId }] : [];
  }

  if (resourceType === "vault") {
    // Every note/file in every note collection of this vault (resourceId = org id).
    const { rows } = await db.query<{ doc_id: string; vault_id: string }>(
      `SELECT n.id AS doc_id, n.vault_id FROM notes n
         JOIN vaults v ON v.id = n.vault_id
        WHERE v.organization_id = $1 AND n.deleted_at IS NULL
       UNION
       SELECT fi.id AS doc_id, fi.vault_id FROM files fi
         JOIN vaults v ON v.id = fi.vault_id
        WHERE v.organization_id = $1`,
      [resourceId],
    );
    return rows.map((r) => ({ docId: r.doc_id, vaultId: r.vault_id }));
  }

  // folder: every note/file under this folder or any descendant folder
  const { rows } = await db.query<{ doc_id: string; vault_id: string }>(
    `WITH RECURSIVE subtree AS (
        SELECT id, vault_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.vault_id FROM folders f JOIN subtree s ON f.parent_id = s.id
     )
     SELECT n.id AS doc_id, n.vault_id FROM notes n
       JOIN subtree s ON n.folder_id = s.id AND n.deleted_at IS NULL
     UNION
     SELECT fi.id AS doc_id, fi.vault_id FROM files fi
       JOIN subtree s ON fi.folder_id = s.id`,
    [resourceId],
  );
  return rows.map((r) => ({ docId: r.doc_id, vaultId: r.vault_id }));
}
