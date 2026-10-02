import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, bearerHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { memoryOutbox, type Mailer, type MailMessage } from "../src/email/mailer.js";
import {
  redactAddresses,
  setInvitationActivityPublisher,
  sweepInvitationsOnce,
} from "../src/invitations/sweep.js";

/**
 * #268: one reminder email about a day before an invitation expires (only when
 * the server sends email), and one Activity notice for the inviter and the
 * vault's admins once it expired unaccepted — each at most once.
 */
const app = createApp(testAppDeps());

function recordingMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    kind: "memory",
    sent,
    async send(msg) {
      sent.push(msg);
    },
  };
}

async function invite(owner: TestUser, orgId: string, email: string) {
  return (await auth.api.createInvitation({
    headers: bearerHeaders(owner),
    body: { email, role: "member", organizationId: orgId },
  })) as { id: string };
}

/** Move an invitation in time: created `ageHours` ago, expiring in `leftHours`. */
async function age(id: string, ageHours: number, leftHours: number) {
  await pool.query(
    `UPDATE invitation
        SET "createdAt" = now() - make_interval(hours => $2::int),
            "expiresAt" = now() + make_interval(hours => $3::int)
      WHERE id = $1`,
    [id, ageHours, leftHours],
  );
}

async function createVault(user: TestUser, organizationId: string) {
  const res = await app.request("/api/vaults", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: "Notes", organizationId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function expiries(user: TestUser, vaultId: string) {
  return app.request(`/api/vaults/${vaultId}/invitation-expiries`, { headers: authHeaders(user) });
}

describe("invitation reminders and expiry notices (#268)", () => {
  let owner: TestUser;
  let orgId: string;
  const published: string[] = [];

  beforeEach(async () => {
    await resetDb();
    memoryOutbox.length = 0;
    published.length = 0;
    setInvitationActivityPublisher((id) => published.push(id));
    owner = await signUp("owner@remind.io", "password12345", "Olive Owner");
    orgId = (await createOrg(owner, "Acme Notes", "acme-remind")).id;
  });
  afterEach(() => setInvitationActivityPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("reminds only pending invitations inside the last day, and only once", async () => {
    const due = await invite(owner, orgId, "due@remind.io");
    await age(due.id, 6 * 24, 12);
    const early = await invite(owner, orgId, "early@remind.io");
    await age(early.id, 4 * 24, 3 * 24);
    // Sent only hours ago with a short configured expiry: no "reminder" yet.
    const fresh = await invite(owner, orgId, "fresh@remind.io");
    await age(fresh.id, 2, 12);
    const accepted = await invite(owner, orgId, "accepted@remind.io");
    await age(accepted.id, 6 * 24, 12);
    await pool.query(`UPDATE invitation SET status = 'accepted' WHERE id = $1`, [accepted.id]);
    const canceled = await invite(owner, orgId, "canceled@remind.io");
    await age(canceled.id, 6 * 24, 12);
    await pool.query(`UPDATE invitation SET status = 'canceled' WHERE id = $1`, [canceled.id]);

    const mailer = recordingMailer();
    const first = await sweepInvitationsOnce({ mailer });
    expect(first).toMatchObject({ ran: true, reminded: 1, reminderFailures: 0, expired: 0 });
    expect(mailer.sent.map((m) => m.to)).toEqual(["due@remind.io"]);
    const mail = mailer.sent[0];
    expect(mail.subject).toContain("Reminder");
    expect(mail.subject).toContain("Acme Notes");
    expect(mail.text).toContain(`/invite/${due.id}`);
    expect(mail.text).toContain("Olive Owner");

    const again = await sweepInvitationsOnce({ mailer });
    expect(again.reminded).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("sends nothing and claims nothing while email is off", async () => {
    const due = await invite(owner, orgId, "due@remind.io");
    await age(due.id, 6 * 24, 12);

    const off = await sweepInvitationsOnce({ mailer: null });
    expect(off).toMatchObject({ ran: true, reminded: 0, reminderFailures: 0 });
    const { rows } = await pool.query(`SELECT 1 FROM invitation_notices WHERE reminder_sent_at IS NOT NULL`);
    expect(rows).toHaveLength(0);
    expect(memoryOutbox.filter((m) => m.to === "due@remind.io")).toHaveLength(0);

    // Turning email on later still reminds what is inside the window.
    const mailer = recordingMailer();
    expect((await sweepInvitationsOnce({ mailer })).reminded).toBe(1);
  });

  it("does not retry a failed send, and keeps the address out of the log line", async () => {
    const due = await invite(owner, orgId, "due@remind.io");
    await age(due.id, 6 * 24, 12);
    let calls = 0;
    const failing: Mailer = {
      kind: "memory",
      async send() {
        calls++;
        throw new Error("rejected recipient due@remind.io");
      },
    };
    expect((await sweepInvitationsOnce({ mailer: failing })).reminderFailures).toBe(1);
    expect((await sweepInvitationsOnce({ mailer: failing })).reminderFailures).toBe(0);
    expect(calls).toBe(1);
    expect(redactAddresses(new Error("rejected recipient due@remind.io"))).toBe("rejected recipient <address>");
  });

  it("skips its turn while another instance holds the sweep", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('invitation-sweep', 0))");
      expect((await sweepInvitationsOnce({ mailer: null })).ran).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await sweepInvitationsOnce({ mailer: null })).ran).toBe(true);
  });

  it("records one expiry notice per invitation and announces it to the vault", async () => {
    const expired = await invite(owner, orgId, "late@remind.io");
    await age(expired.id, 8 * 24, -1);
    // Expired long before this shipped: already in the members list, not news.
    const old = await invite(owner, orgId, "old@remind.io");
    await age(old.id, 30 * 24, -10 * 24);
    const live = await invite(owner, orgId, "live@remind.io");
    await age(live.id, 1, 5 * 24);

    const first = await sweepInvitationsOnce({ mailer: null });
    expect(first.expired).toBe(1);
    expect(published).toEqual([orgId]);
    const { rows } = await pool.query<{ invitation_id: string }>(
      `SELECT invitation_id FROM invitation_notices WHERE expired_noticed_at IS NOT NULL`,
    );
    expect(rows.map((r) => r.invitation_id)).toEqual([expired.id]);

    const again = await sweepInvitationsOnce({ mailer: null });
    expect(again.expired).toBe(0);
    expect(published).toEqual([orgId]);
  });

  it("lists the notice in the vault's Activity until a Resend answers it", async () => {
    const vaultId = await createVault(owner, orgId);
    const expired = await invite(owner, orgId, "late@remind.io");
    await age(expired.id, 8 * 24, -1);
    await sweepInvitationsOnce({ mailer: null });

    const res = await expiries(owner, vaultId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      invitationId: expired.id,
      organizationId: orgId,
      email: "late@remind.io",
      role: "member",
      inviterId: owner.userId,
      inviterName: "Olive Owner",
    });

    // Only members of the vault may read it.
    const stranger = await signUp("stranger@remind.io");
    expect((await expiries(stranger, vaultId)).status).toBe(403);
    expect((await expiries(owner, "no-such-vault")).status).toBe(404);

    // Resend = a fresh invitation to the same address: the notice is answered.
    expect(published).toEqual([orgId]);
    await invite(owner, orgId, "late@remind.io");
    // …and the open feeds are told to drop it.
    expect(published).toEqual([orgId, orgId]);
    const after = (await (await expiries(owner, vaultId)).json()) as { items: unknown[] };
    expect(after.items).toHaveLength(0);
  });

  it("shows a plain member only the invitations they sent", async () => {
    const vaultId = await createVault(owner, orgId);
    const member = await signUp("member@remind.io");
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ('m-remind', $1, $2, 'member', now())`,
      [orgId, member.userId],
    );
    const expired = await invite(owner, orgId, "late@remind.io");
    await age(expired.id, 8 * 24, -1);
    await sweepInvitationsOnce({ mailer: null });

    const res = await expiries(member, vaultId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});
