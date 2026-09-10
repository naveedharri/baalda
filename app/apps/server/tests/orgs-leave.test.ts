import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp } from "./helpers/auth.js";
import { seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { __setMailerForTests, type MailMessage } from "../src/email/mailer.js";

/**
 * Leaving a vault you don't own (#121): POST /api/orgs/:orgId/leave.
 *
 * Shares its teardown with admin-removal (`revokeMembership`), so the
 * assertions here mirror orgs-remove-member: membership row gone, direct
 * shares purged, readable set empty, sockets kicked, ACL broadcast — plus what
 * only a self-initiated exit has: the owner is refused, the leaver's active
 * session is unpinned from the vault, and two emails go out.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

/** Every message the route handed to the mailer, in order. */
const outbox: MailMessage[] = [];
/** dispatchMail is fire-and-forget; let its microtask land before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Sign-up verification emails ride the same mailer; only the leave mail counts. */
const leaveMail = () => outbox.filter((m) => !m.subject.startsWith("Confirm your email"));

function leave(token: string | null, orgId: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://local/api/orgs/${encodeURIComponent(orgId)}/leave`, {
      method: "POST",
      headers,
    }),
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

async function shareCount(orgId: string, principalId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM shares
      WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2`,
    [orgId, principalId],
  );
  return rows[0].c;
}

async function grantFolder(orgId: string, userId: string) {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'folder', $3, 'user', $4, 'edit')`,
    [randomUUID(), orgId, randomUUID(), userId],
  );
}

