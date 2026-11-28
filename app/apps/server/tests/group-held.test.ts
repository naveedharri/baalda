// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { heldByOwnSettings, letGroupDecide } from "../src/groups/held.js";
import { canEditFolder } from "../src/permissions/http-gates.js";
import { applyNewMemberDefault } from "../src/members/invitation-access.js";
import { resetDb } from "./helpers/db.js";
import { sealVault, seedFolder, seedMember, seedNote, seedOrg, seedUser, seedUserVaultGrant, seedVault } from "./helpers/seed.js";

/**
 * Folder and Access (2026-11-27): a setting just for a person decides over
 * their groups. A group change asks first: who it would not reach
 * (`heldByOwnSettings`), and "Let Sales decide" (`letGroupDecide`) removes
 * their own setting on that place or saves a "may raise" mark.
 */

async function group(org: string, name: string, autoJoin = false): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO access_groups (id, organization_id, name, auto_join) VALUES ($1, $2, $3, $4)", [id, org, name, autoJoin]);
  return id;
}
async function join(org: string, groupId: string, userId: string) {
  await pool.query("INSERT INTO access_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3)", [groupId, org, userId]);
}
async function groupRow(org: string, groupId: string, type: string, id: string, permission: string) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
     VALUES ($1, $2, $3, $4, 'group', $5, $6, 1)`,
    [randomUUID(), org, type, id, groupId, permission],
  );
}
async function userRow(org: string, type: string, id: string, user: string, permission: string) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
    [randomUUID(), org, type, id, user, permission],
  );
}
const marks = async (user: string) =>
  (await pool.query("SELECT resource_type, resource_id FROM access_group_raises WHERE user_id = $1", [user])).rows;

async function fixture() {
  const slug = randomUUID().slice(0, 8);
  const org = await seedOrg("Held", `held-${slug}`);
  const owner = await seedUser(`owner-${slug}@held.test`);
  const sam = await seedUser(`sam-${slug}@held.test`);
  const ana = await seedUser(`ana-${slug}@held.test`);
  await seedMember(org, owner, "owner");
  await seedMember(org, sam, "member");
  await seedMember(org, ana, "member");
  const vault = await seedVault(org);
  await sealVault(org);
  await seedUserVaultGrant(org, owner, "edit");
  const specs = await seedFolder(vault, null, "Specs", "Specs", owner);
  const spec = await seedNote(vault, specs, "Specs/A.md", owner);
  const other = await seedNote(vault, null, "Other.md", owner);
  const sales = await group(org, "Sales");
  await join(org, sales, sam);
  await join(org, sales, ana);
  await groupRow(org, sales, "folder", specs, "edit");
  return { org, vault, owner, sam, ana, specs, spec, other, sales };
}

afterAll(() => pool.end());

describe("a person's own setting decides over their groups", () => {
  beforeEach(resetDb);

  it("own vault Can view holds a group's Can edit back; Let decide marks it and lifts only there", async () => {
    const f = await fixture();
    await seedUserVaultGrant(f.org, f.sam, "view");
    expect(await effectivePermission(f.sam, f.spec)).toBe("view");
    expect(await effectivePermission(f.ana, f.spec)).toBe("edit"); // no own setting: the group decides
    const readable = [...(await listReadableDocsInVault(f.sam, f.vault))].sort();

    const held = await heldByOwnSettings({ orgId: f.org, actorUserId: f.owner, groupId: f.sales });
    expect(held).toEqual([]); // adding nobody: nobody to judge
    const preview = await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: f.specs }], mode: "open" },
    });
    expect(preview.map((h) => [h.userId, h.current, h.groupGives, h.ownAt])).toEqual([[f.sam, "view", "edit", "above"]]);

    const out = await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: f.specs }],
    });
    expect(out.map((r) => [r.action, r.before, r.after])).toEqual([["marked", "view", "edit"]]);
    expect(await effectivePermission(f.sam, f.spec)).toBe("edit");
    expect(await effectivePermission(f.sam, f.other)).toBe("view"); // the mark reaches only Specs
    expect([...(await listReadableDocsInVault(f.sam, f.vault))].sort()).toEqual(readable);
    // Asked again, Sam is no longer held there.
    expect(await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: f.specs }], mode: "open" },
    })).toEqual([]);
  });

  it("own No access on a folder: a mark on a subfolder lets the group decide only there", async () => {
    const f = await fixture();
    await seedUserVaultGrant(f.org, f.sam, "edit"); // like a converted member: Can edit everything of their own
    const inner = await seedFolder(f.vault, f.specs, "Inner", "Specs/Inner", f.owner);
    const deep = await seedNote(f.vault, inner, "Specs/Inner/B.md", f.owner);
    await userRow(f.org, "folder", f.specs, f.sam, "denied");
    expect(await effectivePermission(f.sam, f.spec)).toBe("none");
    expect(await effectivePermission(f.sam, deep)).toBe("none");
    const preview = await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: inner }], mode: "open" },
    });
    expect(preview.map((h) => [h.userId, h.current, h.groupGives, h.ownAt])).toEqual([[f.sam, "none", "edit", "above"]]);
    const out = await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: inner }],
    });
    expect(out.map((r) => [r.action, r.before, r.after])).toEqual([["marked", "none", "edit"]]);
    expect(await effectivePermission(f.sam, deep)).toBe("edit");
    expect(await effectivePermission(f.sam, f.spec)).toBe("none"); // the rest of Specs stays No access
    expect(await effectivePermission(f.sam, f.other)).toBe("edit"); // his own Can edit everything elsewhere
    expect(await canEditFolder(f.sam, inner)).toBe(true);
    expect(await canEditFolder(f.sam, f.specs)).toBe(false);
    const readable = await listReadableDocsInVault(f.sam, f.vault);
    expect(readable.has(deep)).toBe(true);
    expect(readable.has(f.spec)).toBe(false);
    // A padlock still caps what the group gives.
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'org', $2, 'locked')`,
      [randomUUID(), f.org, inner],
    );
    expect(await effectivePermission(f.sam, deep)).toBe("view");
    await pool.query("DELETE FROM shares WHERE permission = 'locked'");
    // Leaving the group takes the mark with it.
    await pool.query("DELETE FROM access_group_members WHERE group_id = $1 AND user_id = $2", [f.sales, f.sam]);
    expect(await marks(f.sam)).toEqual([]);
    expect(await effectivePermission(f.sam, deep)).toBe("none");
    expect(await canEditFolder(f.sam, inner)).toBe(false);
  });

  it("an own setting ON the place is removed; one higher up still decides, so a mark goes with it", async () => {
    const f = await fixture();
    await seedUserVaultGrant(f.org, f.sam, "view");
    await userRow(f.org, "folder", f.specs, f.sam, "readonly");
    expect(await effectivePermission(f.sam, f.spec)).toBe("view");
    const preview = await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: f.specs }], mode: "open" },
    });
    expect(preview.map((h) => h.ownAt)).toEqual(["here"]);
    const out = await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: f.specs }],
    });
    expect(out[0]).toMatchObject({ action: "removed", after: "edit" });
    expect(await marks(f.sam)).toHaveLength(1);
    const left = await pool.query("SELECT 1 FROM shares WHERE resource_id = $1 AND principal_id = $2", [f.specs, f.sam]);
    expect(left.rowCount).toBe(0);
  });

  it("an own No access on the vault: removing a lower own row never drops them below what the group gives", async () => {
    const f = await fixture();
    await userRow(f.org, "vault", f.org, f.sam, "denied");
    await userRow(f.org, "folder", f.specs, f.sam, "view");
    const before = await effectivePermission(f.sam, f.spec);
    const out = await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: f.specs }],
    });
    const rank = (p: string) => (p === "edit" ? 2 : p === "view" ? 1 : 0);
    expect(rank(out[0]!.after)).toBeGreaterThanOrEqual(rank(before));
    expect(rank(await effectivePermission(f.sam, f.spec))).toBeGreaterThanOrEqual(rank(before));
  });

  it("skips ids from another vault, people with nothing of their own there, and never drops a padlock", async () => {
    const f = await fixture();
    const g = await fixture();
    await seedUserVaultGrant(f.org, f.sam, "view");
    await userRow(f.org, "folder", f.specs, f.sam, "locked");
    const out = await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [
        { userId: f.sam, resourceType: "folder", resourceId: g.specs }, // another vault's folder
        { userId: f.ana, resourceType: "folder", resourceId: f.specs }, // nothing of her own
        { userId: f.sam, resourceType: "folder", resourceId: f.specs },
      ],
    });
    expect(out.map((r) => r.action)).toEqual(["skipped", "skipped", "marked"]);
    expect((await marks(f.ana))).toHaveLength(0);
    const lock = await pool.query("SELECT 1 FROM shares WHERE resource_id = $1 AND principal_id = $2 AND permission = 'locked'", [f.specs, f.sam]);
    expect(lock.rowCount).toBe(1);
  });

  it("a mark goes when they leave the group", async () => {
    const f = await fixture();
    await seedUserVaultGrant(f.org, f.sam, "view");
    await letGroupDecide({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: f.specs }],
    });
    expect(await marks(f.sam)).toHaveLength(1);
    await pool.query("DELETE FROM access_group_members WHERE group_id = $1 AND user_id = $2", [f.sales, f.sam]);
    expect(await marks(f.sam)).toHaveLength(0);
    expect(await effectivePermission(f.sam, f.spec)).toBe("view");
  });

  it("only owners and admins may let a group decide", async () => {
    const f = await fixture();
    await expect(letGroupDecide({
      orgId: f.org, actorUserId: f.ana, groupId: f.sales,
      entries: [{ userId: f.sam, resourceType: "folder", resourceId: f.specs }],
    })).rejects.toMatchObject({ status: 403 });
  });
});

