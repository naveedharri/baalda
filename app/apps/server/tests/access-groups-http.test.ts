// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { canCreateIn, vaultRootWritable } from "../src/permissions/http-gates.js";
import { listDeletedReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { sealVault, seedFolder, seedLock, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Access groups over HTTP: the lock list the sidebar padlocks from must imply
 * exactly what the resolver answers (an editable-looking note whose edits are
 * refused is the failure), and creates must pass the same write gates.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);
afterAll(async () => {
  await pool.end();
});

const call = (user: TestUser, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

let owner: TestUser;
let ana: TestUser; // in the group
let ben: TestUser; // in the group, with a personal vault Can view
let cat: TestUser; // not in any group
let org: string;
let vault: string;
let groupId: string;
let folders: { open: string; frozen: string; other: string; sub: string };
let notes: Record<string, string>;

async function grant(type: "vault" | "folder" | "file", id: string, permission: "edit" | "view") {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'group', $5, $6)`,
    [randomUUID(), org, type, id, groupId, permission],
  );
}

beforeEach(async () => {
  await resetDb();
  owner = await signUp("owner@groups-http.test");
  ana = await signUp("ana@groups-http.test");
  ben = await signUp("ben@groups-http.test");
  cat = await signUp("cat@groups-http.test");
  org = (await createOrg(owner, "Groups HTTP", "groups-http")).id;
  for (const u of [ana, ben, cat]) await seedMember(org, u.userId, "member");
  vault = await seedVault(org);
  const open = await seedFolder(vault, null, "Open", "Open", owner.userId);
  const sub = await seedFolder(vault, open, "Sub", "Open/Sub", owner.userId);
  const frozen = await seedFolder(vault, null, "Frozen", "Frozen", owner.userId);
  const other = await seedFolder(vault, null, "Other", "Other", owner.userId);
  folders = { open, frozen, other, sub };
  notes = {
    root: await seedNote(vault, null, "root.md", owner.userId),
    open: await seedNote(vault, open, "Open/a.md", owner.userId),
    sub: await seedNote(vault, sub, "Open/Sub/b.md", owner.userId),
    frozen: await seedNote(vault, frozen, "Frozen/c.md", owner.userId),
    other: await seedNote(vault, other, "Other/d.md", owner.userId),
  };
  const made = await call(owner, "POST", `/api/orgs/${org}/groups`, { name: "Writers", memberIds: [ana.userId, ben.userId] });
  expect(made.status).toBe(201);
  groupId = ((await made.json()) as { id: string }).id;
  await grant("folder", open, "edit");
  await grant("folder", frozen, "edit");
  await seedLock(org, "folder", frozen, { type: "org" });
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'user', $3, 'view')`,
    [randomUUID(), org, ben.userId],
  );
});

/** What the desktop draws from `GET /locks` (lib/locks.ts), per note: editable? */
async function sidebarEditable(user: TestUser): Promise<Record<string, boolean>> {
  const res = await call(user, "GET", `/api/vaults/${vault}/locks`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { locks: any[]; lifts?: any[] };
  const rows = [...body.locks, ...(body.lifts ?? [])];
  const vaultLock = rows.some((r) => r.resource_type === "vault" && r.permission !== "edit");
  const lifts = new Set(rows.filter((r) => r.permission === "edit").map((r) => r.resource_id));
  const itemLocks = new Set(
    rows
      .filter((r) => r.resource_type !== "vault" && r.permission !== "edit")
      .filter((r) => r.principal_type === "org" || r.principal_id === user.userId)
      .map((r) => r.resource_id),
  );
  const chain: Record<string, string[]> = {
    root: [notes.root],
    open: [notes.open, folders.open],
    sub: [notes.sub, folders.sub, folders.open],
    frozen: [notes.frozen, folders.frozen],
    other: [notes.other, folders.other],
  };
  const out: Record<string, boolean> = {};
  for (const [name, ids] of Object.entries(chain)) {
    const lifted = ids.some((id) => lifts.has(id));
    const locked = ids.some((id) => itemLocks.has(id));
    out[name] = !(vaultLock && !lifted) && !locked;
  }
  return out;
}

async function resolverEditable(user: TestUser): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const [name, id] of Object.entries(notes)) out[name] = (await effectivePermission(user.userId, id)) === "edit";
  return out;
}

