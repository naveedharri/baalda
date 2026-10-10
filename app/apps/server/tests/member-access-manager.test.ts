import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedVault } from "./helpers/seed.js";
import { canManageMemberAccess } from "../src/permissions/access-management.js";

/** Who may change one member's access: owner → anyone, admin → anyone but the owner. */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

function bulk(caller: TestUser, orgId: string, folderId: string, userId: string) {
  return app.request(`/api/orgs/${orgId}/access/bulk`, {
    method: "POST",
    headers: { ...authHeaders(caller), "content-type": "application/json" },
    body: JSON.stringify({
      mode: "readonly",
      resources: [{ resourceType: "folder", resourceId: folderId }],
      audience: { type: "users", userIds: [userId] },
    }),
  });
}

function share(caller: TestUser, folderId: string, userId: string) {
  return app.request(`/api/shares`, {
    method: "POST",
    headers: { ...authHeaders(caller), "content-type": "application/json" },
    body: JSON.stringify({
      resourceType: "folder",
      resourceId: folderId,
      principalType: "user",
      principalId: userId,
      permission: "view",
    }),
  });
}

async function setup() {
  const owner = await signUp("owner@mgr.test");
  const org = await createOrg(owner, "Mgr", `mgr-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  const folder = await seedFolder(vaultId, null, "F", "F", owner.userId);
  const add = async (email: string, role: "member" | "admin") => {
    const u = await signUp(email);
    await seedMember(org.id, u.userId, role);
    return u;
  };
  return {
    owner,
    orgId: org.id,
    folder,
    member: await add("m@mgr.test", "member"),
    member2: await add("m2@mgr.test", "member"),
    admin: await add("a@mgr.test", "admin"),
    admin2: await add("a2@mgr.test", "admin"),
  };
}

describe("member access management by role", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("pure rule", () => {
    expect(canManageMemberAccess("owner", "owner", true)).toBe(true);
    expect(canManageMemberAccess("owner", "admin", false)).toBe(true);
    expect(canManageMemberAccess("admin", "member", false)).toBe(true);
    expect(canManageMemberAccess("admin", "admin", true)).toBe(true);
    expect(canManageMemberAccess("admin", "admin", false)).toBe(true);
    expect(canManageMemberAccess("admin", "owner", false)).toBe(false);
    expect(canManageMemberAccess("member", "member", false)).toBe(false);
    expect(canManageMemberAccess("member", "member", true)).toBe(false);
  });

  it("bulk access: admin → member/admin/self ok, admin → owner 403, member → anyone 403", async () => {
    const s = await setup();
    expect((await bulk(s.admin, s.orgId, s.folder, s.member.userId)).status).toBe(200);
    expect((await bulk(s.admin, s.orgId, s.folder, s.admin.userId)).status).toBe(200);
    const toOwner = await bulk(s.admin, s.orgId, s.folder, s.owner.userId);
    expect(toOwner.status).toBe(403);
    expect(await toOwner.json()).toMatchObject({ error: "access_manager_required" });
    expect((await bulk(s.admin, s.orgId, s.folder, s.admin2.userId)).status).toBe(200);
    expect((await bulk(s.member, s.orgId, s.folder, s.member2.userId)).status).toBe(403);
    expect((await bulk(s.owner, s.orgId, s.folder, s.admin2.userId)).status).toBe(200);
  });

  it("POST /shares per-user: admin → member/admin ok, admin → owner 403", async () => {
    const s = await setup();
    expect((await share(s.admin, s.folder, s.member.userId)).status).toBeLessThan(300);
    const toOwner = await share(s.admin, s.folder, s.owner.userId);
    expect(toOwner.status).toBe(403);
    expect(await toOwner.json()).toMatchObject({ error: "access_manager_required" });
    expect((await share(s.admin, s.folder, s.admin2.userId)).status).toBeLessThan(300);
    expect((await share(s.member, s.folder, s.member2.userId)).status).toBe(403);
    expect((await share(s.owner, s.folder, s.admin.userId)).status).toBeLessThan(300);
  });
});
