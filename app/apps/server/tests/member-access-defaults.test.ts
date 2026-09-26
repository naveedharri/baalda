// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { applyBulkAccess, setJoinDefault } from "../src/permissions/access-management.js";
import { canCreateIn, canEditFolder } from "../src/permissions/http-gates.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import {
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

async function seedOrgShare(
  orgId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  permission: "edit" | "view" | "denied" = "edit",
): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1,$2,$3,$4,'org',$2,$5)`,
    [randomUUID(), orgId, resourceType, resourceId, permission],
  );
}

async function fixture() {
  const org = await seedOrg("Access defaults", `access-${randomUUID()}`);
  const owner = await seedUser(`owner-${randomUUID()}@test.dev`);
  await seedMember(org, owner, "owner");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "edit");
  const folder = await seedFolder(vault, null, "Existing", "Existing", owner);
  const doc = await seedNote(vault, folder, "Existing/note.md", owner);
  return { org, owner, vault, folder, doc };
}

describe("future-member access snapshots", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("hides pre-join team grants, then admits the same subtree after Everyone is applied", async () => {
    const { org, owner, vault, folder, doc } = await fixture();
    await seedOrgShare(org, "folder", folder);

    const joiner = await seedUser(`joiner-${randomUUID()}@test.dev`);
    await seedMember(org, joiner, "member");

    expect(await effectivePermission(joiner, doc)).toBe("none");
    expect(await listReadableDocsInVault(joiner, vault)).not.toContain(doc);

    await applyBulkAccess({
      organizationId: org,
      actorUserId: owner,
      resources: [{ resourceType: "folder", resourceId: folder }],
      audience: { type: "org" },
      mode: "open",
    });

    expect(await effectivePermission(joiner, doc)).toBe("edit");
    expect(await listReadableDocsInVault(joiner, vault)).toContain(doc);
  });

  it("applies the snapshot only to pre-join content", async () => {
    const { org, owner, vault, folder, doc } = await fixture();
    const joiner = await seedUser(`future-content-${randomUUID()}@test.dev`);
    await seedMember(org, joiner, "member");

    expect(await effectivePermission(joiner, doc)).toBe("none");
    const later = await seedNote(vault, folder, "Existing/later.md", owner);
    expect(await effectivePermission(joiner, later)).toBe("edit");
  });

  it("lets a Private-snapshot admin manage access without reading the content first", async () => {
    const { org, owner, folder, doc } = await fixture();
    const admin = await seedUser(`private-admin-${randomUUID()}@test.dev`);
    await seedMember(org, admin, "admin");
    expect(await effectivePermission(admin, doc)).toBe("none");

    await applyBulkAccess({
      organizationId: org,
      actorUserId: admin,
      resources: [{ resourceType: "folder", resourceId: folder }],
      audience: { type: "users", userIds: [admin] },
      mode: "open",
    });
    expect(await effectivePermission(admin, doc)).toBe("edit");
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("refuses a Private-snapshot admin writes inside a pre-join folder until access is granted", async () => {
    const { org, owner, vault, folder } = await fixture();
    const admin = await seedUser(`private-admin-write-${randomUUID()}@test.dev`);
    await seedMember(org, admin, "admin");

    expect(await canEditFolder(admin, folder)).toBe(false);
    expect(await canCreateIn(admin, vault, folder)).toBe(false);
    // The owner has no snapshot and keeps the role shortcut.
    expect(await canEditFolder(owner, folder)).toBe(true);
    // Content created after the join follows the live posture.
    const later = await seedFolder(vault, null, "Later", "Later", owner);
    expect(await canCreateIn(admin, vault, later)).toBe(true);
    // Root creation follows the live posture, never the join default.
    expect(await canCreateIn(admin, vault, null)).toBe(true);

    await applyBulkAccess({
      organizationId: org,
      actorUserId: owner,
      resources: [{ resourceType: "folder", resourceId: folder }],
      audience: { type: "org" },
      mode: "open",
    });
    expect(await canCreateIn(admin, vault, folder)).toBe(true);
  });

  it("keeps the admin shortcut for a legacy membership with no snapshot", async () => {
    const { org, vault, folder } = await fixture();
    const admin = await seedUser(`legacy-admin-${randomUUID()}@test.dev`);
    await seedMember(org, admin, "admin");
    await pool.query(
      "DELETE FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2",
      [org, admin],
    );
    expect(await canCreateIn(admin, vault, folder)).toBe(true);
  });

  it("changes only future joins and keeps legacy memberships unchanged", async () => {
    const { org, owner, doc } = await fixture();
    const existing = await seedUser(`existing-${randomUUID()}@test.dev`);
    await seedMember(org, existing, "member");
    // Represent a membership that existed when migration 032 was installed.
    await pool.query(
      "DELETE FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2",
      [org, existing],
    );

    await setJoinDefault(org, owner, "readonly");
    const future = await seedUser(`future-${randomUUID()}@test.dev`);
    await seedMember(org, future, "member");

    expect(await effectivePermission(existing, doc)).toBe("edit");
    expect(await effectivePermission(future, doc)).toBe("view");
  });

  it("selected people replace only their subtree overrides", async () => {
    const { org, owner, folder, doc } = await fixture();
    const selected = await seedUser(`selected-${randomUUID()}@test.dev`);
    const untouched = await seedUser(`untouched-${randomUUID()}@test.dev`);
    await seedMember(org, selected, "member");
    await seedMember(org, untouched, "member");
    await pool.query(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1,$2,'file',$3,'user',$4,'denied'),
              ($5,$2,'file',$3,'user',$6,'denied')`,
      [randomUUID(), org, doc, selected, randomUUID(), untouched],
    );

    await applyBulkAccess({
      organizationId: org,
      actorUserId: owner,
      resources: [{ resourceType: "folder", resourceId: folder }],
      audience: { type: "users", userIds: [selected] },
      mode: "open",
    });

    expect(await effectivePermission(selected, doc)).toBe("edit");
    expect(await effectivePermission(untouched, doc)).toBe("none");
    const rows = await pool.query<{ principal_id: string }>(
      "SELECT principal_id FROM shares WHERE resource_type = 'file' AND resource_id = $1",
      [doc],
    );
    expect(rows.rows.map((row) => row.principal_id)).toEqual([untouched]);
  });

  it("whole-vault selected people replace only their own overrides (no 500)", async () => {
    const { org, owner, doc } = await fixture();
    const selected = await seedUser(`selected-${randomUUID()}@test.dev`);
    const untouched = await seedUser(`untouched-${randomUUID()}@test.dev`);
    await seedMember(org, selected, "member");
    await seedMember(org, untouched, "member");
    await pool.query(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1,$2,'file',$3,'user',$4,'denied'),
              ($5,$2,'file',$3,'user',$6,'denied')`,
      [randomUUID(), org, doc, selected, randomUUID(), untouched],
    );

    await applyBulkAccess({
      organizationId: org,
      actorUserId: owner,
      resources: [{ resourceType: "vault", resourceId: org }],
      audience: { type: "users", userIds: [selected, owner] },
      mode: "open",
    });

    expect(await effectivePermission(selected, doc)).toBe("edit");
    expect(await effectivePermission(untouched, doc)).toBe("none");
    const rows = await pool.query<{ principal_id: string }>(
      "SELECT principal_id FROM shares WHERE resource_type = 'file' AND resource_id = $1",
      [doc],
    );
    expect(rows.rows.map((row) => row.principal_id)).toEqual([untouched]);
  });

  it("whole-vault Everyone replaces snapshots and every member override but not the future default", async () => {
    const { org, owner, doc } = await fixture();
    const member = await seedUser(`member-${randomUUID()}@test.dev`);
    await seedMember(org, member, "member");
    await pool.query(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1,$2,'file',$3,'user',$4,'denied')`,
      [randomUUID(), org, doc, member],
    );

    await applyBulkAccess({
      organizationId: org,
      actorUserId: owner,
      resources: [{ resourceType: "vault", resourceId: org }],
      audience: { type: "org" },
      mode: "readonly",
    });

    expect(await effectivePermission(member, doc)).toBe("view");
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) AS count FROM member_access_snapshots WHERE organization_id = $1",
            [org],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      (
        await pool.query<{ join_default: string }>(
          "SELECT join_default FROM organization_access_settings WHERE organization_id = $1",
          [org],
        )
      ).rows[0].join_default,
    ).toBe("private");
  });
});
