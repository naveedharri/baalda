// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { canCreateIn, canEditFolder, canWriteAttachment } from "../src/permissions/http-gates.js";
import { listDeletedReadableDocsInVault, listReadableDocsInVault, listVisibleFolders } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedUserVaultGrant,
  seedVault,
} from "./helpers/seed.js";

/**
 * Migration 101 moves every vault to the 2026-11-25 access model. It has run
 * against the test database already; it skips organizations it logged, so the
 * fixtures below (new organizations) are converted by re-applying its SQL.
 * The contract: nobody gains or loses anything, owners and admins included.
 */
const CONVERT_SQL = readFileSync(
  new URL("../migrations/101_access_model_conversion.sql", import.meta.url),
  "utf8",
);

async function row(org: string, sql: string, params: unknown[] = []) {
  return (await pool.query(sql, [org, ...params])).rows;
}

async function orgRow(org: string, resourceType: string, resourceId: string, permission: string, revision = 0) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
     VALUES ($1, $2, $3, $4, 'org', $2, $5, $6)`,
    [randomUUID(), org, resourceType, resourceId, permission, revision],
  );
}

async function joinDefault(org: string, mode: "open" | "readonly" | "private") {
  await pool.query(
    `INSERT INTO organization_access_settings (organization_id, join_default) VALUES ($1, $2)
     ON CONFLICT (organization_id) DO UPDATE SET join_default = $2`,
    [org, mode],
  );
}

/** Every person's answer for every note and folder, plus the readable set. */
async function picture(people: Record<string, string>, vault: string, docs: string[]) {
  const out: Record<string, unknown> = {};
  for (const [name, user] of Object.entries(people)) {
    const modes: string[] = [];
    for (const d of docs) modes.push(await effectivePermission(user, d));
    out[name] = {
      modes,
      readable: [...(await listReadableDocsInVault(user, vault))].sort(),
      folders: (await listVisibleFolders(user, vault)).map((f) => f.id).sort(),
      deleted: [...(await listDeletedReadableDocsInVault(user, vault))].sort(),
    };
  }
  return out;
}

describe("migration 101: every vault on the new access model", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("a Can edit vault gets an Everyone group and keeps everyone's access", async () => {
    const org = await seedOrg("Open team", `open-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    const admin = await seedUser(`a-${randomUUID()}@t.dev`);
    const plain = await seedUser(`m-${randomUUID()}@t.dev`);
    const viewer = await seedUser(`v-${randomUUID()}@t.dev`);
    const late = await seedUser(`l-${randomUUID()}@t.dev`);
    const openLate = await seedUser(`ol-${randomUUID()}@t.dev`);
    for (const [u, r] of [[owner, "owner"], [admin, "admin"], [plain, "member"], [viewer, "member"], [late, "member"], [openLate, "member"]] as const)
      await seedMember(org, u, r);
    const vault = await seedVault(org);
    const docsF = await seedFolder(vault, null, "Docs", "Docs", owner);
    const secretF = await seedFolder(vault, null, "Secret", "Secret", owner);
    const emptyF = await seedFolder(vault, null, "Empty", "Empty", owner);
    const d1 = await seedNote(vault, docsF, "Docs/a.md", owner);
    const d2 = await seedNote(vault, secretF, "Secret/b.md", owner);
    // Deleted notes: the tombstone list must follow the same rules.
    const gone1 = await seedNote(vault, docsF, "Docs/gone.md", owner);
    const gone2 = await seedNote(vault, secretF, "Secret/gone.md", owner);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = ANY($1)", [[gone1, gone2]]);
    await orgRow(org, "vault", org, "edit", 1);
    await orgRow(org, "folder", secretF, "denied", 2);
    await seedUserVaultGrant(org, admin, "view");
    await seedUserVaultGrant(org, viewer, "view");
    await joinDefault(org, "open");
    // `late` joined after the content existed, when new members saw nothing
    // (the snapshot trigger is gone; this is the row it wrote then).
    await pool.query("UPDATE notes SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await pool.query("UPDATE folders SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await pool.query(
      `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
       VALUES ($1, $2, 'private', 5, now() - interval '1 day'), ($1, $3, 'open', 5, now() - interval '1 day')`,
      [org, late, openLate],
    );
    const d3 = await seedNote(vault, docsF, "Docs/after-join.md", owner);
    // An empty folder made after `late` joined: Private joiners never saw
    // empty folders through the team's level, so the group must not add it.
    const postJoinEmpty = await seedFolder(vault, null, "Later", "Later", owner);
    const docs = [d1, d2, d3];
    const people = { owner, admin, plain, viewer, late, openLate };

    const before = await picture(people, vault, docs);
    await pool.query(CONVERT_SQL);
    const after = await picture(people, vault, docs);

    expect(before.plain).toMatchObject({ modes: ["edit", "none", "edit"] });
    // A person's own vault level is absolute: an item hidden from the team does not apply.
    expect(before.viewer).toMatchObject({ modes: ["view", "view", "view"] });
    expect(before.late).toMatchObject({ modes: ["none", "none", "edit"] });
    for (const name of ["plain", "viewer", "late", "openLate"]) expect(after[name], name).toEqual(before[name]);
    // A Private joiner is not told about notes deleted before they joined, and
    // nobody the team cannot reach hears of a note deleted in Secret.
    expect((after.late as { deleted: string[] }).deleted).toEqual([]);
    expect((after.plain as { deleted: string[] }).deleted).toEqual([gone1]);
    expect((after.openLate as { deleted: string[] }).deleted).toEqual([gone1]);
    // Owners and admins keep exactly what they had: Secret stays hidden from
    // the owner, and the admin's own Can view stays theirs.
    expect(before.admin).toMatchObject({ modes: ["view", "view", "view"] });
    expect(before.owner).toMatchObject({ modes: ["edit", "none", "edit"] });
    for (const name of ["owner", "admin"]) expect(after[name], name).toEqual(before[name]);
    expect((after.plain as { folders: string[] }).folders).toContain(emptyF);
    expect((after.late as { folders: string[] }).folders).not.toContain(postJoinEmpty);
    expect((after.late as { folders: string[] }).folders).not.toContain(emptyF);

    // New members started on Can edit here: they need no join snapshot, the
    // Everyone group (auto_join) gives them everything, as before.
    const newcomerSnap = await seedUser(`n-${randomUUID()}@t.dev`);
    await seedMember(org, newcomerSnap, "member");
    expect((await row(org, "SELECT 1 FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2", [newcomerSnap])).length).toBe(0);
    await pool.query('DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2', [org, newcomerSnap]);

    const [g] = await row(org, "SELECT id, name, auto_join FROM access_groups WHERE organization_id = $1");
    expect(g).toMatchObject({ name: "Everyone", auto_join: true });
    const members = await row(org, "SELECT user_id FROM access_group_members WHERE organization_id = $1");
    expect(members.map((m) => m.user_id).sort()).toEqual([late, openLate, owner, plain].sort());
    const groupRows = await row(org, "SELECT resource_type, resource_id, permission, access_revision FROM shares WHERE org_id = $1 AND principal_type = 'group' ORDER BY resource_type", []);
    expect(groupRows).toEqual([
      { resource_type: "folder", resource_id: secretF, permission: "denied", access_revision: "2" },
      { resource_type: "vault", resource_id: org, permission: "edit", access_revision: "1" },
    ]);
    const [posture] = await row(org, "SELECT permission FROM shares WHERE org_id = $1 AND resource_type = 'vault' AND principal_type = 'org'");
    expect(posture.permission).toBe("denied");
    const [settings] = await row(org, "SELECT join_default FROM organization_access_settings WHERE organization_id = $1");
    expect(settings.join_default).toBe("private");
    const [log] = await row(org, "SELECT old_posture, old_join_default, everyone_group_id FROM access_model_conversion WHERE organization_id = $1");
    expect(log).toEqual({ old_posture: "edit", old_join_default: "open", everyone_group_id: g.id });
    const logged = await row(org, "SELECT action, old_permission FROM access_model_conversion_rows WHERE organization_id = $1 ORDER BY action, old_permission");
    // group vault row + group No access (inserted); posture edit→denied (updated).
    // No owner or admin row: something is hidden from the team here.
    expect(logged).toEqual([
      { action: "inserted", old_permission: null },
      { action: "inserted", old_permission: null },
      { action: "updated", old_permission: "edit" },
    ]);
    expect(await row(org, "SELECT 1 FROM shares WHERE org_id = $1 AND resource_type = 'vault' AND principal_type = 'user' AND principal_id = $2", [owner])).toHaveLength(0);

    // A newcomer now gets the team's level through the group, as before.
    const newcomer = await seedUser(`n-${randomUUID()}@t.dev`);
    await seedMember(org, newcomer, "member");
    expect(await effectivePermission(newcomer, d1)).toBe("edit");
    expect(await effectivePermission(newcomer, d2)).toBe("none");

    // openLate's Can edit join snapshot only repeated what Everyone gives: it is
    // gone (logged for the undo), so the Everyone group's later rows reach them.
    expect(await row(org, "SELECT 1 FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2", [openLate])).toHaveLength(0);
    expect(await row(org, "SELECT mode FROM access_model_conversion_snapshots WHERE organization_id = $1", [])).toEqual([{ mode: "open" }]);
    expect(await row(org, "SELECT 1 FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2", [late])).toHaveLength(1);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
       VALUES ($1, $2, 'folder', $3, 'group', $4, 'denied', 50)`,
      [randomUUID(), org, docsF, g.id],
    );
    expect(await effectivePermission(openLate, d1)).toBe("none");
    expect(await effectivePermission(plain, d1)).toBe("none");
  });

  it("people who join a converted vault later get what they would have got before", async () => {
    const org = await seedOrg("Private joins", `pj-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const old = await seedNote(vault, null, "old.md", owner);
    await pool.query("UPDATE notes SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await orgRow(org, "vault", org, "edit", 1);
    await joinDefault(org, "private");
    // The org's ACL revision is never behind its own rows (as in every real vault).
    await pool.query("UPDATE organization_access_settings SET access_revision = 1 WHERE organization_id = $1", [org]);
    await pool.query(CONVERT_SQL);
    const [g] = await row(org, "SELECT id, auto_join FROM access_groups WHERE organization_id = $1");
    expect(g.auto_join).toBe(true);
    // Joins after the conversion: in Everyone automatically, with the Private
    // join snapshot the old New members setting gave.
    const joiner = await seedUser(`j-${randomUUID()}@t.dev`);
    await seedMember(org, joiner, "member");
    expect(await row(org, "SELECT 1 FROM access_group_members WHERE organization_id = $1 AND user_id = $2", [joiner])).toHaveLength(1);
    expect(await row(org, "SELECT mode FROM member_access_snapshots WHERE organization_id = $1 AND user_id = $2", [joiner])).toEqual([{ mode: "private" }]);
    const fresh = await seedNote(vault, null, "fresh.md", owner);
    await pool.query("UPDATE notes SET created_at = now() + interval '1 minute' WHERE id = $1", [fresh]);
    expect(await effectivePermission(joiner, old)).toBe("none");
    expect(await effectivePermission(joiner, fresh)).toBe("edit");
    // A vault created after the conversion writes no join snapshot.
    const org2 = await seedOrg("New vault", `nv-${randomUUID()}`);
    const o2 = await seedUser(`o2-${randomUUID()}@t.dev`);
    const m2 = await seedUser(`m2-${randomUUID()}@t.dev`);
    await seedMember(org2, o2, "owner");
    await joinDefault(org2, "private");
    await seedMember(org2, m2, "member");
    expect(await row(org2, "SELECT 1 FROM member_access_snapshots WHERE organization_id = $1", [])).toHaveLength(0);
  });

  it("owners and admins get Can edit everything only where they could already edit everything", async () => {
    const org = await seedOrg("Open, nothing hidden", `opennh-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    const admin = await seedUser(`a-${randomUUID()}@t.dev`);
    const lateAdmin = await seedUser(`la-${randomUUID()}@t.dev`);
    const viewAdmin = await seedUser(`va-${randomUUID()}@t.dev`);
    for (const [u, r] of [[owner, "owner"], [admin, "admin"], [lateAdmin, "admin"], [viewAdmin, "admin"]] as const)
      await seedMember(org, u, r);
    const vault = await seedVault(org);
    const f = await seedFolder(vault, null, "Docs", "Docs", owner);
    const d1 = await seedNote(vault, f, "Docs/a.md", owner);
    const d2 = await seedNote(vault, null, "b.md", owner);
    await orgRow(org, "vault", org, "edit", 1);
    await seedUserVaultGrant(org, viewAdmin, "view");
    await pool.query("UPDATE notes SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await pool.query("UPDATE folders SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    // lateAdmin joined under Private: older notes stay hidden from them.
    await pool.query(
      `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
       VALUES ($1, $2, 'private', 5, now() - interval '1 day')`,
      [org, lateAdmin],
    );
    const people = { owner, admin, lateAdmin, viewAdmin };
    const before = await picture(people, vault, [d1, d2]);
    expect(before.lateAdmin).toMatchObject({ modes: ["none", "none"] });
    await pool.query(CONVERT_SQL);
    expect(await picture(people, vault, [d1, d2])).toEqual(before);
    const own = await row(org, "SELECT principal_id, permission FROM shares WHERE org_id = $1 AND resource_type = 'vault' AND principal_type = 'user' ORDER BY principal_id");
    expect(own).toEqual(
      [{ principal_id: owner, permission: "edit" }, { principal_id: admin, permission: "edit" }, { principal_id: viewAdmin, permission: "view" }]
        .sort((x, y) => (x.principal_id < y.principal_id ? -1 : 1)),
    );
    const members = await row(org, "SELECT user_id FROM access_group_members WHERE organization_id = $1");
    expect(members.map((m) => m.user_id)).toEqual([lateAdmin]);
  });

  it("a team level written after a Private joiner joined opens their older notes, never their empty folders", async () => {
    const org = await seedOrg("Reopened", `reopened-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    const late = await seedUser(`l-${randomUUID()}@t.dev`);
    await seedMember(org, owner, "owner");
    await seedMember(org, late, "member");
    const vault = await seedVault(org);
    const full = await seedFolder(vault, null, "Full", "Full", owner);
    const empty = await seedFolder(vault, null, "Empty", "Empty", owner);
    const d = await seedNote(vault, full, "Full/a.md", owner);
    await pool.query("UPDATE notes SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await pool.query("UPDATE folders SET created_at = now() - interval '2 days' WHERE vault_id = $1", [vault]);
    await pool.query(
      `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
       VALUES ($1, $2, 'private', 1, now() - interval '1 day')`,
      [org, late],
    );
    await orgRow(org, "vault", org, "edit", 2); // the team was reopened after the join
    await joinDefault(org, "open");
    const before = await picture({ late }, vault, [d]);
    expect(before.late).toMatchObject({ modes: ["edit"] });
    await pool.query(CONVERT_SQL);
    const after = await picture({ late }, vault, [d]);
    expect(after).toEqual(before);
    expect((after.late as { folders: string[] }).folders).toContain(full);
    expect((after.late as { folders: string[] }).folders).not.toContain(empty);
  });

  it("a Can view vault keeps view, and the group takes new members", async () => {
    for (const [jd, autoJoin] of [["readonly", true], ["open", true], ["private", true]] as const) {
      const org = await seedOrg("View team", `view-${randomUUID()}`);
      const owner = await seedUser(`o-${randomUUID()}@t.dev`);
      const member = await seedUser(`m-${randomUUID()}@t.dev`);
      await seedMember(org, owner, "owner");
      await seedMember(org, member, "member");
      const vault = await seedVault(org);
      const d = await seedNote(vault, null, "a.md", owner);
      await orgRow(org, "vault", org, "view");
      await joinDefault(org, jd);
      const before = await picture({ member }, vault, [d]);
      await pool.query(CONVERT_SQL);
      expect(await picture({ member }, vault, [d])).toEqual(before);
      expect(await effectivePermission(member, d)).toBe("view");
      const [g] = await row(org, "SELECT auto_join FROM access_groups WHERE organization_id = $1");
      expect(g.auto_join, jd).toBe(autoJoin);
    }
  });

  it("a vault that was never shared keeps each member on what they wrote", async () => {
    const org = await seedOrg("Unshared", `unshared-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    const writer = await seedUser(`w-${randomUUID()}@t.dev`);
    await seedMember(org, owner, "owner");
    await seedMember(org, writer, "member");
    const vault = await seedVault(org);
    const mine = await seedFolder(vault, null, "Mine", "Mine", writer);
    const blocked = await seedFolder(vault, null, "Blocked", "Blocked", owner);
    const w1 = await seedNote(vault, mine, "Mine/w1.md", writer);
    const w2 = await seedNote(vault, blocked, "Blocked/w2.md", writer);
    const o1 = await seedNote(vault, null, "o1.md", owner);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'user', $4, 'denied')`,
      [randomUUID(), org, blocked, writer],
    );
    const docs = [w1, w2, o1];
    const before = await picture({ writer, owner }, vault, docs);
    expect((before.writer as { modes: string[] }).modes).toEqual(["edit", "none", "none"]);
    await pool.query(CONVERT_SQL);
    const after = await picture({ writer, owner }, vault, docs);
    expect((after.writer as { modes: string[]; readable: string[] }).modes).toEqual(["edit", "none", "none"]);
    expect((after.writer as { readable: string[] }).readable).toEqual((before.writer as { readable: string[] }).readable);
    // The owner could not see a member's own notes; now they edit everything.
    expect((before.owner as { modes: string[] }).modes).toEqual(["none", "none", "edit"]);
    expect((after.owner as { modes: string[] }).modes).toEqual(["edit", "edit", "edit"]);
    // Nothing else is written for a never-shared vault: no default, no groups.
    expect(await row(org, "SELECT 1 FROM shares WHERE org_id = $1 AND principal_type <> 'user'")).toHaveLength(0);
    expect(await row(org, "SELECT principal_id, permission FROM shares WHERE org_id = $1 AND resource_type = 'vault'")).toEqual([{ principal_id: owner, permission: "edit" }]);
    expect(await row(org, "SELECT 1 FROM access_groups WHERE organization_id = $1")).toHaveLength(0);
    // A member still creates at the top level, and what they create is theirs alone.
    expect(await canCreateIn(writer, vault, null)).toBe(true);
    expect(await canWriteAttachment(writer, vault)).toBe(true);
    const fresh = await seedNote(vault, null, "fresh.md", writer);
    const freshFolder = await seedFolder(vault, null, "New", "New", writer);
    expect(await effectivePermission(writer, fresh)).toBe("edit");
    expect(await canEditFolder(writer, freshFolder)).toBe(true);
    expect(await listReadableDocsInVault(writer, vault)).toContain(fresh);
    expect(await effectivePermission(owner, fresh)).toBe("edit");
    const other = await seedUser(`x-${randomUUID()}@t.dev`);
    await seedMember(org, other, "member");
    expect(await effectivePermission(other, fresh)).toBe("none");
    expect(await listReadableDocsInVault(other, vault)).not.toContain(fresh);
  });

  it("leaves a sealed vault exactly as it is, owners included", async () => {
    const org = await seedOrg("Sealed", `sealed-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    const member = await seedUser(`m-${randomUUID()}@t.dev`);
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const d = await seedNote(vault, null, "a.md", owner);
    await sealVault(org);
    const before = await picture({ owner, member }, vault, [d]);
    await pool.query(CONVERT_SQL);
    const after = await picture({ owner, member }, vault, [d]);
    expect(after).toEqual(before);
    expect(await row(org, "SELECT 1 FROM access_model_conversion_rows WHERE organization_id = $1")).toHaveLength(0);
    expect(await row(org, "SELECT 1 FROM access_groups WHERE organization_id = $1")).toHaveLength(0);
  });

  it("runs once per vault and never clashes with a group the team already named Everyone", async () => {
    const org = await seedOrg("Named", `named-${randomUUID()}`);
    const owner = await seedUser(`o-${randomUUID()}@t.dev`);
    await seedMember(org, owner, "owner");
    await seedVault(org);
    await orgRow(org, "vault", org, "edit");
    await pool.query(
      "INSERT INTO access_groups (id, organization_id, name, auto_join) VALUES ($1, $2, 'Everyone', false)",
      [randomUUID(), org],
    );
    await pool.query(CONVERT_SQL);
    await pool.query(CONVERT_SQL);
    const names = await row(org, "SELECT name FROM access_groups WHERE organization_id = $1 ORDER BY name");
    expect(names.map((n) => n.name)).toEqual(["All members", "Everyone"]);
    expect(await row(org, "SELECT 1 FROM access_model_conversion WHERE organization_id = $1")).toHaveLength(1);
  });
});