describe("an invite that chose nothing keeps the vault's old team level", () => {
  beforeEach(resetDb);

  it("gives new_member_level to a plain member, but not one a group takes in", async () => {
    const f = await fixture();
    await pool.query(
      `INSERT INTO organization_access_settings (organization_id, join_default, new_member_level) VALUES ($1, 'private', 'edit')
       ON CONFLICT (organization_id) DO UPDATE SET new_member_level = 'edit'`,
      [f.org],
    );
    const newcomer = await seedUser(`new-${randomUUID().slice(0, 6)}@held.test`);
    await seedMember(f.org, newcomer, "member");
    await applyNewMemberDefault({ organizationId: f.org, userId: newcomer });
    expect(await effectivePermission(newcomer, f.other)).toBe("edit");

    const everyone = await group(f.org, "Everyone", true);
    const grouped = await seedUser(`grp-${randomUUID().slice(0, 6)}@held.test`);
    await seedMember(f.org, grouped, "member");
    await pool.query("INSERT INTO access_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [everyone, f.org, grouped]);
    await applyNewMemberDefault({ organizationId: f.org, userId: grouped });
    const own = await pool.query("SELECT 1 FROM shares WHERE resource_type = 'vault' AND principal_id = $1", [grouped]);
    expect(own.rowCount).toBe(0);
  });
});

describe("the group giving less than a setting just for them (2026-11-28)", () => {
  beforeEach(resetDb);

  it("a group with no setting on a place says nothing there: an empty group asks nobody", async () => {
    const f = await fixture();
    const fresh = await group(f.org, "Empty");
    await seedUserVaultGrant(f.org, f.sam, "edit");
    await userRow(f.org, "folder", f.specs, f.ana, "edit");
    expect(await heldByOwnSettings({ orgId: f.org, actorUserId: f.owner, groupId: fresh, addUserIds: [f.sam, f.ana] })).toEqual([]);
    // A group that reaches only one folder says nothing about the rest of the
    // vault: adding Sam asks nothing about his own Can edit everything, and
    // Remove all (No access on the whole vault) asks nobody either.
    expect(await heldByOwnSettings({ orgId: f.org, actorUserId: f.owner, groupId: f.sales, addUserIds: [f.sam] })).toEqual([]);
    expect(await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "vault", resourceId: f.org }], mode: "private" },
    })).toEqual([]);
    // Even a group with a whole-vault level: No access there just removes the
    // group's row, so the group gives nothing and nobody is held back.
    await groupRow(f.org, f.sales, "vault", f.org, "view");
    expect(await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "vault", resourceId: f.org }], mode: "private" },
    })).toEqual([]);
  });

  it("adding someone with their own Can edit everything to a group whose whole-vault level is lower is asked; using the group's removes it", async () => {
    const f = await fixture();
    const fresh = await group(f.org, "New");
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'vault', $2, 'group', $3, 'denied')`,
      [randomUUID(), f.org, fresh],
    );
    await seedUserVaultGrant(f.org, f.sam, "edit");
    const leo = await seedUser(`leo-${randomUUID().slice(0, 8)}@held.test`);
    await seedMember(f.org, leo, "member");
    const held = await heldByOwnSettings({ orgId: f.org, actorUserId: f.owner, groupId: fresh, addUserIds: [f.sam, leo] });
    // Leo has nothing of his own: never listed.
    expect(held).toEqual([
      { userId: f.sam, resourceType: "vault", resourceId: f.org, current: "edit", groupGives: "none", ownAt: "here", ownPlace: { resourceType: "vault", resourceId: f.org }, placeName: null },
    ]);
    await join(f.org, fresh, f.sam);
    const out = await letGroupDecide({ orgId: f.org, actorUserId: f.owner, groupId: fresh, entries: [{ userId: f.sam, resourceType: "vault", resourceId: f.org }] });
    expect(out[0]).toMatchObject({ action: "removed", before: "edit" });
    const own = await pool.query("SELECT 1 FROM shares WHERE principal_type = 'user' AND principal_id = $1", [f.sam]);
    expect(own.rowCount).toBe(0);
    // Their groups decide now: Sales still gives Specs.
    expect(await effectivePermission(f.sam, f.spec)).toBe("edit");
    expect(await effectivePermission(f.sam, f.other)).toBe("none");
  });

  it("a group's No access on a folder asks only people whose own setting sits on that folder", async () => {
    const f = await fixture();
    // The group's No access is real only under a grant of its own from above.
    await groupRow(f.org, f.sales, "vault", f.org, "view");
    await userRow(f.org, "folder", f.specs, f.ana, "edit"); // Ana: on the folder itself
    await seedUserVaultGrant(f.org, f.sam, "edit"); // Sam: wider, vault-wide
    const held = await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: f.specs }], mode: "private" },
    });
    expect(held.map((h) => [h.userId, h.current, h.groupGives, h.ownAt])).toEqual([[f.ana, "edit", "none", "here"]]);
    expect(held[0]!.placeName).toBe("Specs");
  });

  it("a No access where no grant of the group's from above reaches asks nobody (the group just stops giving)", async () => {
    const f = await fixture();
    await userRow(f.org, "folder", f.specs, f.ana, "edit");
    expect(await heldByOwnSettings({
      orgId: f.org, actorUserId: f.owner, groupId: f.sales,
      access: { resources: [{ resourceType: "folder", resourceId: f.specs }], mode: "private" },
    })).toEqual([]);
  });

  it("Use the group's never removes an own setting where the group has no setting, whatever the caller sends", async () => {
    const f = await fixture();
    const fresh = await group(f.org, "Empty");
    await seedUserVaultGrant(f.org, f.sam, "edit");
    await join(f.org, fresh, f.sam);
    const out = await letGroupDecide({ orgId: f.org, actorUserId: f.owner, groupId: fresh, entries: [{ userId: f.sam, resourceType: "vault", resourceId: f.org }] });
    expect(out[0]).toMatchObject({ action: "skipped", before: "edit", after: "edit" });
    expect(await effectivePermission(f.sam, f.other)).toBe("edit");
  });

  it("Keep writes nothing: every setting just for them stays", async () => {
    const f = await fixture();
    const fresh = await group(f.org, "New");
    await seedUserVaultGrant(f.org, f.sam, "edit");
    const before = (await pool.query("SELECT resource_type, resource_id, permission FROM shares WHERE principal_id = $1 ORDER BY 1, 2", [f.sam])).rows;
    await heldByOwnSettings({ orgId: f.org, actorUserId: f.owner, groupId: fresh, addUserIds: [f.sam] });
    await join(f.org, fresh, f.sam);
    const after = (await pool.query("SELECT resource_type, resource_id, permission FROM shares WHERE principal_id = $1 ORDER BY 1, 2", [f.sam])).rows;
    expect(after).toEqual(before);
    expect(await effectivePermission(f.sam, f.other)).toBe("edit");
  });
});
