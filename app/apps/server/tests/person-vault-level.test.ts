// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { applyBulkAccess } from "../src/permissions/access-management.js";
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

  describe("the deepest of a person's own rows wins", () => {
    async function userRow(orgId: string, type: "folder" | "file", id: string, userId: string, permission: string) {
      await pool.query(
        `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
        [randomUUID(), orgId, type, id, userId, permission],
      );
    }

    it("(a) per-user folder readonly + per-user file edit ⇒ edit, also for an owner at vault view", async () => {
      const f = await fixture("edit");
      await userRow(f.org, "folder", f.folder, f.member, "readonly");
      await userRow(f.org, "file", f.doc, f.member, "edit");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("edit");
      expect(await allPaths(f.member, f.own, f.org, "member")).toBe("view"); // the folder cap still holds here

      await personVault(f.org, f.owner, "view");
      await userRow(f.org, "folder", f.folder, f.owner, "readonly");
      await userRow(f.org, "file", f.doc, f.owner, "edit");
      expect(await allPaths(f.owner, f.doc, f.org, "owner")).toBe("edit");
      expect(await allPaths(f.owner, f.own, f.org, "owner")).toBe("view");
    });

    it("(b) per-user folder denied + per-user file view ⇒ view", async () => {
      const f = await fixture("sealed");
      await userRow(f.org, "folder", f.folder, f.member, "denied");
      await userRow(f.org, "file", f.doc, f.member, "view");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
      expect(await allPaths(f.member, f.own, f.org, "member")).toBe("none");
      expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([f.doc]));
      // The denied folder stays in the tree as the path to the lifted note.
      expect((await listVisibleFolders(f.member, f.vault)).map((r) => r.id)).toEqual([f.folder]);
    });

    it("(b2) a deeper per-user folder grant lifts a denied parent folder; its path stays visible", async () => {
      const f = await fixture("edit");
      const sub = await seedFolder(f.vault, f.folder, "Sub", "Docs/Sub", f.owner);
      const inner = await seedNote(f.vault, sub, "Docs/Sub/i.md", f.owner);
      await userRow(f.org, "folder", f.folder, f.member, "denied");
      await userRow(f.org, "folder", sub, f.member, "edit");
      expect(await allPaths(f.member, inner, f.org, "member")).toBe("edit");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("none");
      expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([inner]));
      expect((await listVisibleFolders(f.member, f.vault)).map((r) => r.id).sort()).toEqual([f.folder, sub].sort());
      expect(await canEditFolder(f.member, sub)).toBe(true);
      expect(await canEditFolder(f.member, f.folder)).toBe(false);
    });

    it("(c) per-user folder edit + per-user file denied ⇒ none", async () => {
      const f = await fixture("edit");
      await userRow(f.org, "folder", f.folder, f.member, "edit");
      await userRow(f.org, "file", f.doc, f.member, "denied");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("none");
      expect(await allPaths(f.member, f.own, f.org, "member")).toBe("edit");
      expect(await listReadableDocsInVault(f.member, f.vault)).toEqual(new Set([f.own]));
    });

    it("(d) per-user folder readonly with no file row ⇒ view (unchanged)", async () => {
      const f = await fixture("edit");
      await userRow(f.org, "folder", f.folder, f.member, "readonly");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
      expect(await canEditFolder(f.member, f.folder)).toBe(false);
    });

    it("(e) ORG folder lock + per-user file edit ⇒ view (org locks unchanged)", async () => {
      const f = await fixture("edit");
      await seedLock(f.org, "folder", f.folder, { type: "org" });
      await userRow(f.org, "file", f.doc, f.member, "edit");
      expect(await allPaths(f.member, f.doc, f.org, "member")).toBe("view");
    });
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

  it("an owner's own vault `view` is lifted to edit by their per-user file/folder edit (bulk API)", async () => {
    await seedVaultGrant(orgId, "edit");
    const folder = await seedFolder(vaultId, null, "F", "F", owner.userId);
    const doc = await seedNote(vaultId, folder, "F/n.md", owner.userId);
    const other = await seedNote(vaultId, folder, "F/o.md", owner.userId);
    const folder2 = await seedFolder(vaultId, null, "G", "G", owner.userId);
    const inner = await seedNote(vaultId, folder2, "G/i.md", owner.userId);
    const bulk = (resourceType: "vault" | "folder" | "file", resourceId: string, mode: "open" | "readonly") =>
      applyBulkAccess({
        organizationId: orgId,
        actorUserId: owner.userId,
        resources: [{ resourceType, resourceId }],
        audience: { type: "users", userIds: [owner.userId] },
        mode,
      });
    const summary = async (resourceType: "folder" | "file", resourceId: string) => {
      const res = await call(owner, "POST", `/api/orgs/${orgId}/access/summaries`, {
        groups: [[{ resourceType, resourceId }]],
        userIds: [owner.userId],
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { modes: string[] }).modes[0];
    };

    await bulk("vault", orgId, "readonly"); // the owner's own level: Can view
    expect(await allPaths(owner.userId, doc, orgId, "owner")).toBe("view");
    expect(await summary("file", doc)).toBe("readonly");

    await bulk("file", doc, "open"); // that one note → Can edit
    expect(await allPaths(owner.userId, doc, orgId, "owner")).toBe("edit");
    expect(await allPaths(owner.userId, other, orgId, "owner")).toBe("view");
    expect(await summary("file", doc)).toBe("open");
    expect(await summary("file", other)).toBe("readonly");

    await bulk("folder", folder2, "open"); // a whole folder → Can edit
    expect(await allPaths(owner.userId, inner, orgId, "owner")).toBe("edit");
    expect(await summary("folder", folder2)).toBe("open");
  });

  it("bulk: owner's folder set to Can view (per-user `readonly`), then one note in it to Can edit ⇒ edit, summary open", async () => {
    await seedVaultGrant(orgId, "edit");
    const concepts = await seedFolder(vaultId, null, "Concepts", "Concepts", owner.userId);
    const doc = await seedNote(vaultId, concepts, "Concepts/a.md", owner.userId);
    const sibling = await seedNote(vaultId, concepts, "Concepts/b.md", owner.userId);
    const bulk = (resourceType: "folder" | "file", resourceId: string, mode: "open" | "readonly") =>
      applyBulkAccess({
        organizationId: orgId,
        actorUserId: owner.userId,
        resources: [{ resourceType, resourceId }],
        audience: { type: "users", userIds: [owner.userId] },
        mode,
      });
    const summary = async (resourceType: "folder" | "file", resourceId: string) =>
      ((await (
        await call(owner, "POST", `/api/orgs/${orgId}/access/summaries`, {
          groups: [[{ resourceType, resourceId }]],
          userIds: [owner.userId],
        })
      ).json()) as { modes: string[] }).modes[0];

    await bulk("folder", concepts, "readonly");
    const { rows } = await pool.query<{ permission: string }>(
      `SELECT permission FROM shares WHERE resource_type = 'folder' AND resource_id = $1 AND principal_type = 'user'`,
      [concepts],
    );
    expect(rows.map((r) => r.permission)).toEqual(["readonly"]); // the dev-DB row
    expect(await allPaths(owner.userId, doc, orgId, "owner")).toBe("view");

    await bulk("file", doc, "open");
    expect(await allPaths(owner.userId, doc, orgId, "owner")).toBe("edit");
    expect(await allPaths(owner.userId, sibling, orgId, "owner")).toBe("view");
    expect(await summary("file", doc)).toBe("open");
    expect(await summary("file", sibling)).toBe("readonly");
    expect(await summary("folder", concepts)).toBe("mixed");
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
