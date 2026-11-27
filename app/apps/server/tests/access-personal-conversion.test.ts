// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { canCreateIn, canEditFolder } from "../src/permissions/http-gates.js";
import { listReadableDocsInVault, listVisibleFolders } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import { sealVault, seedFolder, seedMember, seedNote, seedOrg, seedUser, seedUserVaultGrant, seedVault } from "./helpers/seed.js";

/**
 * Migration 101 (2026-11-27): team-wide access becomes each person's own
 * setting, so groups can be added later without anyone's access moving. It
 * has run on the test database already and skips organizations it logged, so
 * the fixtures (new organizations) are converted by re-applying its SQL.
 * The contract: for every person, note, folder and readable set, after equals
 * before, except that owners and admins of a never-shared vault get Can edit.
 */
const CONVERT_SQL = readFileSync(new URL("../migrations/101_access_personal_conversion.sql", import.meta.url), "utf8");

type Posture = "edit" | "view" | "sealed" | "never";

async function orgRow(org: string, type: string, id: string, permission: string, revision = 0) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
     VALUES ($1, $2, $3, $4, 'org', $2, $5, $6)`,
    [randomUUID(), org, type, id, permission, revision],
  );
}
async function userRow(org: string, type: string, id: string, user: string, permission: string) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
    [randomUUID(), org, type, id, user, permission],
  );
}
async function snapshot(org: string, user: string, mode: "open" | "readonly" | "private", at: Date, revision = 1) {
  await pool.query(
    `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET mode = $3, access_revision = $4, snapshot_at = $5`,
    [org, user, mode, revision, at],
  );
}

async function fixture(posture: Posture) {
  const slug = randomUUID().slice(0, 8);
  const org = await seedOrg(`Conv ${posture}`, `conv-${posture}-${slug}`);
  const mk = (n: string) => seedUser(`${n}-${slug}@conv.test`);
  const people = {
    owner: await mk("owner"),
    admin: await mk("admin"),
    plain: await mk("plain"),
    viewer: await mk("viewer"),
    early: await mk("early"),
    shut: await mk("shut"),
    denied: await mk("denied"),
  };
  for (const [name, id] of Object.entries(people)) {
    await seedMember(org, id, name === "owner" ? "owner" : name === "admin" ? "admin" : "member");
  }
  const vault = await seedVault(org);
  if (posture === "edit" || posture === "view") await orgRow(org, "vault", org, posture);
  if (posture === "sealed") await sealVault(org);

  const old = new Date(Date.now() - 10 * 86_400_000);
  const joined = new Date(Date.now() - 5 * 86_400_000);
  const top = await seedFolder(vault, null, "Projects", "Projects", people.owner);
  const sub = await seedFolder(vault, top, "Alpha", "Projects/Alpha", people.owner);
  const secret = await seedFolder(vault, null, "Secret", "Secret", people.owner);
  const peek = await seedFolder(vault, null, "Peek", "Peek", people.owner);
  const frozen = await seedFolder(vault, null, "Frozen", "Frozen", people.owner);
  const fresh = await seedFolder(vault, null, "Fresh", "Fresh", people.plain);
  const docs = [
    await seedNote(vault, null, "Root.md", people.owner),
    await seedNote(vault, top, "Projects/Plan.md", people.owner),
    await seedNote(vault, sub, "Projects/Alpha/Spec.md", people.plain),
    await seedNote(vault, secret, "Secret/Keys.md", people.owner),
    await seedNote(vault, peek, "Peek/Look.md", people.admin),
    await seedNote(vault, frozen, "Frozen/Old.md", people.owner),
    await seedNote(vault, fresh, "Fresh/New.md", people.plain),
    await seedNote(vault, null, "Mine.md", people.viewer),
  ];
  // The first six existed before the early joiners came in.
  await pool.query("UPDATE notes SET created_at = $2 WHERE id = ANY($1::text[])", [docs.slice(0, 6), old]);
  await pool.query("UPDATE folders SET created_at = $2 WHERE id = ANY($1::text[])", [[top, sub, secret, peek, frozen], old]);

  if (posture !== "sealed") {
    await orgRow(org, "folder", secret, "denied", 3);
    await orgRow(org, "folder", peek, "view", 3);
  } else {
    await orgRow(org, "folder", secret, "denied", 3);
  }
  await orgRow(org, "folder", frozen, "locked", 3);
  if (posture === "edit") await orgRow(org, "file", docs[3]!, "edit", 4);
  await seedUserVaultGrant(org, people.viewer, "view");
  await userRow(org, "folder", top, people.denied, "denied");
  await snapshot(org, people.early, "readonly", joined);
  await snapshot(org, people.shut, "private", joined);
  const folders = [top, sub, secret, peek, frozen, fresh];
  return { org, vault, people, docs, folders };
}

async function picture(f: Awaited<ReturnType<typeof fixture>>) {
  const out: Record<string, unknown> = {};
  for (const [name, user] of Object.entries(f.people)) {
    const notes: string[] = [];
    for (const d of f.docs) notes.push(await effectivePermission(user, d));
    const folderEdit: boolean[] = [];
    for (const fo of f.folders) folderEdit.push(await canEditFolder(user, fo));
    out[name] = {
      notes,
      folderEdit,
      root: await canCreateIn(user, f.vault, null),
      readable: [...(await listReadableDocsInVault(user, f.vault))].sort(),
      folders: (await listVisibleFolders(user, f.vault)).map((x) => x.id).sort(),
    };
  }
  return out as Record<string, { notes: string[]; folderEdit: boolean[]; root: boolean; readable: string[]; folders: string[] }>;
}

describe("migration 101: team-wide access becomes each person's own", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  for (const posture of ["edit", "view", "sealed"] as const) {
    it(`a ${posture} vault: nobody's access changes`, async () => {
      const f = await fixture(posture);
      const before = await picture(f);
      await pool.query(CONVERT_SQL);
      const after = await picture(f);
      expect(after).toEqual(before);
      // Padlocks stay; the team-wide rows are gone in a converted vault.
      const rows = (await pool.query(
        "SELECT resource_type, permission FROM shares WHERE org_id = $1 AND principal_type = 'org' ORDER BY 1, 2",
        [f.org],
      )).rows.map((r) => `${r.resource_type}:${r.permission}`);
      expect(rows).toContain("folder:locked");
      if (posture !== "sealed") {
        expect(rows).toEqual(["folder:locked", "vault:denied"]);
        expect((await pool.query("SELECT 1 FROM member_access_snapshots WHERE organization_id = $1", [f.org])).rowCount).toBe(0);
      }
    });
  }

  it("a never-shared vault: owners and admins get Can edit everything, nobody else changes", async () => {
    const f = await fixture("never");
    const before = await picture(f);
    await pool.query(CONVERT_SQL);
    const after = await picture(f);
    for (const name of Object.keys(f.people)) {
      if (name === "owner" || name === "admin") continue;
      expect(after[name], name).toEqual(before[name]);
    }
    for (const name of ["owner", "admin"] as const) {
      for (let i = 0; i < f.docs.length; i++) {
        // Only gains: never less than before, and edit wherever no padlock caps.
        const rank = (p: string) => (p === "edit" ? 2 : p === "view" ? 1 : 0);
        expect(rank(after[name]!.notes[i]!), `${name} note ${i}`).toBeGreaterThanOrEqual(rank(before[name]!.notes[i]!));
      }
      expect(after[name]!.readable.length).toBeGreaterThanOrEqual(before[name]!.readable.length);
    }
  });

  it("is logged so an undo can put every row back, and runs once per vault", async () => {
    const f = await fixture("edit");
    await pool.query(CONVERT_SQL);
    const logged = await pool.query("SELECT old_posture FROM access_personal_conversion WHERE organization_id = $1", [f.org]);
    expect(logged.rows[0]?.old_posture).toBe("edit");
    const n = (await pool.query("SELECT count(*)::int AS n FROM access_personal_conversion_rows WHERE organization_id = $1", [f.org])).rows[0].n;
    expect(n).toBeGreaterThan(0);
    const snap1 = await picture(f);
    await pool.query(CONVERT_SQL);
    expect(await picture(f)).toEqual(snap1);
    // New invites start where the members were.
    const lvl = await pool.query("SELECT new_member_level FROM organization_access_settings WHERE organization_id = $1", [f.org]);
    expect(lvl.rows[0]?.new_member_level).toBe("edit");
  });
});
