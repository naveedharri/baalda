import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAccessContextFromIndex,
  createResolverCache,
  effectivePermission,
  loadAccessIndex,
  resolveAccessForUser,
  type Permission,
} from "../src/permissions/resolver.js";
import { listReadableDocsInVault, listVisibleFolders } from "../src/permissions/vault-docs.js";
import { applyBulkAccess } from "../src/permissions/access-management.js";
import {
  addGroupMembers,
  applyInvitationGroups,
  createGroup,
  deleteGroup,
  listGroups,
  removeGroupMember,
} from "../src/groups/service.js";
import { boardModes, encodeBoardModes } from "../src/permissions/access-board.js";
import { pool } from "../src/db/pool.js";
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
 * Access groups (migration 097). Groups only ADD: a member gets the higher of
 * what they had and what any of their groups gives, a person's own vault-wide
 * level ignores groups entirely, and per-user denies/caps and locks still
 * apply. The resolver, its cached/prefetched/indexed paths and the readable
 * set must all agree for every (user, doc) — a disagreement is a stalled
 * revocation or a healing loop, not a 403.
 */

type Posture = "shared" | "read-only" | "sealed" | "never-shared";

async function group(org: string, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO access_groups (id, organization_id, name) VALUES ($1, $2, $3)",
    [id, org, name],
  );
  return id;
}
async function join(org: string, groupId: string, userId: string) {
  await pool.query(
    "INSERT INTO access_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3)",
    [groupId, org, userId],
  );
}
async function grant(
  org: string,
  groupId: string,
  type: "vault" | "folder" | "file",
  id: string,
  permission: "view" | "edit" | "denied",
  // Written through the access API, a group row gets the next ACL revision,
  // so it is newer than any join snapshot; 0 is a converted Everyone row
  // (migration 101 marks those `legacy_team_grant`).
  revision = 1,
) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision, legacy_team_grant)
     VALUES ($1, $2, $3, $4, 'group', $5, $6, $7, $8)`,
    [randomUUID(), org, type, id, groupId, permission, revision, revision === 0],
  );
}
async function readonlyCap(org: string, type: "folder" | "file", id: string, userId: string) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, 'readonly')`,
    [randomUUID(), org, type, id, userId],
  );
}

async function buildFixture(slug: string, posture: Posture, groupVault: boolean) {
  const org = await seedOrg(`Groups ${slug}`, `groups-${slug}`);
  const u = async (n: string) => seedUser(`${n}-${slug}@g.test`);
  const owner = await u("owner");
  const admin = await u("admin");
  const member = await u("member");
  const both = await u("both"); // Design + Ops
  const personal = await u("personal"); // Design, but a vault level of their own
  const capped = await u("capped"); // Ops, with a per-user readonly on Team
  const blocked = await u("blocked"); // Design, per-user deny on Projects
  const joiner = await u("joiner"); // Design, joined after everything (Private)
  for (const [id, role] of [
    [owner, "owner"],
    [admin, "admin"],
    [member, "member"],
    [both, "member"],
    [personal, "member"],
    [capped, "member"],
    [blocked, "member"],
    [joiner, "member"],
  ] as const) {
    await seedMember(org, id, role);
  }
  const vault = await seedVault(org);
  if (posture === "shared") await seedVaultGrant(org, "edit");
  if (posture === "read-only") await seedVaultGrant(org, "view");
  if (posture === "sealed") await sealVault(org);

  const top = await seedFolder(vault, null, "Projects", "Projects", owner);
  const mid = await seedFolder(vault, top, "Alpha", "Projects/Alpha", owner);
  const locked = await seedFolder(vault, null, "Frozen", "Frozen", owner);
  const priv = await seedFolder(vault, null, "Secret", "Secret", owner);
  const team = await seedFolder(vault, null, "Team", "Team", owner);
  const hiddenDir = await seedFolder(vault, top, "Hidden", "Projects/Hidden", owner);
  const docs = [
    await seedNote(vault, null, "root.md", owner),
    await seedNote(vault, null, "mine.md", member),
    await seedNote(vault, top, "Projects/brief.md", owner),
    await seedNote(vault, mid, "Projects/Alpha/spec.md", member),
    await seedNote(vault, locked, "Frozen/contract.md", owner),
    await seedNote(vault, priv, "Secret/keys.md", owner),
    await seedNote(vault, team, "Team/plan.md", owner),
    await seedFile(vault, mid, "Projects/Alpha/diagram.png"),
    await seedFile(vault, priv, "Secret/cover.png"),
    await seedNote(vault, hiddenDir, "Projects/Hidden/salaries.md", owner),
  ];

  const design = await group(org, "Design");
  const ops = await group(org, "Ops");
  for (const x of [both, personal, blocked, joiner]) await join(org, design, x);
  for (const x of [both, capped]) await join(org, ops, x);

  await grant(org, design, "folder", top, "view"); // inherited two levels
  await grant(org, design, "file", docs[3], "edit"); // a deeper file beats its folder
  await grant(org, ops, "folder", priv, "edit"); // lifts out of an item Private
  await grant(org, ops, "file", docs[4], "edit"); // a lock still caps it
  await grant(org, ops, "folder", team, "edit"); // capped by a per-user readonly
  if (groupVault) await grant(org, ops, "vault", org, "edit");
  await grant(org, design, "folder", hiddenDir, "denied"); // Design: No access below its view
  // A converted Everyone-style row: written before the joiner's snapshot.
  const legacy = await group(org, "Legacy");
  await join(org, legacy, joiner);
  await grant(org, legacy, "vault", org, "view", 0);

  await seedItemPrivate(org, "folder", priv);
  await seedLock(org, "folder", locked, { type: "org" });
  await seedUserVaultGrant(org, personal, "view");
  await readonlyCap(org, "folder", team, capped);
  await seedDeny(org, "folder", top, blocked);
  await pool.query(
    `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
     VALUES ($1, $2, 'private', 0, now() + interval '1 day')
     ON CONFLICT (organization_id, user_id)
       DO UPDATE SET mode = 'private', access_revision = 0, snapshot_at = now() + interval '1 day'`,
    [org, joiner],
  );
  const roles = new Map<string, string>([
    [owner, "owner"], [admin, "admin"], [member, "member"], [both, "member"],
    [personal, "member"], [capped, "member"], [blocked, "member"], [joiner, "member"],
  ]);
  return {
    org, vault, docs, design, ops, roles,
    folders: { top, mid, locked, priv, team },
    users: { owner, admin, member, both, personal, capped, blocked, joiner },
  };
}

