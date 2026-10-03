// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { summarizeAccess } from "../src/permissions/access-summary.js";
import { canEditFolder, vaultRootWritable } from "../src/permissions/http-gates.js";
import {
  buildAccessContext,
  createResolverCache,
  effectivePermission,
  loadAccessIndex,
  resolveAccessForUser,
} from "../src/permissions/resolver.js";
import { listReadableDocsInVault, listVisibleFolders } from "../src/permissions/vault-docs.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * "Person wins either way": a per-user row on the VAULT resource is that
 * person's absolute level for the vault. It replaces the org posture, the join
 * snapshot, the owner/admin shortcut and authorship — for owners and admins
 * too — while item-level rows still apply on top of it.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

async function personVault(orgId: string, userId: string, permission: "edit" | "view" | "denied"): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'user', $3, $4)
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
     DO UPDATE SET permission = EXCLUDED.permission`,
    [randomUUID(), orgId, userId, permission],
  );
}

/** Every resolver path must agree: plain SQL, cached, prefetched, indexed. */
async function allPaths(userId: string, docId: string, orgId: string, role: string | null) {
  const plain = await effectivePermission(userId, docId);
  const cached = await effectivePermission(userId, docId, pool, createResolverCache());
  const pre = createResolverCache();
  await pre.prefetch(pool, [docId]);
  const prefetched = await effectivePermission(userId, docId, pool, pre);
  const ctx = (await buildAccessContext("file", docId))!;
  const listed = (await resolveAccessForUser(ctx, userId, role)).permission;
  const index = await loadAccessIndex(pool, orgId);
  const indexed = (await resolveAccessForUser(ctx, userId, role, pool, undefined, index)).permission;
  expect(new Set([plain, cached, prefetched, listed, indexed]).size, JSON.stringify({ plain, cached, prefetched, listed, indexed })).toBe(1);
  return plain;
}

async function fixture(posture: "edit" | "view" | "sealed" | null = "edit") {
  const org = await seedOrg("Person level", `person-${randomUUID()}`);
  const owner = await seedUser(`owner-${randomUUID()}@test.dev`);
  await seedMember(org, owner, "owner");
  const admin = await seedUser(`admin-${randomUUID()}@test.dev`);
  await seedMember(org, admin, "admin");
  const member = await seedUser(`member-${randomUUID()}@test.dev`);
  await seedMember(org, member, "member");
  const vault = await seedVault(org);
  if (posture === "sealed") await sealVault(org);
  else if (posture) await seedVaultGrant(org, posture);
  // Created AFTER everyone joined, so no join snapshot applies to it.
  const folder = await seedFolder(vault, null, "Docs", "Docs", owner);
  const doc = await seedNote(vault, folder, "Docs/a.md", owner);
  const own = await seedNote(vault, folder, "Docs/mine.md", member);
  return { org, owner, admin, member, vault, folder, doc, own };
}

describe("per-person vault level", () => {
  beforeEach(resetDb);

  it("view caps an edit-posture member, an admin and authorship", async () => {
    const f = await fixture("edit");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");
    expect(await allPaths(f.admin, f.doc, f.org, "admin")).toBe("edit");

    await personVault(f.org, f.member, "view");
    await personVault(f.org, f.admin, "view");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
    expect(await allPaths(f.member, f.own, f.org, "member")).toBe("view"); // authorship capped
    expect(await allPaths(f.admin, f.doc, f.org, "admin")).toBe("view");
    expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([f.doc, f.own]));
    expect(await canEditFolder(f.member, f.folder)).toBe(false);
    expect(await vaultRootWritable(f.member, f.org)).toBe(false);
  });

  it("view raises someone who would otherwise have nothing (sealed vault)", async () => {
    const f = await fixture("sealed");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("none");
    await personVault(f.org, f.member, "view");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
  });

  it("denied hides everything from an edit-posture member and from a note's creator", async () => {
    const f = await fixture("edit");
    await personVault(f.org, f.member, "denied");
    await personVault(f.org, f.owner, "denied");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("none");
    expect(await allPaths(f.member, f.own, f.org, "member")).toBe("none");
    expect(await allPaths(f.owner, f.doc, f.org, "owner")).toBe("none"); // creator AND owner
    expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set());
    expect(await listReadableDocsInVault(f.owner, f.vault)).toEqual(new Set());
    expect(await listVisibleFolders(f.member, f.vault)).toEqual([]);
    expect(await listVisibleFolders(f.owner, f.vault)).toEqual([]);
    expect(await canEditFolder(f.owner, f.folder)).toBe(false);
    expect(await vaultRootWritable(f.owner, f.org)).toBe(false);

    const ctx = (await buildAccessContext("file", f.doc))!;
    expect(await resolveAccessForUser(ctx, f.member, "member")).toMatchObject({ permission: "none", denied: true });
  });

  it("a per-user folder edit lifts above a per-user vault denied (and view)", async () => {
    const f = await fixture("edit");
    await personVault(f.org, f.member, "denied");
    await seedShare(f.org, "folder", f.folder, f.member, "edit");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");
    expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([f.doc, f.own]));
    expect((await listVisibleFolders(f.member, f.vault)).map((r) => r.id)).toEqual([f.folder]);

    await personVault(f.org, f.member, "view");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");
  });

  it("denied is not lifted by an Everyone folder share, only by a per-user one", async () => {
    const f = await fixture("edit");
    await personVault(f.org, f.member, "denied");
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'org', $2, 'edit')`,
      [randomUUID(), f.org, f.folder],
    );
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("none");
    expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set());
    expect(await listVisibleFolders(f.member, f.vault)).toEqual([]);
    expect(await canEditFolder(f.member, f.folder)).toBe(false);

    // The same Everyone share still lifts a person whose own level is `view`.
    await personVault(f.org, f.member, "view");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");

    await personVault(f.org, f.member, "denied");
    await seedShare(f.org, "folder", f.folder, f.member, "view");
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
    expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([f.doc, f.own]));
    expect((await listVisibleFolders(f.member, f.vault)).map((r) => r.id)).toEqual([f.folder]);
  });

  it("a lock still caps a per-user vault edit", async () => {
    const f = await fixture("edit");
    await personVault(f.org, f.member, "edit");
    await seedLock(f.org, "folder", f.folder, { type: "user", id: f.member });
    expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
  });

  it("edit lifts above a Read-only posture, a sealed vault and a Private join snapshot", async () => {
    for (const posture of ["view", "sealed"] as const) {
      await resetDb();
      const f = await fixture(posture);
      expect(await allPaths(f.member, f.doc, f.org, "member")).not.toBe("edit");
      await personVault(f.org, f.member, "edit");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");
      expect(await vaultRootWritable(f.member, f.org)).toBe(true);
    }

    await resetDb();
    const f = await fixture("edit");
    // Joins AFTER the content exists, under the default (Private) join snapshot.
    const late = await seedUser(`late-${randomUUID()}@test.dev`);
    await seedMember(f.org, late, "member");
    expect(await allPaths(late, f.doc, f.org, "member")).toBe("none");
    expect(await listReadableDocsInVault(late, f.vault)).not.toContain(f.doc);
    await personVault(f.org, late, "edit");
    expect(await allPaths(late, f.doc, f.org, "member")).toBe("edit");
    expect(await listReadableDocsInVault(late, f.vault)).toContain(f.doc);
    expect((await listVisibleFolders(late, f.vault)).map((r) => r.id)).toContain(f.folder);
  });

  it("access summaries report the person's level for the vault root", async () => {
    const f = await fixture("edit");
    await personVault(f.org, f.member, "view");
    await personVault(f.org, f.admin, "denied");
    const summarize = async (userId: string, role: string) =>
      (
        await summarizeAccess({
          db: pool,
          index: await loadAccessIndex(pool, f.org),
          cache: createResolverCache(),
          groups: [[{ resourceType: "vault", resourceId: f.org }]],
          userIds: [userId],
          roles: new Map([[userId, role]]),
        })
      )[0];
    expect(await summarize(f.member, "member")).toBe("readonly");
    expect(await summarize(f.admin, "admin")).toBe("private");
    expect(await summarize(f.owner, "owner")).toBe("open");
  });
});

