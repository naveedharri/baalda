import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, bearerHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember } from "./helpers/seed.js";
import { memoryOutbox } from "../src/email/mailer.js";

/**
 * POST /api/orgs/:orgId/invitations and the access it carries: remembered in
 * `invitation_access`, applied as a per-user vault row when the invitee joins
 * (join code or Better Auth accept).
 */
const app = createApp(testAppDeps());

type InviteResponse = {
  results: Array<{ email: string; invitationId?: string; emailed: boolean; error?: string }>;
};

function inviteMany(user: TestUser, orgId: string, body: unknown) {
  return app.request(`/api/orgs/${orgId}/invitations`, {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify(body),
  });
}

async function joinByCode(owner: TestUser, joiner: TestUser) {
  const code = ((await (await app.request("/api/orgs/join-code", { headers: authHeaders(owner) })).json()) as {
    code: string;
  }).code;
  return app.request("/api/orgs/join", {
    method: "POST",
    headers: authHeaders(joiner),
    body: JSON.stringify({ code }),
  });
}

async function personalVaultRows(orgId: string, userId: string) {
  const { rows } = await pool.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1 AND principal_type = 'user' AND principal_id = $2`,
    [orgId, userId],
  );
  return rows.map((r) => r.permission);
}

async function accessRowCount(invitationId: string) {
  const { rows } = await pool.query(`SELECT 1 FROM invitation_access WHERE invitation_id = $1`, [invitationId]);
  return rows.length;
}

describe("invitations with access", () => {
  let owner: TestUser;
  let orgId: string;
  beforeEach(async () => {
    await resetDb();
    memoryOutbox.length = 0;
    owner = await signUp("owner@inv-access.test");
    orgId = (await createOrg(owner, "Inv", `inv-${Date.now()}`)).id;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creates deduped invitations, remembers access and emails each", async () => {
    const res = await inviteMany(owner, orgId, {
      emails: ["A@inv-access.test", "a@inv-access.test ", "b@inv-access.test"],
      role: "member",
      access: "readonly",
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as InviteResponse;
    expect(results.map((r) => r.email)).toEqual(["a@inv-access.test", "b@inv-access.test"]);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.emailed).toBe(true);
      expect(await accessRowCount(r.invitationId!)).toBe(1);
    }
    const invited = memoryOutbox.filter((m) =>
      ["a@inv-access.test", "b@inv-access.test"].includes(String((m as { to?: unknown }).to)),
    );
    expect(invited.length).toBe(2);
  });

  it("validates the body and gates on owner/admin", async () => {
    expect((await inviteMany(owner, orgId, { emails: [], role: "member", access: null })).status).toBe(400);
    expect((await inviteMany(owner, orgId, { emails: ["nope"], role: "member", access: null })).status).toBe(400);
    expect((await inviteMany(owner, orgId, { emails: ["x@y.zz"], role: "owner", access: null })).status).toBe(400);
    expect((await inviteMany(owner, orgId, { emails: ["x@y.zz"], role: "member", access: "all" })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, (_, i) => `p${i}@inv-access.test`);
    expect((await inviteMany(owner, orgId, { emails: tooMany, role: "member", access: null })).status).toBe(400);

    const admin = await signUp("admin@inv-access.test");
    await seedMember(orgId, admin.userId, "admin");
    const ok = await inviteMany(admin, orgId, { emails: ["x@y.zz"], role: "admin", access: null });
    expect(ok.status).toBe(200);

    const member = await signUp("member@inv-access.test");
    await seedMember(orgId, member.userId, "member");
    expect((await inviteMany(member, orgId, { emails: ["z@y.zz"], role: "member", access: null })).status).toBe(403);

    // Free seat cap (billing on in tests): owner + admin + member + the pending
    // invite fill it, so every address fails ⇒ top-level 402 the desktop's
    // classifyLimitError understands, with per-email detail.
    const full = await inviteMany(owner, orgId, { emails: ["q@y.zz", "r@y.zz"], role: "member", access: null });
    expect(full.status).toBe(402);
    const body = (await full.json()) as InviteResponse & { error: string };
    expect(body.error).toBe("member_limit_reached");
    expect(body.results.every((r) => r.error === "member_limit_reached")).toBe(true);
  });

  it("join-code acceptance applies the invite's access as a per-user vault row", async () => {
    const invitee = await signUp("private@inv-access.test");
    const { results } = (await (
      await inviteMany(owner, orgId, { emails: [invitee.email], role: "member", access: "private" })
    ).json()) as InviteResponse;
    const id = results[0].invitationId!;

    expect((await joinByCode(owner, invitee)).status).toBe(200);
    expect(await personalVaultRows(orgId, invitee.userId)).toEqual(["denied"]);
    expect(await accessRowCount(id)).toBe(0); // consumed
  });

  it("readonly maps to the vault-level view row", async () => {
    const invitee = await signUp("ro@inv-access.test");
    await inviteMany(owner, orgId, { emails: [invitee.email], role: "member", access: "readonly" });
    expect((await joinByCode(owner, invitee)).status).toBe(200);
    expect(await personalVaultRows(orgId, invitee.userId)).toEqual(["view"]);
  });

  it("no access chosen ⇒ nothing applied", async () => {
    const invitee = await signUp("plain@inv-access.test");
    await inviteMany(owner, orgId, { emails: [invitee.email], role: "member", access: null });
    expect((await joinByCode(owner, invitee)).status).toBe(200);
    expect(await personalVaultRows(orgId, invitee.userId)).toEqual([]);
  });

  it("Better Auth accept applies the invite's access too", async () => {
    const invitee = await signUp("accept@inv-access.test");
    const { results } = (await (
      await inviteMany(owner, orgId, { emails: [invitee.email], role: "member", access: "open" })
    ).json()) as InviteResponse;
    await auth.api.acceptInvitation({
      headers: bearerHeaders(invitee),
      body: { invitationId: results[0].invitationId! },
    });
    expect(await personalVaultRows(orgId, invitee.userId)).toEqual(["edit"]);
    expect(await accessRowCount(results[0].invitationId!)).toBe(0);
  });
});
