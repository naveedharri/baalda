import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp } from "./helpers/auth.js";

const app = createApp(testAppDeps());

function removeMember(token: string | null, orgId: string, userId: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(
      `http://local/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers },
    ),
  );
}

async function addMember(orgId: string, userId: string, role: "member" | "admin" = "member") {
  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, $4, now())`,
    [randomUUID(), orgId, userId, role],
  );
}

async function memberCount(orgId: string, userId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
    [orgId, userId],
  );
  return rows[0].c;
}

async function shareCount(workspaceId: string, principalId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM shares
      WHERE workspace_id = $1 AND principal_type = 'user' AND principal_id = $2`,
    [workspaceId, principalId],
  );
  return rows[0].c;
}

describe("remove a member from a workspace", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("owner removes a member: row deleted, their direct shares purged", async () => {
    const owner = await signUp("owner@rm.com");
    const org = await createOrg(owner, "Acme", "acme-rm1");
    const member = await signUp("member@rm.com");
    await addMember(org.id, member.userId);

    // A folder shared directly to the member — must be purged on removal.
    await pool.query(
      `INSERT INTO shares
         (id, workspace_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'user', $4, 'edit')`,
      [randomUUID(), org.id, randomUUID(), member.userId],
    );
    // A share to a DIFFERENT user must survive (scope check).
    const bystander = await signUp("bystander@rm.com");
    await addMember(org.id, bystander.userId);
    await pool.query(
      `INSERT INTO shares
         (id, workspace_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'user', $4, 'edit')`,
      [randomUUID(), org.id, randomUUID(), bystander.userId],
    );

    expect(await memberCount(org.id, member.userId)).toBe(1);
    expect(await shareCount(org.id, member.userId)).toBe(1);

    const res = await removeMember(owner.token, org.id, member.userId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });

    expect(await memberCount(org.id, member.userId)).toBe(0);
    expect(await shareCount(org.id, member.userId)).toBe(0);
    // The bystander's membership and share are untouched.
    expect(await memberCount(org.id, bystander.userId)).toBe(1);
    expect(await shareCount(org.id, bystander.userId)).toBe(1);
  });

  it("rejects anon (401), a plain member (403), self-removal (400), and removing the owner (403)", async () => {
    const owner = await signUp("owner@rm2.com");
    const org = await createOrg(owner, "Acme", "acme-rm2");
    const member = await signUp("member@rm2.com");
    await addMember(org.id, member.userId);

    expect((await removeMember(null, org.id, member.userId)).status).toBe(401);
    // A plain member can't remove anyone.
    expect((await removeMember(member.token, org.id, owner.userId)).status).toBe(403);
    // Owner can't remove themselves via this route.
    expect((await removeMember(owner.token, org.id, owner.userId)).status).toBe(400);
    // The owner can't be removed at all.
    const admin = await signUp("admin@rm2.com");
    await addMember(org.id, admin.userId, "admin");
    expect((await removeMember(admin.token, org.id, owner.userId)).status).toBe(403);
    // Membership is unchanged after the rejected attempts.
    expect(await memberCount(org.id, owner.userId)).toBe(1);
    expect(await memberCount(org.id, member.userId)).toBe(1);
  });

  it("admin can remove a plain member but not another admin", async () => {
    const owner = await signUp("owner@rm3.com");
    const org = await createOrg(owner, "Acme", "acme-rm3");
    const admin = await signUp("admin@rm3.com");
    await addMember(org.id, admin.userId, "admin");
    const other = await signUp("other@rm3.com");
    await addMember(org.id, other.userId);
    const admin2 = await signUp("admin2@rm3.com");
    await addMember(org.id, admin2.userId, "admin");

    // Admin removes a plain member — allowed.
    expect((await removeMember(admin.token, org.id, other.userId)).status).toBe(200);
    expect(await memberCount(org.id, other.userId)).toBe(0);

    // Admin can't remove another admin — only the owner can.
    expect((await removeMember(admin.token, org.id, admin2.userId)).status).toBe(403);
    expect(await memberCount(org.id, admin2.userId)).toBe(1);
    expect((await removeMember(owner.token, org.id, admin2.userId)).status).toBe(200);
    expect(await memberCount(org.id, admin2.userId)).toBe(0);
  });
});