afterAll(async () => {
  await pool.end();
});

describe("access groups: one algebra everywhere", () => {
  beforeEach(async () => {
    await resetDb();
  });

  for (const posture of ["shared", "read-only", "sealed", "never-shared"] as const) {
    for (const groupVault of [false, true]) {
      it(`uncached ≡ cached ≡ prefetched ≡ indexed ≡ readable set — ${posture}${groupVault ? " + group vault edit" : ""}`, async () => {
        const f = await buildFixture(`${posture}-${groupVault}`, posture, groupVault);
        const users = Object.values(f.users);
        const index = await loadAccessIndex(pool, f.org);
        for (const user of users) {
          const plain = createResolverCache();
          const batch = createResolverCache();
          await batch.prefetch(pool, f.docs);
          const shared = createResolverCache();
          const set = await listReadableDocsInVault(user, f.vault);
          const visible = new Set((await listVisibleFolders(user, f.vault)).map((x) => x.id));
          for (const doc of f.docs) {
            const truth = await effectivePermission(user, doc);
            const label = `user=${user} doc=${doc} truth=${truth}`;
            expect(await effectivePermission(user, doc, pool, plain), label).toBe(truth);
            expect(await effectivePermission(user, doc, pool, batch), label).toBe(truth);
            const ctx = await buildAccessContextFromIndex(index, "file", doc, pool, shared);
            const indexed = (await resolveAccessForUser(ctx!, user, f.roles.get(user)!, pool, shared, index)).permission;
            expect(indexed, label).toBe(truth);
            expect(set.has(doc), label).toBe(truth !== "none");
          }
          // Every readable doc's folder is navigable.
          const { rows } = await pool.query<{ folder_id: string | null }>(
            `SELECT folder_id FROM notes WHERE id = ANY($1) UNION ALL SELECT folder_id FROM files WHERE id = ANY($1)`,
            [[...set]],
          );
          for (const r of rows) if (r.folder_id) expect(visible.has(r.folder_id), `folder ${r.folder_id}`).toBe(true);
        }
      });
    }
  }

  it("concrete answers in a never-shared vault", async () => {
    const f = await buildFixture("concrete", "never-shared", false);
    const [root, mine, brief, spec, contract, keys, plan, diagram, cover] = f.docs;
    const p = (user: string, doc: string) => effectivePermission(user, doc);
    const { member, both, personal, capped, blocked, joiner } = f.users;

    // No group: only what they wrote.
    expect(await p(member, mine)).toBe("edit");
    expect(await p(member, brief)).toBe("none");
    // Design view on Projects, Design edit on spec, Ops edit on Secret (out of
    // an item Private), Ops edit on contract capped by the Frozen lock.
    expect(await p(both, root)).toBe("none");
    expect(await p(both, brief)).toBe("view");
    expect(await p(both, spec)).toBe("edit");
    expect(await p(both, diagram)).toBe("view");
    expect(await p(both, keys)).toBe("edit");
    expect(await p(both, cover)).toBe("edit");
    expect(await p(both, contract)).toBe("view");
    expect(await p(both, plan)).toBe("edit");
    // A vault level of their own (Can view) combines with groups: Design's
    // edit on spec wins there, view everywhere else.
    expect(await p(personal, spec)).toBe("edit");
    expect(await p(personal, root)).toBe("view");
    // A group's No access stops only that group: Design's view of Projects
    // does not reach Projects/Hidden, and Ops never reached it.
    const salaries = f.docs[9];
    expect(await p(both, salaries)).toBe("none");
    expect(await p(personal, salaries)).toBe("view"); // their own Can view still reaches it
    // A per-user readonly caps the group's edit.
    expect(await p(capped, plan)).toBe("view");
    // A per-user deny beats the group.
    expect(await p(blocked, brief)).toBe("none");
    expect(await p(blocked, spec)).toBe("none");
    // A Private join snapshot is lifted by a group grant, like a named grant.
    expect(await p(joiner, brief)).toBe("view");
    expect(await p(joiner, root)).toBe("none");
    // A group grant the snapshot already accounts for (an older revision) does
    // not open pre-join content, like an org grant.
    expect(await p(joiner, f.docs[6])).toBe("none");
    expect(await p(joiner, f.docs[9])).toBe("none");
  });

  it("a group's whole-vault edit opens the vault even when sealed, but not past a person's own level", async () => {
    const f = await buildFixture("vault", "sealed", true);
    const [root, , brief, , contract] = f.docs;
    expect(await effectivePermission(f.users.capped, root)).toBe("edit");
    expect(await effectivePermission(f.users.capped, brief)).toBe("edit");
    expect(await effectivePermission(f.users.capped, contract)).toBe("view"); // the lock
    expect(await effectivePermission(f.users.capped, f.docs[6])).toBe("view"); // own readonly
    expect(await effectivePermission(f.users.member, root)).toBe("none");
  });
});

