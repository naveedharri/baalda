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
  /** Matches `seedNote`. Authorship is what a Private vault leaves standing, so
   *  a fixture that wants an owner to still manage a folder has to say so. */
  createdBy: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO folders (id, vault_id, parent_id, name, path, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, vaultId, parentId, name, path, createdBy],
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

/** A lock row (read-only cap) on a folder/file, for a user or the whole org. */
/**
 * A vault-scoped grant for ONE user — the per-person equivalent of
 * {@link seedVaultGrant}. This is what makes someone a vault-wide reader now
 * that the owner/admin role is not one on its own: it survives the Private
 * posture, exactly as the resolver's read-only branch honours it.
 */
/**
 * Seal a vault: the org-principal `denied` row on the vault resource that
 * `PUT /orgs/:orgId/team-access { mode: "private" }` writes.
 *
 * Distinct from having no row at all, which means "never shared" and still
 * leaves people the notes they wrote. See [[resolver]] `vaultBaseline`.
 */
export async function sealVault(organizationId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'org', $2, 'denied')
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
     DO UPDATE SET permission = 'denied'`,
    [id, organizationId],
  );
  return id;
}

export async function seedUserVaultGrant(
  organizationId: string,
  userId: string,
  permission: "view" | "edit",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'user', $3, $4)`,
    [id, organizationId, userId, permission],
  );
  return id;
}

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

/**
 * A `denied` row — the per-member "No access" block. Unlike a lock (which caps
 * at view) this removes access outright, and it outranks every allow rule.
 *
 * Upserts, like `POST /api/shares` does: there is one row per
 * (resource, principal), so denying someone who already has a lock or a grant
 * REPLACES it rather than adding a second row.
 */
export async function seedDeny(
  organizationId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  userId: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, 'denied')
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
     DO UPDATE SET permission = 'denied'`,
    [id, organizationId, resourceType, resourceId, userId],
  );
  return id;
}

/**
 * An ORG-scoped `denied` row — the item set to **Private**. Unlike the
 * per-member deny above it takes the item out of the *team's* reach only: the
 * creator, anyone with a personal share, and owners/admins keep it.
 */
export async function seedItemPrivate(
  organizationId: string,
  resourceType: "folder" | "file",
  resourceId: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'org', $2, 'denied')
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
     DO UPDATE SET permission = 'denied'`,
    [id, organizationId, resourceType, resourceId],
  );
  return id;
}

/** Close a vault's root to new folders/notes (the General settings latch). */
export async function freezeVaultRoot(vaultId: string, frozen = true): Promise<void> {
  await pool.query("UPDATE vaults SET root_frozen = $2 WHERE id = $1", [vaultId, frozen]);
}
