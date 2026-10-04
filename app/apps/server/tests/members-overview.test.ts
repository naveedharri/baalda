import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  sealVault,
  seedMember,
  seedNote,
  seedShare,
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import {
  resetLastSeenThrottle,
  stampLastSeen,
  stampLastSeenForVault,
} from "../src/members/last-seen.js";

/** GET /api/orgs/:orgId/members/overview — the Members & access page. */
const app = createApp(testAppDeps());

type Overview = {
  members: Array<{
    userId: string;
    memberId: string;
    role: string;
    name: string | null;
    email: string;
    image: string | null;
    joinedAt: string;
    lastActiveAt: string | null;
    invitedBy: { userId: string; name: string | null; email: string } | null;
    access?: { level: string };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    createdAt: string;
    expiresAt: string | null;
    access: string | null;
  }>;
  canManage: boolean;
};

function overview(user: TestUser | null, orgId: string) {
  return app.request(`/api/orgs/${orgId}/members/overview`, {
    headers: user ? authHeaders(user) : {},
  });
}

async function setup() {
  const owner = await signUp("owner@members.test");
  const org = await createOrg(owner, "Members", `members-${Date.now()}`);
  return { owner, orgId: org.id };
}

/** Members join BEFORE any content exists, so the m032 join snapshot hides nothing. */
async function addMember(orgId: string, email: string, role: "member" | "admin" = "member") {
  const user = await signUp(email);
  await seedMember(orgId, user.userId, role);
  return user;
}

const levelOf = (o: Overview, userId: string) => o.members.find((m) => m.userId === userId)?.access?.level;

describe("members overview", () => {
  beforeEach(async () => {
    await resetDb();
    resetLastSeenThrottle();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("is member-gated: 401 anon, 403 outsider, 200 member without access levels", async () => {
    const { owner, orgId } = await setup();
    const member = await addMember(orgId, "m@members.test");
    const outsider = await signUp("x@members.test");

    expect((await overview(null, orgId)).status).toBe(401);
    expect((await overview(outsider, orgId)).status).toBe(403);

    const res = await overview(member, orgId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Overview;
    expect(body.canManage).toBe(false);
    expect(body.members.map((m) => m.email).sort()).toEqual([member.email, owner.email].sort());
    expect(body.members.every((m) => m.access === undefined)).toBe(true);
    const row = body.members.find((m) => m.userId === member.userId)!;
    expect(row.role).toBe("member");
    expect(typeof row.memberId).toBe("string");
    expect(Date.parse(row.joinedAt)).not.toBeNaN();
    expect(row.lastActiveAt).toBeNull();
  });

  it("reports view / edit levels under a read-only posture", async () => {
    const { owner, orgId } = await setup();
    const reader = await addMember(orgId, "reader@members.test");
    const editor = await addMember(orgId, "editor@members.test");
    const vaultId = await seedVault(orgId);
    await seedNote(vaultId, null, "a.md");
    await seedNote(vaultId, null, "b.md");
    await seedVaultGrant(orgId, "view");
    await seedUserVaultGrant(orgId, editor.userId, "edit");

    const body = (await (await overview(owner, orgId)).json()) as Overview;
    expect(body.canManage).toBe(true);
    expect(levelOf(body, reader.userId)).toBe("view");
    expect(levelOf(body, editor.userId)).toBe("edit");
    // No role exemption: the owner reports whatever the resolver computes.
    expect(["edit", "view", "none", "custom"]).toContain(levelOf(body, owner.userId));
  });

  it("reports none / custom levels in a sealed vault", async () => {
    const { owner, orgId } = await setup();
    const shut = await addMember(orgId, "shut@members.test");
    const partial = await addMember(orgId, "partial@members.test");
    const vaultId = await seedVault(orgId);
    const one = await seedNote(vaultId, null, "one.md");
    await seedNote(vaultId, null, "two.md");
    await sealVault(orgId);
    await seedShare(orgId, "file", one, partial.userId, "edit");

    const body = (await (await overview(owner, orgId)).json()) as Overview;
    expect(levelOf(body, shut.userId)).toBe("none");
    expect(levelOf(body, partial.userId)).toBe("custom");
  });

  it("lastActiveAt is null until stamped, and the stamp is throttled", async () => {
    const { owner, orgId } = await setup();
    const member = await addMember(orgId, "seen@members.test");
    const vaultId = await seedVault(orgId);

    let body = (await (await overview(owner, orgId)).json()) as Overview;
    expect(body.members.find((m) => m.userId === member.userId)!.lastActiveAt).toBeNull();

    expect(await stampLastSeen(member.userId, orgId)).toBe(true);
    expect(await stampLastSeen(member.userId, orgId)).toBe(false); // throttled
    expect(await stampLastSeenForVault(owner.userId, vaultId)).toBe(true);
    expect(await stampLastSeenForVault(owner.userId, vaultId)).toBe(false);

    body = (await (await overview(owner, orgId)).json()) as Overview;
    expect(Date.parse(body.members.find((m) => m.userId === member.userId)!.lastActiveAt!)).not.toBeNaN();
    expect(Date.parse(body.members.find((m) => m.userId === owner.userId)!.lastActiveAt!)).not.toBeNaN();
  });

  it("stamps last seen on sync-token mint", async () => {
    const { owner, orgId } = await setup();
    const vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
    const doc = await seedNote(vaultId, null, "n.md", owner.userId);
    const res = await app.request("/api/sync-token", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ docId: doc }),
    });
    expect(res.status).toBe(200);
    // fire-and-forget: give the UPDATE a moment
    for (let i = 0; i < 20; i++) {
      const { rows } = await pool.query(
        `SELECT last_seen_at FROM member WHERE "userId" = $1 AND "organizationId" = $2`,
        [owner.userId, orgId],
      );
      if (rows[0]?.last_seen_at) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("last_seen_at was never stamped");
  });

  it("reports invitedBy from the latest accepted invitation, null otherwise", async () => {
    const { owner, orgId } = await setup();
    const invited = await addMember(orgId, "invited@members.test");
    await pool.query(
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")
       VALUES ('inv-accepted', $1, $2, 'member', 'accepted', now() + interval '2 days', now(), $3)`,
      [orgId, invited.email, owner.userId],
    );
    const body = (await (await overview(owner, orgId)).json()) as Overview;
    expect(body.members.find((m) => m.userId === invited.userId)!.invitedBy).toMatchObject({
      userId: owner.userId,
      email: owner.email,
    });
    expect(body.members.find((m) => m.userId === owner.userId)!.invitedBy).toBeNull();
  });

  it("lists pending invitations with createdAt and chosen access", async () => {
    const { owner, orgId } = await setup();
    const res = await app.request(`/api/orgs/${orgId}/invitations`, {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ emails: ["new@members.test"], role: "member", access: "readonly" }),
    });
    expect(res.status).toBe(200);
    await app.request(`/api/orgs/${orgId}/invitations`, {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ emails: ["plain@members.test"], role: "admin", access: null }),
    });

    const body = (await (await overview(owner, orgId)).json()) as Overview;
    const byEmail = new Map(body.invitations.map((i) => [i.email, i]));
    expect(byEmail.get("new@members.test")).toMatchObject({ role: "member", status: "pending", access: "readonly" });
    expect(byEmail.get("plain@members.test")).toMatchObject({ role: "admin", access: null });
    for (const inv of body.invitations) {
      expect(Date.parse(inv.createdAt)).not.toBeNaN();
      expect(Date.parse(inv.expiresAt!)).not.toBeNaN();
    }
  });
});
