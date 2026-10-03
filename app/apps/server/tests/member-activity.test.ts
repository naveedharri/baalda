import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { sealVault, seedFolder, seedMember, seedNote, seedShare, seedVault, seedVaultGrant } from "./helpers/seed.js";

/** GET /api/orgs/:orgId/members/:userId/activity — one member's activity feed. */
const app = createApp(testAppDeps());

type Person = { userId: string; name: string | null; email: string };
type Event =
  | { kind: "joined"; at: string; invitedBy: Person | null }
  | { kind: "created" | "edited"; at: string; docId: string; path: string }
  | {
      kind: "accessGranted";
      at: string;
      by: Person | null;
      permission: string;
      resourceType: string;
      resourceId: string;
      path: string | null;
    };

function activity(caller: TestUser, orgId: string, userId: string, limit?: number) {
  const q = limit === undefined ? "" : `?limit=${limit}`;
  return app.request(`/api/orgs/${orgId}/members/${userId}/activity${q}`, { headers: authHeaders(caller) });
}

async function feed(caller: TestUser, orgId: string, userId: string, limit?: number): Promise<Event[]> {
  const res = await activity(caller, orgId, userId, limit);
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: Event[] }).events;
}

async function acceptedInvite(orgId: string, email: string, inviterId: string, createdAt = "now()") {
  await pool.query(
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")
     VALUES ($1, $2, $3, 'member', 'accepted', now() + interval '2 days', ${createdAt}, $4)`,
    [randomUUID(), orgId, email, inviterId],
  );
}

async function setup() {
  const owner = await signUp("owner@activity.test");
  const org = await createOrg(owner, "Activity", `activity-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  return { owner, orgId: org.id, vaultId };
}

async function addMember(orgId: string, email: string, role: "member" | "admin" = "member") {
  const user = await signUp(email);
  await seedMember(orgId, user.userId, role);
  return user;
}

describe("member activity", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("gates: another member 403, self 200, admin 200, owner 200, outsider 403", async () => {
    const { owner, orgId } = await setup();
    const a = await addMember(orgId, "a@activity.test");
    const b = await addMember(orgId, "b@activity.test");
    const admin = await addMember(orgId, "admin@activity.test", "admin");
    const outsider = await signUp("x@activity.test");

    expect((await activity(a, orgId, b.userId)).status).toBe(403);
    expect((await activity(outsider, orgId, a.userId)).status).toBe(403);
    expect((await activity(a, orgId, a.userId)).status).toBe(200);
    expect((await activity(admin, orgId, a.userId)).status).toBe(200);
    expect((await activity(owner, orgId, a.userId)).status).toBe(200);
    expect((await activity(owner, orgId, outsider.userId)).status).toBe(404);
  });

  it("joined carries the latest accepted inviter; null without an invite", async () => {
    const { owner, orgId } = await setup();
    const admin = await addMember(orgId, "admin@activity.test", "admin");
    const invited = await addMember(orgId, "invited@activity.test");
    const byCode = await addMember(orgId, "code@activity.test");
    await acceptedInvite(orgId, "Invited@activity.test", owner.userId, "now() - interval '1 day'");
    await acceptedInvite(orgId, "invited@activity.test", admin.userId);

    const events = await feed(owner, orgId, invited.userId);
    const joined = events.find((e) => e.kind === "joined") as Extract<Event, { kind: "joined" }>;
    expect(joined.invitedBy).toEqual({ userId: admin.userId, name: expect.anything(), email: admin.email });
    expect(Date.parse(joined.at)).not.toBeNaN();

    const codeJoined = (await feed(owner, orgId, byCode.userId)).find((e) => e.kind === "joined");
    expect(codeJoined).toMatchObject({ kind: "joined", invitedBy: null });
  });

  it("reports created and edited (one per doc per day), newest first, skipping deleted notes", async () => {
    const { owner, orgId, vaultId } = await setup();
    const m = await addMember(orgId, "m@activity.test");
    await seedVaultGrant(orgId, "edit");
    const mine = await seedNote(vaultId, null, "mine.md", m.userId);
    const theirs = await seedNote(vaultId, null, "theirs.md", owner.userId);
    const gone = await seedNote(vaultId, null, "gone.md", m.userId);
    await pool.query(`UPDATE notes SET deleted_at = now() WHERE id = $1`, [gone]);
    // Three versions of `theirs` by m today, one yesterday → two edited events.
    for (const ago of ["3 hours", "2 hours", "1 hour", "1 day 2 hours"]) {
      await pool.query(
        `INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause, author_id, created_at)
         VALUES ($1, $2, 'x', 'h', 'idle', $3, (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '23 hours' - interval '${ago}') AT TIME ZONE 'UTC')`,
        [theirs, vaultId, m.userId],
      );
    }
    // Fallback: a last_edited stamp on a note with no authored versions.
    await pool.query(`UPDATE notes SET last_edited_by = $2, last_edited_at = now() WHERE id = $1`, [mine, m.userId]);

    const events = await feed(owner, orgId, m.userId);
    const created = events.filter((e) => e.kind === "created");
    expect(created).toEqual([expect.objectContaining({ docId: mine, path: "mine.md" })]);
    const edited = events.filter((e) => e.kind === "edited") as Array<Extract<Event, { kind: "edited" }>>;
    expect(edited.filter((e) => e.docId === theirs)).toHaveLength(2);
    expect(edited.filter((e) => e.docId === mine)).toHaveLength(1);
    expect(events.some((e) => "docId" in e && e.docId === gone)).toBe(false);
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());
  });

  it("reports a per-user share as accessGranted with granter and path", async () => {
    const { owner, orgId, vaultId } = await setup();
    const m = await addMember(orgId, "m@activity.test");
    const folder = await seedFolder(vaultId, null, "Projects", "Projects", owner.userId);
    const shareId = await seedShare(orgId, "folder", folder, m.userId, "edit");
    await pool.query(`UPDATE shares SET created_by = $2 WHERE id = $1`, [shareId, owner.userId]);

    const grant = (await feed(owner, orgId, m.userId)).find((e) => e.kind === "accessGranted");
    expect(grant).toMatchObject({
      kind: "accessGranted",
      by: { userId: owner.userId, email: owner.email },
      permission: "edit",
      resourceType: "folder",
      resourceId: folder,
      path: "Projects",
    });
  });

  it("never names a note the caller cannot read", async () => {
    const { owner, orgId, vaultId } = await setup();
    const admin = await addMember(orgId, "admin@activity.test", "admin");
    const m = await addMember(orgId, "m@activity.test");
    const shared = await seedNote(vaultId, null, "shared.md", m.userId);
    const secret = await seedNote(vaultId, null, "secret.md", m.userId);
    await sealVault(orgId);
    await seedShare(orgId, "file", shared, admin.userId, "view");
    await seedShare(orgId, "file", secret, m.userId, "edit");

    const events = await feed(admin, orgId, m.userId);
    const docIds = events.filter((e) => e.kind === "created").map((e) => (e as { docId: string }).docId);
    expect(docIds).toEqual([shared]);
    // The share on the secret note is still reported, but without its path.
    const grant = events.find((e) => e.kind === "accessGranted" && e.resourceId === secret);
    expect(grant).toMatchObject({ path: null });
    expect(JSON.stringify(events)).not.toContain("secret.md");
    void owner;
  });

  it("caps at limit (default 50, max 100)", async () => {
    const { owner, orgId, vaultId } = await setup();
    const m = await addMember(orgId, "m@activity.test");
    for (let i = 0; i < 120; i++) await seedNote(vaultId, null, `n${i}.md`, m.userId);
    await seedVaultGrant(orgId, "edit");

    expect(await feed(owner, orgId, m.userId, 5)).toHaveLength(5);
    expect(await feed(owner, orgId, m.userId)).toHaveLength(50);
    expect(await feed(owner, orgId, m.userId, 500)).toHaveLength(100);
  });
});
