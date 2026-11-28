// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, expect, it } from "vitest";
import { pool, resetDb } from "./helpers/db.js";
import { seedMember, seedVault } from "./helpers/seed.js";
import { createOrg, signUp, authHeaders } from "./helpers/auth.js";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";

const app = createApp(recordingAppDeps().deps);
beforeEach(resetDb);
afterAll(() => pool.end());

const post = (path: string, who: { token: string }, body: unknown) =>
  app.fetch(new Request(`http://local/api${path}`, { method: "POST", headers: authHeaders(who as never), body: JSON.stringify(body) }));
const isMember = async (orgId: string, userId: string) =>
  (await pool.query('SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2', [orgId, userId])).rowCount === 1;
const ownRows = async (orgId: string, userId: string) =>
  Number((await pool.query("SELECT count(*) AS n FROM shares WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2", [orgId, userId])).rows[0].n);

it("Better Auth's own remove-member is refused: removal goes through the route that also drops the person's access", async () => {
  // Through Better Auth a removed member kept their per-person rows and got all
  // of that access back on rejoining, and an admin could remove another admin.
  const owner = await signUp("rm-owner@paths.test");
  const admin = await signUp("rm-admin@paths.test");
  const admin2 = await signUp("rm-admin2@paths.test");
  const member = await signUp("rm-member@paths.test");
  const org = await createOrg(owner, "Paths", "paths-rm");
  await seedMember(org.id, admin.userId, "admin");
  const admin2Id = await seedMember(org.id, admin2.userId, "admin");
  const memberId = await seedMember(org.id, member.userId, "member");
  await seedVault(org.id);
  const share = await app.fetch(new Request("http://local/api/shares", {
    method: "POST", headers: authHeaders(owner),
    body: JSON.stringify({ resourceType: "vault", resourceId: org.id, principalType: "user", principalId: member.userId, permission: "edit" }),
  }));
  expect(share.status).toBe(201);

  expect((await post("/auth/organization/remove-member", owner, { organizationId: org.id, memberIdOrEmail: memberId })).status).toBe(403);
  expect((await post("/auth/organization/remove-member", admin, { organizationId: org.id, memberIdOrEmail: admin2Id })).status).toBe(403);
  expect(await isMember(org.id, member.userId)).toBe(true);
  expect(await isMember(org.id, admin2.userId)).toBe(true);

  const del = await app.fetch(new Request(`http://local/api/orgs/${org.id}/members/${member.userId}`, { method: "DELETE", headers: authHeaders(owner) }));
  expect(del.status).toBe(200);
  expect(await isMember(org.id, member.userId)).toBe(false);
  expect(await ownRows(org.id, member.userId)).toBe(0);
});

it("Better Auth's own leave is refused: leaving goes through the route that also drops the person's access", async () => {
  const owner = await signUp("lv-owner@paths.test");
  const member = await signUp("lv-member@paths.test");
  const org = await createOrg(owner, "Leave", "paths-lv");
  await seedMember(org.id, member.userId, "member");
  await seedVault(org.id);
  await app.fetch(new Request("http://local/api/shares", {
    method: "POST", headers: authHeaders(owner),
    body: JSON.stringify({ resourceType: "vault", resourceId: org.id, principalType: "user", principalId: member.userId, permission: "edit" }),
  }));

  expect((await post("/auth/organization/leave", member, { organizationId: org.id })).status).toBe(403);
  expect(await isMember(org.id, member.userId)).toBe(true);
  expect(await ownRows(org.id, member.userId)).toBe(1);

  expect((await post(`/orgs/${org.id}/leave`, member, {})).status).toBe(200);
  expect(await isMember(org.id, member.userId)).toBe(false);
  expect(await ownRows(org.id, member.userId)).toBe(0);
});
