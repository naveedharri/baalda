import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import {
  buildAccessContext,
  buildAccessContextFromIndex,
  createResolverCache,
  loadAccessIndex,
  resolveAccessForUser,
} from "../src/permissions/resolver.js";
import { summarizeAccess, summaryTargetsFromIndex } from "../src/permissions/access-summary.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedDeny,
  seedFile,
  seedFolder,
  seedItemPrivate,
  seedLock,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * The Access panel's summaries read share rows from a preloaded
 * {@link loadAccessIndex} instead of querying per note. The verdict must be
 * bit-for-bit what the per-query resolver returns — this is the drift test.
 */

afterAll(async () => {
  await pool.end();
});

async function seedOrgGrant(orgId: string, type: "folder" | "file", id: string, permission: "edit" | "view") {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'org', $1, $4)`,
    [orgId, type, id, permission],
  );
}

type Posture = "edit" | "view" | "sealed" | "none";

async function fixture(posture: Posture) {
  await resetDb();
  const orgId = await seedOrg("Index Co", `index-co-${posture}`);
  const other = await seedOrg("Other Co", `other-co-${posture}`);
  const owner = await seedUser(`owner-${posture}@index.test`);
  const admin = await seedUser(`admin-${posture}@index.test`);
  const member = await seedUser(`member-${posture}@index.test`);
  const joiner = await seedUser(`joiner-${posture}@index.test`);
  await seedMember(orgId, owner, "owner");
  await seedMember(orgId, admin, "admin");
  await seedMember(orgId, member, "member");
  await seedMember(orgId, joiner, "member");
  // A joiner whose snapshot predates nothing: everything existed when they joined.
  await pool.query(
    `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
     VALUES ($1, $2, 'readonly', 0, now() + interval '1 day')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET mode = 'readonly', snapshot_at = now() + interval '1 day'`,
    [orgId, joiner],
  );
  if (posture === "edit" || posture === "view") await seedVaultGrant(orgId, posture);
  if (posture === "sealed") await sealVault(orgId);

  const vault = await seedVault(orgId);
  const vault2 = await seedVault(orgId, "Second");
  const otherVault = await seedVault(other);
  const a = await seedFolder(vault, null, "A", "A");
  const ab = await seedFolder(vault, a, "B", "A/B");
  const abc = await seedFolder(vault, ab, "C", "A/B/C");
  const priv = await seedFolder(vault, null, "Private", "Private");
  const locked = await seedFolder(vault, null, "Locked", "Locked");
  const second = await seedFolder(vault2, null, "S", "S");
  const foreign = await seedFolder(otherVault, null, "X", "X");

  const docs = [
    await seedNote(vault, null, "root.md", owner),
    await seedNote(vault, null, "mine.md", member),
    await seedNote(vault, a, "A/a.md", admin),
    await seedNote(vault, ab, "A/B/b.md", member),
    await seedNote(vault, abc, "A/B/C/c.md"),
    await seedNote(vault, priv, "Private/p.md", member),
    await seedNote(vault, locked, "Locked/l.md"),
    await seedNote(vault2, second, "S/s.md"),
    await seedFile(vault, ab, "A/B/pic.png"),
    await seedFile(vault, null, "top.pdf"),
  ];
  const deleted = await seedNote(vault, a, "A/gone.md", member);
  await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [deleted]);
  await seedNote(otherVault, foreign, "X/x.md");

  await seedShare(orgId, "folder", ab, member, "view");
  await seedShare(orgId, "file", docs[4], joiner, "edit");
  await seedOrgGrant(orgId, "folder", abc, "edit");
  await seedOrgGrant(orgId, "file", docs[9], "view");
  await seedItemPrivate(orgId, "folder", priv);
  await seedDeny(orgId, "file", docs[3], admin);
  await seedLock(orgId, "folder", locked, { type: "org" });
  await seedLock(orgId, "file", docs[2], { type: "user", id: member });
  await seedUserVaultGrant(orgId, joiner, "view");

  return {
    orgId,
    users: [owner, admin, member, joiner],
    resources: [
      ...[a, ab, abc, priv, locked, second].map((id) => ({ resourceType: "folder" as const, resourceId: id })),
      ...docs.map((id) => ({ resourceType: "file" as const, resourceId: id })),
    ],
    folders: { a, ab, priv },
    deleted,
  };
}

describe("access index", () => {
  beforeEach(async () => {
    await resetDb();
  });

  for (const posture of ["edit", "view", "sealed", "none"] as const) {
    it(`accessIndexMatchesQueries — ${posture} posture`, async () => {
      const f = await fixture(posture);
      const index = await loadAccessIndex(pool, f.orgId);
      const roles = new Map<string, string>();
      for (const u of f.users) {
        const { rows } = await pool.query<{ role: string }>(
          `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
          [f.orgId, u],
        );
        roles.set(u, rows[0].role);
      }
      for (const resource of f.resources) {
        const plain = await buildAccessContext(resource.resourceType, resource.resourceId, pool);
        const indexed = await buildAccessContextFromIndex(index, resource.resourceType, resource.resourceId, pool);
        expect(indexed).toEqual(plain);
        for (const user of f.users) {
          const expected = await resolveAccessForUser(plain!, user, roles.get(user)!, pool);
          const actual = await resolveAccessForUser(indexed!, user, roles.get(user)!, pool, createResolverCache(), index);
          expect({ resource, user, access: actual }).toEqual({ resource, user, access: expected });
        }
      }
    });
  }

  it("expands roots like the recursive query: live notes only, descendants included", async () => {
    const f = await fixture("edit");
    const index = await loadAccessIndex(pool, f.orgId);
    const ids = (roots: Parameters<typeof summaryTargetsFromIndex>[1]) =>
      summaryTargetsFromIndex(index, roots).map((t) => t.resourceId).sort();
    const underA = ids([{ resourceType: "folder", resourceId: f.folders.a }]);
    expect(underA).not.toContain(f.deleted);
    expect(underA).toHaveLength(3 + 3 + 1); // A, A/B, A/B/C + a, b, c + pic
    const vault = ids([{ resourceType: "vault", resourceId: f.orgId }]);
    expect(vault).toHaveLength(6 + 10);
  });

  it("summarizes each group independently", async () => {
    const f = await fixture("edit");
    const index = await loadAccessIndex(pool, f.orgId);
    const [owner, admin, member] = f.users;
    const roles = new Map([[owner, "owner"], [admin, "admin"], [member, "member"]]);
    const modes = await summarizeAccess({
      db: pool,
      index,
      cache: createResolverCache(),
      groups: [
        [{ resourceType: "folder", resourceId: f.folders.priv }],
        [{ resourceType: "folder", resourceId: f.folders.a }],
      ],
      userIds: [owner],
      roles,
    });
    // Private folder: the owner is not the author of p.md and has no grant.
    expect(modes[0]).toBe("private");
    // A has a member-only lock on a.md but the owner edits all of A.
    expect(modes[1]).toBe("open");
  });
});