describe("group management", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("removing a member takes away exactly what the group gave and kicks the docs", async () => {
    const f = await buildFixture("remove", "never-shared", false);
    const kicked: string[] = [];
    const acl: string[] = [];
    const deps = { disconnectDoc: (_v: string, d: string) => void kicked.push(d), onAclChanged: (v: string) => void acl.push(v) };
    const [, , brief, spec] = f.docs;
    expect(await effectivePermission(f.users.joiner, brief)).toBe("view");
    const out = await removeGroupMember(f.org, f.users.owner, f.design, f.users.joiner, deps);
    expect(out.removed).toBe(true);
    expect(await effectivePermission(f.users.joiner, brief)).toBe("none");
    expect(kicked).toEqual(expect.arrayContaining([brief, spec]));
    expect(acl).toContain(f.vault);
    // The other members keep it.
    expect(await effectivePermission(f.users.both, brief)).toBe("view");
  });

  it("admins cannot change the owner's groups; plain members cannot manage at all", async () => {
    const f = await buildFixture("perm", "never-shared", false);
    await expect(addGroupMembers(f.org, f.users.admin, f.design, [f.users.owner])).rejects.toMatchObject({
      code: "access_manager_required",
    });
    await expect(addGroupMembers(f.org, f.users.member, f.design, [f.users.member])).rejects.toMatchObject({
      code: "access_manager_required",
    });
    expect((await addGroupMembers(f.org, f.users.admin, f.design, [f.users.member])).added).toBe(1);
    expect((await addGroupMembers(f.org, f.users.owner, f.design, [f.users.owner])).added).toBe(1);
  });

  it("deleting a group removes its grants", async () => {
    const f = await buildFixture("delete", "never-shared", false);
    const brief = f.docs[2];
    await deleteGroup(f.org, f.users.owner, f.design);
    expect(await effectivePermission(f.users.joiner, brief)).toBe("none");
    const { rowCount } = await pool.query("SELECT 1 FROM shares WHERE principal_id = $1", [f.design]);
    expect(rowCount).toBe(0);
  });

  it("removing someone from the vault removes them from its groups", async () => {
    const f = await buildFixture("leave", "never-shared", false);
    await pool.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [f.org, f.users.both]);
    const { rowCount } = await pool.query("SELECT 1 FROM access_group_members WHERE user_id = $1", [f.users.both]);
    expect(rowCount).toBe(0);
  });

  it("names are unique per vault, case-insensitively", async () => {
    const f = await buildFixture("names", "never-shared", false);
    await expect(createGroup(f.org, f.users.owner, { name: "design" })).rejects.toMatchObject({ code: "group_name_taken" });
    const made = await createGroup(f.org, f.users.owner, { name: "  Sales  ", memberIds: [f.users.member] });
    const list = await listGroups(f.org, f.users.owner);
    const sales = list.groups.find((g) => g.id === made.id)!;
    expect(sales.name).toBe("Sales");
    expect(sales.memberIds).toEqual([f.users.member]);
    // Plain members see groups and members, not grants.
    const seen = await listGroups(f.org, f.users.member);
    expect(seen.canManage).toBe(false);
    expect(seen.groups.every((g) => g.grants === null)).toBe(true);
  });

  it("auto-join groups take in new members", async () => {
    const f = await buildFixture("auto", "never-shared", false);
    await pool.query("UPDATE access_groups SET auto_join = true WHERE id = $1", [f.ops]);
    const late = await seedUser("late-auto@g.test");
    await seedMember(f.org, late, "member");
    const { rows } = await pool.query<{ group_id: string }>(
      "SELECT group_id FROM access_group_members WHERE user_id = $1",
      [late],
    );
    expect(rows.map((r) => r.group_id)).toEqual([f.ops]);
  });

  it("invitation groups apply on acceptance", async () => {
    const f = await buildFixture("invite", "never-shared", false);
    const late = await seedUser("late-invite@g.test");
    const inv = randomUUID();
    await pool.query(
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt")
       VALUES ($1, $2, 'late-invite@g.test', 'member', 'pending', now() + interval '1 day', $3, now())`,
      [inv, f.org, f.users.owner],
    );
    await pool.query("INSERT INTO invitation_groups (invitation_id, group_id) VALUES ($1, $2)", [inv, f.design]);
    await seedMember(f.org, late, "member");
    expect(await applyInvitationGroups({ invitationIds: [inv], organizationId: f.org, userId: late })).toBe(1);
    expect(await effectivePermission(late, f.docs[2])).toBe("view");
  });
});

describe("group access through bulk access", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("writes edit/view rows, No access removes them, and Everyone never clears them", async () => {
    const f = await buildFixture("bulk", "never-shared", false);
    const sales = (await createGroup(f.org, f.users.owner, { name: "Sales", memberIds: [f.users.member] })).id;
    const root = f.docs[0];
    const audience = { type: "group" as const, groupId: sales };
    const res = [{ resourceType: "folder" as const, resourceId: f.folders.team }];

    await applyBulkAccess({ organizationId: f.org, actorUserId: f.users.owner, resources: res, audience, mode: "open" });
    expect(await effectivePermission(f.users.member, f.docs[6])).toBe("edit");
    await applyBulkAccess({ organizationId: f.org, actorUserId: f.users.owner, resources: res, audience, mode: "readonly" });
    expect(await effectivePermission(f.users.member, f.docs[6])).toBe("view");

    // The Everyone row on the same folder leaves the group's row standing.
    await applyBulkAccess({
      organizationId: f.org, actorUserId: f.users.owner, resources: res, audience: { type: "org" }, mode: "private",
    });
    expect(await effectivePermission(f.users.member, f.docs[6])).toBe("view");

    await applyBulkAccess({ organizationId: f.org, actorUserId: f.users.owner, resources: res, audience, mode: "private" });
    expect(await effectivePermission(f.users.member, f.docs[6])).toBe("none");

    // Whole vault for a group, then the group's board.
    await applyBulkAccess({
      organizationId: f.org, actorUserId: f.users.owner,
      resources: [{ resourceType: "vault", resourceId: f.org }], audience, mode: "readonly",
    });
    expect(await effectivePermission(f.users.member, root)).toBe("view");
    const { rows } = await pool.query("SELECT permission FROM shares WHERE principal_type = 'group' AND principal_id = $1", [sales]);
    expect(rows).toEqual([{ permission: "view" }]);
  });

  it("a group write kicks open docs only when it narrows what the group gave", async () => {
    const f = await buildFixture("kick", "never-shared", false);
    const sales = (await createGroup(f.org, f.users.owner, { name: "Sales", memberIds: [f.users.member] })).id;
    const audience = { type: "group" as const, groupId: sales };
    const res = [{ resourceType: "folder" as const, resourceId: f.folders.team }];
    const run = async (mode: "open" | "readonly" | "private") => {
      const kicked: string[] = [];
      const acl: string[] = [];
      const out = await applyBulkAccess(
        { organizationId: f.org, actorUserId: f.users.owner, resources: res, audience, mode },
        { disconnectDoc: (_v, d) => void kicked.push(d), onAclChanged: (v) => void acl.push(v) },
      );
      return { kicked: kicked.length, reported: out.disconnectedDocs, acl: acl.length };
    };
    // Adding or raising never takes anything away: nobody reconnects, clients still hear about it.
    expect(await run("readonly")).toMatchObject({ kicked: 0, reported: 0, acl: 1 });
    expect(await run("open")).toMatchObject({ kicked: 0, reported: 0, acl: 1 });
    expect(await run("open")).toMatchObject({ kicked: 0, reported: 0 });
    // Edit → view and view → No access narrow: the folder's open docs re-authenticate.
    const down = await run("readonly");
    expect(down.kicked).toBeGreaterThan(0);
    expect(down.reported).toBe(down.kicked);
    expect((await run("private")).kicked).toBeGreaterThan(0);
    // No access when the group gave nothing there already: nothing to take away.
    expect((await run("private")).kicked).toBe(0);
  });

  it("a group's board is what its own rows give", async () => {
    const f = await buildFixture("board", "shared", false);
    const index = await loadAccessIndex(pool, f.org);
    const folderIds = Object.values(f.folders);
    const noteIds = f.docs.slice(0, 7);
    const fileIds = f.docs.slice(7);
    const items = { folderIds, noteIds, fileIds };
    const result = await boardModes({
      db: pool, index, cache: createResolverCache(), vaultId: f.vault, userId: "", role: null, groupId: f.design, items,
    });
    const modes = encodeBoardModes(result, items);
    // folders: Projects (view + spec edit = mixed), Alpha (spec edit, diagram view = mixed),
    // Frozen none, Secret none, Team none; notes: root n, mine n, brief v, spec e, contract n, keys n, plan n;
    // files: diagram v, cover n.
    // (+ salaries, under Design's own No access.)
    expect(modes).toBe("mmnnn" + "nnvennn" + "vn" + "n");
  });

  it("No access for a group below its own grant writes a group No access row", async () => {
    const f = await buildFixture("group-no-access", "sealed", false);
    const [, , brief, , , , plan, diagram] = f.docs;
    const audience = { type: "group" as const, groupId: f.design };
    expect(await effectivePermission(f.users.both, diagram)).toBe("view");
    await applyBulkAccess({
      organizationId: f.org, actorUserId: f.users.owner,
      resources: [{ resourceType: "folder", resourceId: f.folders.mid }], audience, mode: "private",
    });
    const rows = await pool.query(
      "SELECT permission FROM shares WHERE principal_type = 'group' AND principal_id = $1 AND resource_id = $2",
      [f.design, f.folders.mid],
    );
    expect(rows.rows.map((r) => r.permission)).toEqual(["denied"]);
    expect(await effectivePermission(f.users.both, diagram)).toBe("none");
    expect(await effectivePermission(f.users.both, brief)).toBe("view");
    expect((await listReadableDocsInVault(f.users.both, f.vault)).has(diagram)).toBe(false);
    // Where the group reached nothing from above, No access is just no row.
    await applyBulkAccess({
      organizationId: f.org, actorUserId: f.users.owner,
      resources: [{ resourceType: "folder", resourceId: f.folders.team }], audience, mode: "private",
    });
    const none = await pool.query(
      "SELECT 1 FROM shares WHERE principal_type = 'group' AND principal_id = $1 AND resource_id = $2",
      [f.design, f.folders.team],
    );
    expect(none.rowCount).toBe(0);
    expect(await effectivePermission(f.users.both, plan)).toBe("edit"); // Ops still gives it
  });
});
