import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function changeRole(token: string | null, orgId: string, userId: string, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(
      `http://local/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", headers, body: JSON.stringify(body) },
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

async function roleOf(orgId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
    [orgId, userId],
  );
  return rows[0]?.role ?? null;
}

describe("change a member's role", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("owner promotes a member to admin and demotes them back", async () => {
    const owner = await signUp("owner@role.com");
    const org = await createOrg(owner, "Acme", "acme-role1");
    const member = await signUp("member@role.com");
    await addMember(org.id, member.userId);

    let res = await changeRole(owner.token, org.id, member.userId, { role: "admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, role: "admin" });
    expect(await roleOf(org.id, member.userId)).toBe("admin");

    res = await changeRole(owner.token, org.id, member.userId, { role: "member" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, role: "member" });
    expect(await roleOf(org.id, member.userId)).toBe("member");
  });

  it("rejects anon (401), a plain member (403), self (400), and the owner as target (403)", async () => {
    const owner = await signUp("owner@role2.com");
    const org = await createOrg(owner, "Acme", "acme-role2");
    const member = await signUp("member@role2.com");
    await addMember(org.id, member.userId);
    const admin = await signUp("admin@role2.com");
    await addMember(org.id, admin.userId, "admin");

    expect((await changeRole(null, org.id, member.userId, { role: "admin" })).status).toBe(401);
    // A plain member can't change anyone.
    expect((await changeRole(member.token, org.id, member.userId, { role: "admin" })).status).toBe(
      403,
    );
    // Nobody changes their own role via this route.
    expect((await changeRole(owner.token, org.id, owner.userId, { role: "admin" })).status).toBe(
      400,
    );
    // The owner's role can't be touched — by the owner's admins or anyone else.
    expect((await changeRole(admin.token, org.id, owner.userId, { role: "member" })).status).toBe(
      403,
    );
    // Everything is as it was.
    expect(await roleOf(org.id, owner.userId)).toBe("owner");
    expect(await roleOf(org.id, member.userId)).toBe("member");
  });

  it("rejects an outsider and an unknown target with 404", async () => {
    const owner = await signUp("owner@role3.com");
    const org = await createOrg(owner, "Acme", "acme-role3");
    const member = await signUp("member@role3.com");
    await addMember(org.id, member.userId);
    const outsider = await signUp("outsider@role3.com");

    expect((await changeRole(outsider.token, org.id, member.userId, { role: "admin" })).status).toBe(
      404,
    );
    expect((await changeRole(owner.token, org.id, outsider.userId, { role: "admin" })).status).toBe(
      404,
    );
    expect(await roleOf(org.id, member.userId)).toBe("member");
  });

  it("admin may promote a plain member but not touch another admin", async () => {
    const owner = await signUp("owner@role4.com");
    const org = await createOrg(owner, "Acme", "acme-role4");
    const admin = await signUp("admin@role4.com");
    await addMember(org.id, admin.userId, "admin");
    const other = await signUp("other@role4.com");
    await addMember(org.id, other.userId);
    const admin2 = await signUp("admin2@role4.com");
    await addMember(org.id, admin2.userId, "admin");

    // Admin promotes a plain member — allowed (parity with inviting admins).
    expect((await changeRole(admin.token, org.id, other.userId, { role: "admin" })).status).toBe(
      200,
    );
    expect(await roleOf(org.id, other.userId)).toBe("admin");

    // Admin can't demote another admin — only the owner can.
    expect((await changeRole(admin.token, org.id, admin2.userId, { role: "member" })).status).toBe(
      403,
    );
    expect(await roleOf(org.id, admin2.userId)).toBe("admin");
    expect((await changeRole(owner.token, org.id, admin2.userId, { role: "member" })).status).toBe(
      200,
    );
    expect(await roleOf(org.id, admin2.userId)).toBe("member");
  });

  it("rejects invalid roles and malformed bodies with 400", async () => {
    const owner = await signUp("owner@role5.com");
    const org = await createOrg(owner, "Acme", "acme-role5");
    const member = await signUp("member@role5.com");
    await addMember(org.id, member.userId);

    // `owner` is never grantable here (ownership transfer is out of scope).
    expect((await changeRole(owner.token, org.id, member.userId, { role: "owner" })).status).toBe(
      400,
    );
    expect(
      (await changeRole(owner.token, org.id, member.userId, { role: "superuser" })).status,
    ).toBe(400);
    expect((await changeRole(owner.token, org.id, member.userId, {})).status).toBe(400);
    expect(await roleOf(org.id, member.userId)).toBe("member");
  });

  it("same-role no-op returns updated:false and fires no side effects", async () => {
    const owner = await signUp("owner@role6.com");
    const org = await createOrg(owner, "Acme", "acme-role6");
    const member = await signUp("member@role6.com");
    await addMember(org.id, member.userId);
    await seedVault(org.id, "A");

    const res = await changeRole(owner.token, org.id, member.userId, { role: "member" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false, role: "member" });
    expect(rec.aclBroadcasts).toEqual([]);
    expect(rec.disconnected).toEqual([]);
  });

  // The `readOnly` flag is baked into the sync token and only checked at
  // connect time, so a role change must kick live sockets and re-announce the
  // ACL — in BOTH directions — or the old permissions live on until the
  // socket happens to drop.
  it("success broadcasts acl-changed per collection and force-closes the org's doc sockets", async () => {
    const owner = await signUp("owner@role7.com");
    const org = await createOrg(owner, "Acme", "acme-role7");
    const admin = await signUp("admin@role7.com");
    await addMember(org.id, admin.userId, "admin");
    const vaultA = await seedVault(org.id, "A");
    const vaultB = await seedVault(org.id, "B");
    const note = await seedNote(vaultA, null, "team.md", owner.userId);

    expect((await changeRole(owner.token, org.id, admin.userId, { role: "member" })).status).toBe(
      200,
    );
    expect(rec.aclBroadcasts.sort()).toEqual([vaultA, vaultB].sort());
    expect(rec.disconnected).toContainEqual({ vaultId: vaultA, docId: note });
  });

  it("broadcasts nothing when the change was refused", async () => {
    const owner = await signUp("owner@role8.com");
    const org = await createOrg(owner, "Acme", "acme-role8");
    const member = await signUp("member@role8.com");
    await addMember(org.id, member.userId);
    await seedVault(org.id, "A");

    expect((await changeRole(member.token, org.id, owner.userId, { role: "member" })).status).toBe(
      403,
    );
    expect(rec.aclBroadcasts).toEqual([]);
    expect(rec.disconnected).toEqual([]);
  });

  // Better Auth's own update-member-role endpoint is mounted via /api/auth/*
  // with weaker rules (an admin may demote another admin) and no socket/ACL
  // handling; the beforeUpdateMemberRole hook closes it so our route is the
  // only way to change roles.
  it("the parallel Better Auth update-member-role endpoint is closed off", async () => {
    const owner = await signUp("owner@role9.com");
    const org = await createOrg(owner, "Acme", "acme-role9");
    const member = await signUp("member@role9.com");
    await addMember(org.id, member.userId);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, member.userId],
    );

    const res = await app.fetch(
      new Request("http://local/api/auth/organization/update-member-role", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ memberId: rows[0].id, role: "admin", organizationId: org.id }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await roleOf(org.id, member.userId)).toBe("member");
  });
});
