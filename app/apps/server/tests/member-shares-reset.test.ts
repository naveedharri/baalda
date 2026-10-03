import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  sealVault,
  seedFolder,
  seedMember,
  seedNote,
  seedShare,
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/** DELETE /api/orgs/:orgId/members/:userId/shares — reset one member's grants. */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

function reset(caller: TestUser, orgId: string, userId: string) {
  return app.request(`/api/orgs/${orgId}/members/${userId}/shares`, {
    method: "DELETE",
    headers: authHeaders(caller),
  });
}

async function userRows(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT 1 FROM shares WHERE principal_type = 'user' AND principal_id = $1`,
    [userId],
  );
  return rows.length;
}

async function setup() {
  const owner = await signUp("owner@reset.test");
  const org = await createOrg(owner, "Reset", `reset-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  return { owner, orgId: org.id, vaultId };
}

async function addMember(orgId: string, email: string, role: "member" | "admin" = "member") {
  const user = await signUp(email);
  await seedMember(orgId, user.userId, role);
  return user;
}

describe("member shares reset", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("gates: member 403, admin on another admin/owner 403, admin on member/self 200, owner on anyone 200, non-member 404", async () => {
    const { owner, orgId } = await setup();
    const m = await addMember(orgId, "m@reset.test");
    const m2 = await addMember(orgId, "m2@reset.test");
    const admin = await addMember(orgId, "admin@reset.test", "admin");
    const admin2 = await addMember(orgId, "admin2@reset.test", "admin");
    const outsider = await signUp("x@reset.test");

    expect((await reset(m, orgId, m2.userId)).status).toBe(403);
    expect((await reset(m, orgId, m.userId)).status).toBe(403);
    expect((await reset(admin, orgId, admin2.userId)).status).toBe(403);
    expect((await reset(admin, orgId, owner.userId)).status).toBe(403);
    expect((await reset(admin, orgId, m.userId)).status).toBe(200);
    expect((await reset(admin, orgId, admin.userId)).status).toBe(200);
    expect((await reset(owner, orgId, admin2.userId)).status).toBe(200);
    expect((await reset(owner, orgId, outsider.userId)).status).toBe(404);
    expect(await (await reset(owner, orgId, outsider.userId)).json()).toMatchObject({ error: "not_member" });
  });

  it("removes only that member's vault + item rows, returns the count, kicks lost docs", async () => {
    const { owner, orgId, vaultId } = await setup();
    const m = await addMember(orgId, "m@reset.test");
    const other = await addMember(orgId, "other@reset.test");
    const folder = await seedFolder(vaultId, null, "F", "F", owner.userId);
    const inFolder = await seedNote(vaultId, folder, "F/a.md", owner.userId);
    const loose = await seedNote(vaultId, null, "b.md", owner.userId);
    await sealVault(orgId); // org row: must survive
    await seedUserVaultGrant(orgId, m.userId, "view");
    await seedShare(orgId, "folder", folder, m.userId, "edit");
    await seedShare(orgId, "file", loose, m.userId, "edit");
    await seedShare(orgId, "file", loose, other.userId, "view");
    const orgRowsBefore = (await pool.query(`SELECT 1 FROM shares WHERE principal_type = 'org'`)).rows.length;

    const res = await reset(owner, orgId, m.userId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number; disconnectedDocs: number };
    expect(body.removed).toBe(3);
    expect(await userRows(m.userId)).toBe(0);
    expect(await userRows(other.userId)).toBe(1);
    expect((await pool.query(`SELECT 1 FROM shares WHERE principal_type = 'org'`)).rows.length).toBe(orgRowsBefore);

    // Sealed vault: m could read both notes via the removed grants, now neither.
    expect(body.disconnectedDocs).toBe(2);
    expect(rec.disconnected.map((d) => d.docId).sort()).toEqual([inFolder, loose].sort());
    expect(rec.aclBroadcasts).toContain(vaultId);
  });

  it("disconnects nothing the member can still read, and leaves join snapshots alone", async () => {
    const { owner, orgId, vaultId } = await setup();
    const m = await addMember(orgId, "m@reset.test");
    const note = await seedNote(vaultId, null, "n.md", owner.userId);
    await seedVaultGrant(orgId, "edit");
    await seedShare(orgId, "file", note, m.userId, "edit");
    const snapsBefore = (await pool.query(`SELECT 1 FROM member_access_snapshots`)).rows.length;

    const body = (await (await reset(owner, orgId, m.userId)).json()) as { removed: number; disconnectedDocs: number };
    expect(body).toEqual({ removed: 1, disconnectedDocs: 0 });
    expect(rec.disconnected).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM member_access_snapshots`)).rows.length).toBe(snapsBefore);
  });

  it("is a no-op with nothing to remove", async () => {
    const { owner, orgId } = await setup();
    const m = await addMember(orgId, "m@reset.test");
    expect(await (await reset(owner, orgId, m.userId)).json()).toEqual({ removed: 0, disconnectedDocs: 0 });
    expect(rec.aclBroadcasts).toHaveLength(0);
  });
});