describe("access groups: lock list ≡ resolver", () => {
  // `view`: a group Can view (a pure grant, never a cap) — on a folder, on the
  // vault, and on a folder whose subfolder the group can edit. Before /locks
  // reported these, a view-only folder looked editable in a sealed vault.
  for (const posture of ["shared", "read-only", "sealed"] as const) {
    for (const groupVault of [false, true, "view-folder", "view-vault", "view-over-edit"] as const) {
      it(`${posture}${groupVault === true ? " + group vault edit" : groupVault ? ` + group ${groupVault}` : ""}`, async () => {
        if (posture === "shared") await seedVaultGrant(org, "edit");
        if (posture === "read-only") await seedVaultGrant(org, "view");
        if (posture === "sealed") await sealVault(org);
        if (groupVault === true) await grant("vault", org, "edit");
        if (groupVault === "view-folder") await grant("folder", folders.other, "view");
        if (groupVault === "view-vault") await grant("vault", org, "view");
        if (groupVault === "view-over-edit") {
          // The group's own edit on Open/Sub stays editable under its view of Open.
          await pool.query("DELETE FROM shares WHERE principal_type = 'group' AND resource_id = $1", [folders.open]);
          await grant("folder", folders.open, "view");
          await grant("folder", folders.sub, "edit");
        }
        for (const u of [ana, ben, cat]) {
          const resolver = await resolverEditable(u);
          // Only notes the person can READ are drawn at all.
          const readable: Record<string, boolean> = {};
          for (const [name, id] of Object.entries(notes)) readable[name] = (await effectivePermission(u.userId, id)) !== "none";
          const sidebar = await sidebarEditable(u);
          for (const name of Object.keys(notes)) {
            if (!readable[name]) continue;
            expect(sidebar[name], `${u.email} ${name}`).toBe(resolver[name]);
          }
        }
      });
    }
  }

  it("a group view-only folder is padlocked even when it holds a note the person cannot see", async () => {
    await sealVault(org);
    await grant("folder", folders.other, "view");
    const hidden = await seedNote(vault, folders.other, "Other/hidden.md", owner.userId);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'file', $3, 'user', $4, 'denied')`,
      [randomUUID(), org, hidden, ana.userId],
    );
    const res = await call(ana, "GET", `/api/vaults/${vault}/locks`);
    const { locks } = (await res.json()) as { locks: any[] };
    const mine = locks.filter((l) => l.reason === "group_view");
    // The folder itself, not its visible note one by one; Open (edit) and its
    // subfolder untouched. (Frozen, capped by its team lock, is view-only too.)
    const ids = mine.map((l) => l.resource_id);
    expect(ids).toContain(folders.other);
    expect(ids).not.toContain(notes.other);
    expect(ids).not.toContain(folders.open);
    expect(ids).not.toContain(folders.sub);
    // With Frozen's group row gone Ana cannot see Frozen at all, so it is not named.
    await pool.query("DELETE FROM shares WHERE principal_type = 'group' AND resource_id = $1", [folders.frozen]);
    const again = ((await (await call(ana, "GET", `/api/vaults/${vault}/locks`)).json()) as { locks: any[] }).locks;
    expect(again.filter((l) => l.reason === "group_view").map((l) => l.resource_id)).toEqual([folders.other]);
    expect(await canCreateIn(ana.userId, vault, folders.other)).toBe(false);
  });

  it("a group's Can view on a SUBFOLDER whose parent it does not reach is padlocked there", async () => {
    // The parent is visible (a path to the readable subfolder) but outside the
    // group's grant: the padlock used to be left for it, and never sent.
    await sealVault(org);
    const inner = await seedFolder(vault, folders.other, "Inner", "Other/Inner", owner.userId);
    const innerNote = await seedNote(vault, inner, "Other/Inner/e.md", owner.userId);
    await grant("folder", inner, "view");
    const { locks } = (await (await call(ana, "GET", `/api/vaults/${vault}/locks`)).json()) as { locks: any[] };
    const ids = locks.filter((l) => l.reason === "group_view").map((l) => l.resource_id);
    expect(ids).toContain(inner);
    expect(ids).not.toContain(folders.other);
    expect(ids).not.toContain(innerNote);
    expect(await canCreateIn(ana.userId, vault, inner)).toBe(false);
  });

  it("concrete: Read-only vault, group edit on a folder", async () => {
    await seedVaultGrant(org, "view");
    expect(await resolverEditable(ana)).toEqual({ root: false, open: true, sub: true, frozen: false, other: false });
    // A person's own Can view everything ignores the group.
    expect(await resolverEditable(ben)).toEqual({ root: false, open: false, sub: false, frozen: false, other: false });
    expect(await resolverEditable(cat)).toEqual({ root: false, open: false, sub: false, frozen: false, other: false });
  });
});

describe("access groups: write gates", () => {
  it("group edit on a folder allows creating in it, not elsewhere; a group vault edit opens the root", async () => {
    await sealVault(org);
    expect(await canCreateIn(ana.userId, vault, folders.open)).toBe(true);
    expect(await canCreateIn(ana.userId, vault, folders.sub)).toBe(true);
    expect(await canCreateIn(ana.userId, vault, folders.other)).toBe(false);
    expect(await canCreateIn(ana.userId, vault, null)).toBe(false);
    expect(await canCreateIn(ben.userId, vault, folders.open)).toBe(false);
    expect(await canCreateIn(cat.userId, vault, folders.open)).toBe(false);

    const ok = await call(ana, "POST", "/api/notes", { vaultId: vault, relPath: "Open/new.md", folderId: folders.open });
    expect(ok.status).toBe(201);
    const refused = await call(ana, "POST", "/api/notes", { vaultId: vault, relPath: "Other/new.md", folderId: folders.other });
    expect(refused.status).toBe(403);

    await grant("vault", org, "edit");
    expect(await vaultRootWritable(ana.userId, org)).toBe(true);
    expect(await vaultRootWritable(ben.userId, org)).toBe(false);
    expect(await vaultRootWritable(cat.userId, org)).toBe(false);
    const atRoot = await call(ana, "POST", "/api/notes", { vaultId: vault, relPath: "top.md" });
    expect(atRoot.status).toBe(201);
  });

  it("a deleted note a group could read is reported as deleted to that member", async () => {
    await sealVault(org);
    await pool.query("UPDATE notes SET deleted_at = now(), purge_after = now() WHERE id = $1", [notes.open]);
    expect((await listDeletedReadableDocsInVault(ana.userId, vault)).has(notes.open)).toBe(true);
    expect((await listDeletedReadableDocsInVault(cat.userId, vault)).has(notes.open)).toBe(false);
  });

  it("group routes: list, rename, members, activity, and the group's board", async () => {
    const list = (await (await call(owner, "GET", `/api/orgs/${org}/groups`)).json()) as any;
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0]).toMatchObject({ name: "Writers", memberIds: expect.arrayContaining([ana.userId, ben.userId]) });
    expect(list.groups[0].grants.map((g: any) => g.path).sort()).toEqual(["Frozen", "Open"]);
    expect((await call(owner, "PATCH", `/api/orgs/${org}/groups/${groupId}`, { name: "Editors" })).status).toBe(200);
    expect((await call(owner, "POST", `/api/orgs/${org}/groups/${groupId}/members`, { userIds: [cat.userId] })).status).toBe(200);
    expect(await effectivePermission(cat.userId, notes.open)).toBe("edit");
    rec.reset();
    expect((await call(owner, "DELETE", `/api/orgs/${org}/groups/${groupId}/members/${cat.userId}`)).status).toBe(200);
    expect(await effectivePermission(cat.userId, notes.open)).toBe("none");
    const activity = (await (await call(owner, "GET", `/api/orgs/${org}/groups/${groupId}/activity`)).json()) as any;
    const kinds = activity.events.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "updated", "memberAdded", "memberRemoved", "accessGranted"]));
    const board = (await (await call(owner, "GET", `/api/vaults/${vault}/access-board?groupId=${groupId}`)).json()) as any;
    const modeOf = (id: string) => board.modes[board.folders.length + board.notes.findIndex((n: any) => n.id === id)];
    expect(modeOf(notes.open)).toBe("e");
    expect(modeOf(notes.root)).toBe("n");
    // Members see groups, never grants; they cannot read the board.
    const asMember = (await (await call(cat, "GET", `/api/orgs/${org}/groups`)).json()) as any;
    expect(asMember.groups[0].grants).toBeNull();
    expect((await call(cat, "GET", `/api/vaults/${vault}/access-board?groupId=${groupId}`)).status).toBe(403);
    // /health advertises it.
    const health = (await (await app.fetch(new Request("http://local/health"))).json()) as any;
    expect(health.features).toContain("access-groups");
  });

  it("invitations carry groups and members/overview lists them", async () => {
    const inv = await call(owner, "POST", `/api/orgs/${org}/invitations`, { emails: ["new@groups-http.test"], groupIds: [groupId] });
    expect(inv.status).toBe(200);
    const bad = await call(owner, "POST", `/api/orgs/${org}/invitations`, { emails: ["x@groups-http.test"], groupIds: ["nope"] });
    expect(bad.status).toBe(404);
    const both = await call(owner, "POST", `/api/orgs/${org}/invitations`, {
      emails: ["y@groups-http.test"], access: "readonly", groupIds: [groupId],
    });
    expect(both.status).toBe(400);
    const ov = (await (await call(owner, "GET", `/api/orgs/${org}/members/overview`)).json()) as any;
    expect(ov.members.find((m: any) => m.userId === ana.userId).groupIds).toEqual([groupId]);
    expect(ov.invitations.find((i: any) => i.email === "new@groups-http.test").groupIds).toEqual([groupId]);
    // ben has his own vault-wide level: groups change nothing for him, which the UI says.
    expect(ov.members.find((m: any) => m.userId === ben.userId).access.own).toBe(true);
    expect(ov.members.find((m: any) => m.userId === ana.userId).access.own).toBe(false);
  });

  it("Remove all (No access on the vault, group audience) clears every row the group holds, nobody else's", async () => {
    await grant("vault", org, "view");
    const before = await pool.query("SELECT count(*)::int AS n FROM shares WHERE principal_type = 'group'");
    expect(before.rows[0].n).toBe(3);
    const res = await call(owner, "POST", `/api/orgs/${org}/access/bulk`, {
      resources: [{ resourceType: "vault", resourceId: org }],
      audience: { type: "group", groupId },
      mode: "private",
    });
    expect(res.status).toBe(200);
    const after = await pool.query("SELECT count(*)::int AS n FROM shares WHERE principal_type = 'group'");
    expect(after.rows[0].n).toBe(0);
    // ben's own vault row and the org lock on Frozen are untouched.
    const rest = await pool.query("SELECT principal_type, permission FROM shares ORDER BY principal_type");
    expect(rest.rows.map((r: any) => `${r.principal_type}:${r.permission}`)).toEqual(expect.arrayContaining(["user:view"]));
    expect(rest.rows.some((r: any) => r.principal_type === "org")).toBe(true);
  });

  it("a resent invitation keeps its groups", async () => {
    const first = await call(owner, "POST", `/api/orgs/${org}/invitations`, { emails: ["again@groups-http.test"], groupIds: [groupId] });
    expect(first.status).toBe(200);
    const again = await call(owner, "POST", `/api/orgs/${org}/invitations`, { emails: ["again@groups-http.test"], groupIds: [groupId] });
    expect(again.status).toBe(200);
    const ov = (await (await call(owner, "GET", `/api/orgs/${org}/members/overview`)).json()) as any;
    expect(ov.invitations.find((i: any) => i.email === "again@groups-http.test").groupIds).toEqual([groupId]);
  });

  it("a group's skills tab lists every live skill with the group's row", async () => {
    await pool.query(
      `INSERT INTO skills (id, organization_id, name, draft_description) VALUES ('sk1', $1, 'writing', 'Write well'), ('sk2', $1, 'review', '')`,
      [org],
    );
    await pool.query("INSERT INTO skill_group_access (skill_id, group_id, level) VALUES ('sk1', $1, 'required')", [groupId]);
    const res = await call(owner, "GET", `/api/orgs/${org}/groups/${groupId}/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.skills.map((s: any) => [s.name, s.level])).toEqual([["review", null], ["writing", "required"]]);
    expect((await call(cat, "GET", `/api/orgs/${org}/groups/${groupId}/skills`)).status).toBe(403);
    expect((await call(owner, "GET", `/api/orgs/${org}/groups/nope/skills`)).status).toBe(404);
  });
});
