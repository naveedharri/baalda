// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { sealVault, seedFolder, seedMember, seedNote, seedUserVaultGrant, seedVault } from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * Registering a path a hidden note already holds must not answer with that
 * note's id or title. The adopt's shortcut treated a doc as readable unless a
 * per-user or team No access row hid it, so everything hidden WITHOUT such a
 * row was adopted: a group's No access, and every doc nobody shared in an
 * "Only what's shared" vault (found in the five-app test, 2026-11-28).
 */

const app = createApp(testAppDeps());

afterAll(async () => {
  await pool.end();
});

function post(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { ...authHeaders(user), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function newGroup(org: string, members: string[]): Promise<string> {
  const g = randomUUID();
  await pool.query("INSERT INTO access_groups (id, organization_id, name, auto_join) VALUES ($1, $2, $3, false)", [g, org, "G " + g.slice(0, 4)]);
  for (const m of members) {
    await pool.query("INSERT INTO access_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3)", [g, org, m]);
  }
  return g;
}

async function groupRow(org: string, group: string, type: "vault" | "folder" | "file", id: string, permission: "view" | "edit" | "denied") {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
     VALUES ($1, $2, $3, $4, 'group', $5, $6, 1)`,
    [randomUUID(), org, type, id, group, permission],
  );
}

describe("adopting a path a hidden note holds", () => {
  let owner: TestUser;
  let member: TestUser;
  let reader: TestUser;
  let org: string;
  let vault: string;
  let team: string;
  let hiddenIds: string[];
  let openId: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@adopt-hidden.test");
    member = await signUp("member@adopt-hidden.test");
    reader = await signUp("reader@adopt-hidden.test");
    org = (await createOrg(owner, "Adopt Co", "adopt-co")).id;
    await seedMember(org, member.userId, "member");
    await seedMember(org, reader.userId, "member");
    vault = await seedVault(org);
    await sealVault(org);
    await seedUserVaultGrant(org, owner.userId, "edit");
    team = await seedFolder(vault, null, "Team", "Team", owner.userId);
    const unshared = await seedFolder(vault, null, "Board", "Board", owner.userId);
    openId = await seedNote(vault, team, "Team/open.md", owner.userId);
    const groupHidden = await seedNote(vault, team, "Team/hidden.md", owner.userId);
    const inUnshared = await seedNote(vault, unshared, "Board/plan.md", owner.userId);
    const atRoot = await seedNote(vault, null, "root.md", owner.userId);
    hiddenIds = [groupHidden, inUnshared, atRoot];
    // The member: Can edit on Team through a group, whose No access hides one note.
    const g = await newGroup(org, [member.userId]);
    await groupRow(org, g, "folder", team, "edit");
    await groupRow(org, g, "file", groupHidden, "denied");
    // The reader: Can view everything through another group.
    const r = await newGroup(org, [reader.userId]);
    await groupRow(org, r, "vault", org, "view");
  });

  it("refuses every hidden note without naming it, and still adopts a visible one", async () => {
    const res = await post(member, `/api/vaults/${vault}/notes/batch`, {
      items: ["Team/hidden.md", "Board/plan.md", "root.md", "Team/open.md"].map((relPath) => ({ id: randomUUID(), relPath })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ docId: string | null; status: string; code: string | null; title?: string | null }> };
    for (const hidden of body.results.slice(0, 3)) {
      expect(hidden).toMatchObject({ status: "error", code: "not_readable", docId: null });
    }
    for (const id of hiddenIds) expect(JSON.stringify(body)).not.toContain(id);
    expect(body.results[3]).toMatchObject({ status: "adopted", docId: openId });
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM notes WHERE vault_id = $1", [vault]);
    expect(Number(rows[0].n)).toBe(4);
  });

  it("someone who reads the whole vault adopts every path", async () => {
    const res = await post(reader, `/api/vaults/${vault}/notes/batch`, {
      items: ["Team/hidden.md", "Board/plan.md", "root.md"].map((relPath) => ({ id: randomUUID(), relPath })),
    });
    const body = (await res.json()) as { results: Array<{ docId: string | null; status: string }> };
    expect(body.results.map((r) => r.docId)).toEqual(hiddenIds);
    expect(body.results.every((r) => r.status === "adopted")).toBe(true);
  });
});
