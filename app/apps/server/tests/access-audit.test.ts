// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, expect, it } from "vitest";
import { pool, resetDb } from "./helpers/db.js";
import { seedMember, seedVault } from "./helpers/seed.js";
import { createOrg, signUp, authHeaders } from "./helpers/auth.js";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { listAccessAudit, withAuditActor } from "../src/audit/access.js";
import { applyBulkAccess, setJoinDefault } from "../src/permissions/access-management.js";
import { createMcpToken } from "../src/mcp/tokens.js";

const app = createApp(recordingAppDeps().deps);
beforeEach(resetDb);
afterAll(() => pool.end());

it("retains who changed access and removed membership, with manager-only paginated reads", async () => {
  const owner = await signUp("owner@audit.test");
  const admin = await signUp("admin@audit.test");
  const member = await signUp("member@audit.test");
  const org = await createOrg(owner, "Audit", "audit");
  await seedMember(org.id, admin.userId, "admin");
  const memberId = await seedMember(org.id, member.userId, "member");
  const vault = await seedVault(org.id);
  await pool.query("DELETE FROM access_audit");
  const request = (path: string, method: string, who = owner, body?: unknown) => app.fetch(new Request(
    `http://local/api${path}`, { method, headers: authHeaders(who), body: body === undefined ? undefined : JSON.stringify(body) },
  ));
  const shareInput = { resourceType: "vault", resourceId: org.id, principalType: "user", principalId: member.userId, permission: "view" };
  const create = await request("/shares", "POST", owner, shareInput);
  expect(create.status).toBe(201);
  const shareId = (await create.json() as { id: string }).id;
  expect((await request("/shares", "POST", admin, { ...shareInput, permission: "edit" })).status).toBe(201);
  let history = await listAccessAudit(org.id, owner.userId);
  const updated = history.events.find(e => e.entityId === shareId && e.action === "update");
  expect(updated).toMatchObject({ actorUserId: admin.userId, before: { permission: "view" }, after: { permission: "edit" } });
  expect((await request(`/orgs/${org.id}/members/${member.userId}`, "DELETE")).status).toBe(200);
  history = await listAccessAudit(org.id, owner.userId);
  expect(history.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ entityId: memberId, action: "delete", actorUserId: owner.userId, before: { userId: member.userId, role: "member" }, after: null }),
    expect.objectContaining({ entityId: shareId, action: "delete", actorUserId: owner.userId }),
  ]));
  expect((await request(`/orgs/${org.id}/access-audit`, "GET", member)).status).toBe(403);
  expect((await request(`/orgs/${org.id}/access-audit?before=not-a-number`, "GET")).status).toBe(400);
  const page = await listAccessAudit(org.id, owner.userId, { limit: 1 });
  expect(page.events).toHaveLength(1);
  expect(page.nextCursor).not.toBeNull();
  const next = await listAccessAudit(org.id, owner.userId, { before: page.nextCursor!, limit: 1 });
  expect(next.events[0].id).not.toBe(page.events[0].id);
  const token = await createMcpToken({ userId: owner.userId, organizationId: org.id }, "audit");
  const mcp = await app.fetch(new Request("http://local/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_access_audit", arguments: { limit: 1 } } }),
  }));
  const rpc = await mcp.json() as any;
  expect(rpc.result.isError).not.toBe(true);
  expect(rpc.result.structuredContent.events).toHaveLength(1);
  expect(vault).toBeTruthy();
});