describe("per-person vault level over HTTP", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vaultId: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner-${randomUUID()}@test.dev`);
    member = await signUp(`member-${randomUUID()}@test.dev`);
    orgId = (await createOrg(owner, "HTTP", `http-${randomUUID()}`)).id;
    await seedMember(orgId, member.userId, "member");
    vaultId = await seedVault(orgId);
  });

  const call = (user: TestUser, method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: authHeaders(user),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it("POST /shares accepts a per-user vault denied, and it takes effect", async () => {
    await seedVaultGrant(orgId, "edit");
    const folder = await seedFolder(vaultId, null, "F", "F", owner.userId);
    const doc = await seedNote(vaultId, folder, "F/n.md", owner.userId);
    expect(await effectivePermission(member.userId, doc)).toBe("edit");

    const res = await call(owner, "POST", "/api/shares", {
      resourceType: "vault",
      resourceId: orgId,
      principalType: "user",
      principalId: member.userId,
      permission: "denied",
    });
    expect(res.status).toBe(201);
    expect(await effectivePermission(member.userId, doc)).toBe("none");
  });

  it("GET /locks lifts include the caller's per-user vault edit under Read-only", async () => {
    await seedVaultGrant(orgId, "view");
    await personVault(orgId, member.userId, "edit");
    const res = await call(member, "GET", `/api/vaults/${vaultId}/locks`);
    expect(res.status).toBe(200);
    const { locks } = (await res.json()) as { locks: Array<Record<string, string>> };
    expect(locks).toContainEqual(expect.objectContaining({ id: `vault:${orgId}`, permission: "locked" }));
    expect(locks).toContainEqual(
      expect.objectContaining({ resource_type: "vault", principal_type: "user", principal_id: member.userId, permission: "edit" }),
    );
    // The owner never sees the member's personal row.
    const own = (await (await call(owner, "GET", `/api/vaults/${vaultId}/locks`)).json()) as {
      locks: Array<Record<string, string>>;
    };
    expect(own.locks.some((l) => l.principal_id === member.userId)).toBe(false);
  });

  it("GET /locks padlocks everything for a caller capped by a per-user vault view", async () => {
    await seedVaultGrant(orgId, "edit");
    await personVault(orgId, member.userId, "view");
    const mine = (await (await call(member, "GET", `/api/vaults/${vaultId}/locks`)).json()) as {
      locks: Array<Record<string, string>>;
    };
    expect(mine.locks).toContainEqual(expect.objectContaining({ id: `vault:${orgId}`, permission: "locked" }));
    const owners = (await (await call(owner, "GET", `/api/vaults/${vaultId}/locks`)).json()) as {
      locks: Array<Record<string, string>>;
    };
    expect(owners.locks.some((l) => l.id === `vault:${orgId}`)).toBe(false);
  });
});
