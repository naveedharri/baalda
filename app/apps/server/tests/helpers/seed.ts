import { randomUUID } from "node:crypto";
import { pool } from "../../src/db/pool.js";

/** Insert a Better Auth user row directly (bypasses password/account setup). */
export async function seedUser(email: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, now(), now())`,
    [id, email.split("@")[0], email],
  );
  return id;
}

export async function seedOrg(name: string, slug: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
    [id, name, slug],
  );
  return id;
}

export async function seedMember(
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, $4, now())`,
    [id, organizationId, userId, role],
  );
  return id;
}

export async function seedVault(organizationId: string, name = "Vault"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO vaults (id, organization_id, name) VALUES ($1, $2, $3)",
    [id, organizationId, name],
  );
  return id;
}

export async function seedFolder(
  vaultId: string,
  parentId: string | null,
  name: string,
  path: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO folders (id, vault_id, parent_id, name, path) VALUES ($1, $2, $3, $4, $5)",
    [id, vaultId, parentId, name, path],
  );
  return id;
}

export async function seedNote(
  vaultId: string,
  folderId: string | null,
  relPath: string,
  createdBy: string | null = null,
  docId: string = randomUUID(),
): Promise<string> {
  await pool.query(
    `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6)`,
    [docId, vaultId, folderId, relPath, relPath, createdBy],
  );
  return docId;
}

export async function seedShare(
  orgId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  principalId: string,
  permission: "view" | "edit",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
    [id, orgId, resourceType, resourceId, principalId, permission],
  );
  return id;
}

/** Org-wide vault grant — the "Open" (edit) / "Read-only" (view) posture. */
export async function seedVaultGrant(
  organizationId: string,
  permission: "view" | "edit",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    // 'vault' = the vault-wide grant (resource_id = organization id).
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'org', $2, $3)`,
    [id, organizationId, permission],
  );
  return id;
}

/** A lock row (DENY overlay) on a folder/file, for a user or the whole org. */
export async function seedLock(
  organizationId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  principal: { type: "user"; id: string } | { type: "org" },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, $5, $6, 'locked')`,
    [
      id,
      organizationId,
      resourceType,
      resourceId,
      principal.type,
      principal.type === "user" ? principal.id : organizationId,
    ],
  );
  return id;
}