it("logs bulk changes and join defaults atomically, ignores heartbeat updates and never leaks actor context", async () => {
  const owner = await signUp("bulk@audit.test");
  const org = await createOrg(owner, "Bulk", "audit-bulk");
  await seedVault(org.id);
  await pool.query("DELETE FROM access_audit");
  await applyBulkAccess({ organizationId: org.id, actorUserId: owner.userId,
    resources: [{ resourceType: "vault", resourceId: org.id }], audience: { type: "org" }, mode: "private" });
  await setJoinDefault(org.id, owner.userId, "readonly");
  const before = await listAccessAudit(org.id, owner.userId);
  expect(before.events.some(e => e.entityType === "shares" && e.actorUserId === owner.userId)).toBe(true);
  expect(before.events.some(e => e.after?.joinDefault === "readonly" && e.actorUserId === owner.userId)).toBe(true);
  await expect(withAuditActor(owner.userId, async client => {
    await client.query("DELETE FROM shares WHERE org_id = $1", [org.id]);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  await pool.query('UPDATE member SET last_seen_at = now() WHERE "organizationId" = $1', [org.id]);
  expect((await listAccessAudit(org.id, owner.userId)).events).toEqual(before.events);
  // Unattributed DB changes are explicit, never credited to the last HTTP caller.
  await pool.query('UPDATE member SET role = $1 WHERE "organizationId" = $2', ["admin", org.id]);
  expect((await listAccessAudit(org.id, owner.userId)).events[0].actorUserId).toBeNull();
});

it("attributes Better Auth removal to the caller, not the removed user", async () => {
  const owner = await signUp("native-owner@audit.test");
  const target = await signUp("native-target@audit.test");
  const org = await createOrg(owner, "Native", "audit-native");
  const memberId = await seedMember(org.id, target.userId, "member");
  const response = await app.fetch(new Request("http://local/api/auth/organization/remove-member", {
    method: "POST", headers: authHeaders(owner),
    body: JSON.stringify({ organizationId: org.id, memberIdOrEmail: memberId }),
  }));
  expect(response.status).toBe(200);
  const history = await listAccessAudit(org.id, owner.userId);
  expect(history.events.find(e => e.entityId === memberId && e.action === "delete"))
    .toMatchObject({ actorUserId: owner.userId, before: { userId: target.userId } });
});

it("Better Auth's own role endpoint stays refused and leaves no unattributed role event", async () => {
  const owner = await signUp("role-owner@audit.test");
  const target = await signUp("role-target@audit.test");
  const org = await createOrg(owner, "Role", "audit-role");
  const memberId = await seedMember(org.id, target.userId, "member");
  await pool.query("DELETE FROM access_audit");
  const response = await app.fetch(new Request("http://local/api/auth/organization/update-member-role", {
    method: "POST", headers: authHeaders(owner),
    body: JSON.stringify({ organizationId: org.id, memberId, role: "admin" }),
  }));
  expect(response.status).toBe(403);
  expect((await pool.query('SELECT role FROM member WHERE id=$1', [memberId])).rows[0].role).toBe("member");
  expect((await listAccessAudit(org.id, owner.userId)).events.filter(e => e.entityId === memberId)).toEqual([]);
  // The server's PATCH route is the supported path, and it is attributed.
  const patch = await app.fetch(new Request(`http://local/api/orgs/${org.id}/members/${target.userId}`, {
    method: "PATCH", headers: authHeaders(owner), body: JSON.stringify({ role: "admin" }),
  }));
  expect(patch.status).toBe(200);
  expect((await listAccessAudit(org.id, owner.userId)).events.find(e => e.entityId === memberId && e.action === "update"))
    .toMatchObject({ actorUserId: owner.userId, before: { role: "member" }, after: { role: "admin" } });
});

it("keeps access history after the vault is deleted, closed by a delete row", async () => {
  const owner = await signUp("owner-del@audit.test");
  const member = await signUp("member-del@audit.test");
  const org = await createOrg(owner, "Gone", "gone-audit");
  await seedMember(org.id, member.userId, "member");
  await seedVault(org.id);
  const count = async () =>
    Number((await pool.query("SELECT count(*) FROM access_audit WHERE organization_id = $1", [org.id])).rows[0].count);
  const before = await count();
  expect(before).toBeGreaterThan(0);
  const res = await app.fetch(new Request(`http://local/api/orgs/${org.id}`, { method: "DELETE", headers: authHeaders(owner) }));
  expect(res.status).toBe(200);
  expect((await pool.query("SELECT 1 FROM organization WHERE id = $1", [org.id])).rowCount).toBe(0);
  // Nothing cascaded away, and the cascade itself logged no per-row noise.
  expect(await count()).toBe(before + 1);
  const last = (await pool.query(
    "SELECT entity_type, action, actor_user_id, before_state FROM access_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1",
    [org.id],
  )).rows[0];
  expect(last).toMatchObject({ entity_type: "organization", action: "delete", actor_user_id: owner.userId, before_state: { name: "Gone" } });
});
