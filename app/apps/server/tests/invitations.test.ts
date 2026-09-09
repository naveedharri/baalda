import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, bearerHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { __setMailerForTests, memoryOutbox } from "../src/email/mailer.js";

/**
 * Invitations by email (issue #99): the invite email, the landing page it links
 * to, the preview/inbox endpoints the desktop uses, and parity between the two
 * ways into a vault — an invited person who arrives via the join code must end
 * up exactly where accepting the email would have put them.
 */
const app = createApp(testAppDeps());

async function invite(owner: TestUser, orgId: string, email: string, role: "member" | "admin" = "member") {
  return (await auth.api.createInvitation({
    headers: bearerHeaders(owner),
    body: { email, role, organizationId: orgId },
  })) as { id: string; email: string; role: string; expiresAt: string | Date };
}

/** What the desktop does right after invite-member: ask the server to email it. */
function send(user: TestUser, invitationId: string) {
  return app.request(`/api/invitations/${invitationId}/send`, {
    method: "POST",
    headers: authHeaders(user),
  });
}

async function joinCode(owner: TestUser): Promise<string> {
  const res = await app.request("/api/orgs/join-code", { headers: authHeaders(owner) });
  return ((await res.json()) as { code: string }).code;
}

function join(user: TestUser, code: string) {
  return app.request("/api/orgs/join", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ code }),
  });
}