describe("leave a vault", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    outbox.length = 0;
    __setMailerForTests({
      kind: "memory",
      async send(msg) {
        outbox.push(msg);
      },
    });
  });
  afterAll(async () => {
    __setMailerForTests(null);
    await pool.end();
  });

  it("a member leaves: row gone, their direct shares purged, others' kept, sockets kicked", async () => {
    const owner = await signUp("owner@leave.io", undefined, "Olive Owner");
    const org = await createOrg(owner, "Acme", "acme-leave1");
    const member = await signUp("member@leave.io", undefined, "Max Member");
    await addMember(org.id, member.userId);
    const bystander = await signUp("bystander@leave.io");
    await addMember(org.id, bystander.userId);
    await grantFolder(org.id, member.userId);
    await grantFolder(org.id, bystander.userId);

    const vaultId = await seedVault(org.id);
    await seedVaultGrant(org.id, "edit");
    const noteId = await seedNote(vaultId, null, "Plan.md", owner.userId);
    expect(await listReadableDocsInVault(member.userId, vaultId)).toContain(noteId);

    const res = await leave(member.token, org.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: true });

    expect(await memberCount(org.id, member.userId)).toBe(0);
    expect(await shareCount(org.id, member.userId)).toBe(0);
    expect(await memberCount(org.id, bystander.userId)).toBe(1);
    expect(await shareCount(org.id, bystander.userId)).toBe(1);
    expect((await listReadableDocsInVault(member.userId, vaultId)).size).toBe(0);

    expect(rec.disconnected).toContainEqual({ vaultId, docId: noteId });
    expect(rec.aclBroadcasts).toContain(vaultId);
  });

  it("an admin may leave too", async () => {
    const owner = await signUp("owner@leave2.io");
    const org = await createOrg(owner, "Acme", "acme-leave2");
    const admin = await signUp("admin@leave2.io");
    await addMember(org.id, admin.userId, "admin");

    expect((await leave(admin.token, org.id)).status).toBe(200);
    expect(await memberCount(org.id, admin.userId)).toBe(0);
    // The owner is untouched.
    expect(await memberCount(org.id, owner.userId)).toBe(1);
  });

  it("the owner cannot leave (409), nothing changes", async () => {
    const owner = await signUp("owner@leave3.io");
    const org = await createOrg(owner, "Acme", "acme-leave3");

    const res = await leave(owner.token, org.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "owner_cannot_leave" });
    expect(await memberCount(org.id, owner.userId)).toBe(1);
    expect(rec.aclBroadcasts).toEqual([]);
    await settle();
    expect(leaveMail()).toEqual([]);
  });

  it("a non-member gets 404; no session gets 401", async () => {
    const owner = await signUp("owner@leave4.io");
    const org = await createOrg(owner, "Acme", "acme-leave4");
    const stranger = await signUp("stranger@leave4.io");

    expect((await leave(stranger.token, org.id)).status).toBe(404);
    expect((await leave(null, org.id)).status).toBe(401);
  });

  it("unpins the vault from the leaver's active session, and only theirs", async () => {
    const owner = await signUp("owner@leave5.io");
    const org = await createOrg(owner, "Acme", "acme-leave5");
    const member = await signUp("member@leave5.io");
    await addMember(org.id, member.userId);
    await pool.query(`UPDATE session SET "activeOrganizationId" = $1 WHERE "userId" IN ($2, $3)`, [
      org.id,
      owner.userId,
      member.userId,
    ]);

    expect((await leave(member.token, org.id)).status).toBe(200);

    const active = async (userId: string) =>
      (
        await pool.query<{ a: string | null }>(
          `SELECT "activeOrganizationId" AS a FROM session WHERE "userId" = $1`,
          [userId],
        )
      ).rows.map((r) => r.a);
    expect(await active(member.userId)).toEqual([null]);
    expect(await active(owner.userId)).toEqual([org.id]);
  });

  it("emails the owner a notice and the leaver a receipt", async () => {
    const owner = await signUp("owner@leave6.io", undefined, "Olive Owner");
    const org = await createOrg(owner, "Design Team", "acme-leave6");
    const member = await signUp("member@leave6.io", undefined, "Max Member");
    await addMember(org.id, member.userId);

    expect((await leave(member.token, org.id)).status).toBe(200);
    await settle();

    expect(leaveMail().map((m) => m.to).sort()).toEqual(["member@leave6.io", "owner@leave6.io"]);
    const toOwner = leaveMail().find((m) => m.to === "owner@leave6.io")!;
    expect(toOwner.subject).toBe("Max Member left Design Team");
    expect(toOwner.text).toContain("member@leave6.io");
    expect(toOwner.text).toContain("shared with them directly have been un-shared");
    // Notification, not a call to action: no button, no link to paste.
    expect(toOwner.html).not.toContain("paste this link");

    const toMember = leaveMail().find((m) => m.to === "member@leave6.io")!;
    expect(toMember.subject).toBe("You left Design Team");
    expect(toMember.text).toContain("removed from your devices");
    expect(toMember.text).toContain("new invitation or join code");
  });

  it("sends nothing when the server has no mailer", async () => {
    __setMailerForTests(null);
    const owner = await signUp("owner@leave7.io");
    const org = await createOrg(owner, "Acme", "acme-leave7");
    const member = await signUp("member@leave7.io");
    await addMember(org.id, member.userId);

    expect((await leave(member.token, org.id)).status).toBe(200);
    await settle();
    expect(leaveMail()).toEqual([]);
  });

  it("re-inviting someone who left works: the join code path admits them again", async () => {
    const owner = await signUp("owner@leave8.io");
    const org = await createOrg(owner, "Acme", "acme-leave8");
    const member = await signUp("member@leave8.io");
    await addMember(org.id, member.userId);
    expect((await leave(member.token, org.id)).status).toBe(200);

    // Owner fetches the vault's join code (active org = this one).
    await pool.query(`UPDATE session SET "activeOrganizationId" = $1 WHERE "userId" = $2`, [
      org.id,
      owner.userId,
    ]);
    const codeRes = await app.fetch(
      new Request("http://local/api/orgs/join-code", {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(codeRes.status).toBe(200);
    const { code } = (await codeRes.json()) as { code: string };

    const joinRes = await app.fetch(
      new Request("http://local/api/orgs/join", {
        method: "POST",
        headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
    );
    expect(joinRes.status).toBe(200);
    expect(await memberCount(org.id, member.userId)).toBe(1);
  });
});
