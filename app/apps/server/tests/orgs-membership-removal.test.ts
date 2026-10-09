import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { setMemberRemovedPublisher } from "../src/sync/member-events.js";
import { MEMBERSHIP_CHECK_MAX } from "../src/http/routes/orgs.js";

// Membership ending: the departed user is told live (member-removed), cannot
// mint either sync token afterwards, and a launch-time check names the vault.

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function req(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://local/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const published: Array<{ vaultId: string; orgId: string; userId: string; reason: string }> = [];

describe("membership removal", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    published.length = 0;
    setMemberRemovedPublisher((vaultId, orgId, userId, reason) =>
      published.push({ vaultId, orgId, userId, reason }),
    );
  });
  afterAll(async () => {
    setMemberRemovedPublisher(null);
    await pool.end();
  });

  it("removal announces member-removed and both token mints then 403", async () => {
    const owner = await signUp("owner@mr.com");
    const member = await signUp("member@mr.com");
    const org = await seedOrg("Acme", "acme-mr1");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    // Their own note: authorship must not outlive membership.
    const doc = await seedNote(vault, null, "mine.md", member.userId);

    expect((await req(member.token, "POST", "/sync-token", { docId: doc })).status).toBe(200);
    expect((await req(member.token, "POST", "/vault-sync-token", { vaultId: vault })).status).toBe(200);

    const res = await req(owner.token, "DELETE", `/orgs/${org}/members/${member.userId}`);
    expect(res.status).toBe(200);
    expect(published).toEqual([{ vaultId: vault, orgId: org, userId: member.userId, reason: "removed" }]);

    expect((await req(member.token, "POST", "/sync-token", { docId: doc })).status).toBe(403);
    expect((await req(member.token, "POST", "/vault-sync-token", { vaultId: vault })).status).toBe(403);
  });

  it("leaving announces reason left", async () => {
    const owner = await signUp("owner@mr2.com");
    const member = await signUp("member@mr2.com");
    const org = await seedOrg("Acme", "acme-mr2");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);

    const res = await req(member.token, "POST", `/orgs/${org}/leave`);
    expect(res.status).toBe(200);
    expect(published).toEqual([{ vaultId: vault, orgId: org, userId: member.userId, reason: "left" }]);
    expect((await req(member.token, "POST", "/vault-sync-token", { vaultId: vault })).status).toBe(403);
  });

  it("membership-check splits member / notMember / unknown", async () => {
    const owner = await signUp("owner@mc.com");
    const me = await signUp("me@mc.com");
    const mine = await seedOrg("Mine", "mine-mc");
    const theirs = await seedOrg("Theirs", "theirs-mc");
    await seedMember(mine, me.userId, "member");
    await seedMember(theirs, owner.userId, "owner");

    const res = await req(me.token, "POST", "/orgs/membership-check", {
      orgIds: [mine, theirs, "no-such-org", mine],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      member: [mine],
      notMember: [theirs],
      unknown: ["no-such-org"],
    });
  });

  it("membership-check refuses anon, a bad body and too many ids", async () => {
    const me = await signUp("me@mc2.com");
    expect((await req(null, "POST", "/orgs/membership-check", { orgIds: [] })).status).toBe(401);
    expect((await req(me.token, "POST", "/orgs/membership-check", { orgIds: "x" })).status).toBe(400);
    const many = Array.from({ length: MEMBERSHIP_CHECK_MAX + 1 }, (_, i) => `o${i}`);
    expect((await req(me.token, "POST", "/orgs/membership-check", { orgIds: many })).status).toBe(400);
    const empty = await req(me.token, "POST", "/orgs/membership-check", { orgIds: [] });
    expect(await empty.json()).toEqual({ member: [], notMember: [], unknown: [] });
  });
});