async function invitationRow(id: string) {
  const { rows } = await pool.query<{ status: string; role: string }>(
    `SELECT status, role FROM invitation WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("invitation emails + landing page", () => {
  beforeEach(async () => {
    await resetDb();
    memoryOutbox.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("emails the invitee a link to /invite/:id that bounces into the app", async () => {
    const owner = await signUp("owner@inv.io", "password12345", "Olive Owner");
    const org = await createOrg(owner, "Acme Notes", "acme-inv1");
    const inv = await invite(owner, org.id, "Teammate@Inv.io", "admin");
    // Creating the row sends nothing by itself (the only mail so far is the
    // owner's own sign-up confirmation); the explicit send reports.
    expect(memoryOutbox.filter((m) => m.to === "teammate@inv.io")).toHaveLength(0);
    const sent = await send(owner, inv.id);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ sent: true });

    const mail = memoryOutbox.find((m) => m.to === "teammate@inv.io");
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain("Olive Owner");
    expect(mail!.subject).toContain("Acme Notes");
    expect(mail!.text).toContain(`/invite/${inv.id}`);
    expect(mail!.text).toContain("as an admin");

    const res = await app.request(`/invite/${inv.id}`, { headers: { host: "notes.example.com" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Acme Notes");
    expect(html).toContain("teammate@inv.io");
    expect(html).toContain(
      `baalda://invite/${inv.id}?server=${encodeURIComponent("http://notes.example.com")}`,
    );
  });

  it("landing page explains a used, withdrawn or expired invitation instead of deep-linking", async () => {
    const owner = await signUp("owner@inv2.io");
    const org = await createOrg(owner, "Acme", "acme-inv2");

    const used = await invite(owner, org.id, "a@inv2.io");
    await pool.query(`UPDATE invitation SET status = 'accepted' WHERE id = $1`, [used.id]);
    const r1 = await app.request(`/invite/${used.id}`);
    expect(r1.status).toBe(410);
    expect(await r1.text()).toContain("already accepted");

    const expired = await invite(owner, org.id, "b@inv2.io");
    await pool.query(`UPDATE invitation SET "expiresAt" = now() - interval '1 hour' WHERE id = $1`, [expired.id]);
    const r2 = await app.request(`/invite/${expired.id}`);
    expect(r2.status).toBe(410);
    const expiredHtml = await r2.text();
    expect(expiredHtml).toContain("expired");
    expect(expiredHtml).not.toContain("baalda://");

    expect((await app.request("/invite/does-not-exist")).status).toBe(404);
    expect((await app.request("/invite/%3Cscript%3E")).status).toBe(400);
  });

  it("preview is public and reports the live state; inbox lists the session's pending invites", async () => {
    const owner = await signUp("owner@inv3.io", "password12345", "Olive");
    const org = await createOrg(owner, "Acme", "acme-inv3");
    const inv = await invite(owner, org.id, "tee@inv3.io");

    const preview = await app.request(`/api/invitations/${inv.id}/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      id: inv.id,
      email: "tee@inv3.io",
      role: "member",
      status: "pending",
      organizationId: org.id,
      organizationName: "Acme",
      inviterName: "Olive",
    });
    expect((await app.request("/api/invitations/nope/preview")).status).toBe(404);

    // The inbox works for a password sign-up whose email is NOT verified —
    // the case Better Auth's own list-user-invitations refuses with 403.
    const tee = await signUp("Tee@inv3.io");
    const { rows } = await pool.query<{ emailVerified: boolean }>(
      `SELECT "emailVerified" FROM "user" WHERE id = $1`,
      [tee.userId],
    );
    expect(rows[0].emailVerified).toBe(false);

    const mine = await app.request("/api/invitations/mine", { headers: authHeaders(tee) });
    expect(mine.status).toBe(200);
    const list = (await mine.json()) as Array<{ id: string; organizationName: string }>;
    expect(list.map((i) => i.id)).toEqual([inv.id]);
    expect(list[0].organizationName).toBe("Acme");

    // Someone else sees nothing; anonymous is refused.
    const other = await signUp("other@inv3.io");
    expect(await (await app.request("/api/invitations/mine", { headers: authHeaders(other) })).json()).toEqual([]);
    expect((await app.request("/api/invitations/mine")).status).toBe(401);
  });

  it("re-inviting a pending address replaces the invitation and re-sends", async () => {
    const owner = await signUp("owner@inv4.io");
    const org = await createOrg(owner, "Acme", "acme-inv4");
    const first = await invite(owner, org.id, "again@inv4.io");
    const second = await invite(owner, org.id, "again@inv4.io");
    expect(second.id).not.toBe(first.id);
    expect((await invitationRow(first.id)).status).toBe("canceled");
    expect((await invitationRow(second.id)).status).toBe("pending");
    // The replaced invitation can no longer be sent; the live one can.
    expect((await send(owner, first.id)).status).toBe(410);
    expect((await send(owner, second.id)).status).toBe(200);
    expect(memoryOutbox.filter((m) => m.to === "again@inv4.io")).toHaveLength(1);
  });

  it("send is owner/admin only and reports provider failures", async () => {
    const owner = await signUp("owner@inv8.io");
    const org = await createOrg(owner, "Acme", "acme-inv8");
    const inv = await invite(owner, org.id, "x@inv8.io");
    const stranger = await signUp("stranger@inv8.io");
    expect((await send(stranger, inv.id)).status).toBe(403);
    expect((await app.request(`/api/invitations/${inv.id}/send`, { method: "POST" })).status).toBe(401);
    expect((await send(owner, "does-not-exist")).status).toBe(404);

    __setMailerForTests({
      kind: "memory",
      async send() {
        throw new Error("connection refused");
      },
    });
    try {
      const res = await send(owner, inv.id);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "send_failed", message: expect.stringContaining("connection refused") });
    } finally {
      __setMailerForTests(null);
    }
  });

  it("join code consumes a pending invitation: same role, invitation marked accepted", async () => {
    const owner = await signUp("owner@inv5.io");
    const org = await createOrg(owner, "Acme", "acme-inv5");
    const inv = await invite(owner, org.id, "Ada@inv5.io", "admin");
    const code = await joinCode(owner);

    // Ada signs up with a differently-cased address and uses the code instead
    // of the email link.
    const ada = await signUp("ada@INV5.io");
    const res = await join(ada, code);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organizationId: org.id, alreadyMember: false, role: "admin" });

    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, ada.userId],
    );
    expect(rows[0].role).toBe("admin");
    expect((await invitationRow(inv.id)).status).toBe("accepted");

    // Nothing pending is left for her, and the admin's list agrees.
    const mine = await app.request("/api/invitations/mine", { headers: authHeaders(ada) });
    expect(await mine.json()).toEqual([]);
    const pending = (await auth.api.listInvitations({
      headers: bearerHeaders(owner),
      query: { organizationId: org.id },
    })) as Array<{ status: string }>;
    expect(pending.filter((i) => i.status === "pending")).toHaveLength(0);
  });

  it("join code without an invitation still yields a plain member", async () => {
    const owner = await signUp("owner@inv6.io");
    await createOrg(owner, "Acme", "acme-inv6");
    const code = await joinCode(owner);
    const walkIn = await signUp("walkin@inv6.io");
    const res = await join(walkIn, code);
    expect(await res.json()).toMatchObject({ alreadyMember: false, role: "member" });
  });

  it("accepting by email still works and lands the same way", async () => {
    const owner = await signUp("owner@inv7.io");
    const org = await createOrg(owner, "Acme", "acme-inv7");
    const inv = await invite(owner, org.id, "eve@inv7.io", "admin");
    const eve = await signUp("eve@inv7.io");
    const accepted = (await auth.api.acceptInvitation({
      headers: bearerHeaders(eve),
      body: { invitationId: inv.id },
    })) as { member?: { role: string } };
    expect(accepted.member?.role).toBe("admin");
    expect((await invitationRow(inv.id)).status).toBe("accepted");

    // The recipient check that the desktop maps to a friendly message.
    const inv2 = await invite(owner, org.id, "someone-else@inv7.io");
    const imposter = await signUp("imposter@inv7.io");
    await expect(
      auth.api.acceptInvitation({ headers: bearerHeaders(imposter), body: { invitationId: inv2.id } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not the recipient/i) });
  });
});
