import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import {
  listReadableDocsInVault,
  listVisibleFolders,
} from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedDeny,
  seedFolder,
  seedItemPrivate,
  seedLock,
  seedMember,
  seedNote,
  seedShare,
  sealVault,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * The whole-vault team-access control (`/api/orgs/:orgId/team-access`).
 *
 * The vault-level setting is the per-item Shared/Read-only/Private control at
 * vault scope, so applying it must ENFORCE the mode: every org-principal
 * override on a folder or file is cleared, exactly as the per-item control
 * clears an item's own org rows. Per-USER rows (named grants, per-member locks,
 * per-member denies) survive untouched, for the same reason they survive a
 * per-item change.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

// One per FILE: an afterAll inside the first describe would close the pool
// before the second one ran.
afterAll(async () => {
  await pool.end();
});

function get(user: TestUser, path: string) {
  return app.fetch(new Request(`http://local${path}`, { headers: authHeaders(user) }));
}

function put(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "PUT",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

function post(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

/** An ORG-scoped grant on a folder/file — "Shared with team" (edit) or
 *  "Read-only for the team" (view). The seed helpers cover `locked`/`denied`
 *  only, and the vault control has to clear all four. */
async function seedOrgGrant(
  orgId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  permission: "edit" | "view",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'org', $2, $5)`,
    [id, orgId, resourceType, resourceId, permission],
  );
  return id;
}

async function countUserShares(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM shares WHERE org_id = $1 AND principal_type = 'user'",
    [orgId],
  );
  return Number(rows[0].n);
}

async function orgRowsOn(resourceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM shares WHERE resource_id = $1 AND principal_type = 'org'",
    [resourceId],
  );
  return rows.map((r) => r.id);
}

interface TeamAccessBody {
  mode: "open" | "readonly" | "private";
  grantId: string | null;
  overrides: Array<{
    id: string;
    vaultId: string;
    resourceType: "folder" | "file";
    resourceId: string;
    permission: "edit" | "view" | "locked" | "denied";
  }>;
}

describe("team-access — GET and PUT", () => {
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let vaultA: string;
  let vaultB: string;
  // vault A
  let rootNote: string;
  let sharedFolder: string;
  let sharedNote: string;
  let privateFolder: string;
  let privateNote: string;
  let deletedNote: string;
  // vault B
  let lockedFolder: string;
  let lockedNote: string;
  let viewNote: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@team-access.test");
    orgId = (await createOrg(owner, "Team Access Co", "team-access-co")).id;
    admin = await signUp("admin@team-access.test");
    await seedMember(orgId, admin.userId, "admin");
    member = await signUp("member@team-access.test");
    await seedMember(orgId, member.userId, "member");
    outsider = await signUp("outsider@team-access.test");

    // TWO note collections in the same org — the control spans all of them.
    vaultA = await seedVault(orgId, "A");
    vaultB = await seedVault(orgId, "B");

    rootNote = await seedNote(vaultA, null, "Root.md", owner.userId);
    sharedFolder = await seedFolder(vaultA, null, "Shared", "Shared");
    sharedNote = await seedNote(vaultA, sharedFolder, "Shared/S.md", owner.userId);
    privateFolder = await seedFolder(vaultA, null, "Private", "Private");
    privateNote = await seedNote(vaultA, privateFolder, "Private/P.md", owner.userId);
    deletedNote = await seedNote(vaultA, null, "Gone.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [deletedNote]);

    lockedFolder = await seedFolder(vaultB, null, "Locked", "Locked");
    lockedNote = await seedNote(vaultB, lockedFolder, "Locked/L.md", owner.userId);
    viewNote = await seedNote(vaultB, null, "View.md", owner.userId);

    // The four org overrides the control owns — one per permission, spread
    // across both collections.
    await seedOrgGrant(orgId, "folder", sharedFolder, "edit");
    await seedOrgGrant(orgId, "file", viewNote, "view");
    await seedLock(orgId, "folder", lockedFolder, { type: "org" });
    await seedItemPrivate(orgId, "folder", privateFolder);
    // A leftover row on a soft-deleted note — never reported, never counted.
    await seedItemPrivate(orgId, "file", deletedNote);

    // Per-user rows: all three must survive every PUT. Kept off vault A's
    // notes so they can't colour the effective-permission assertions.
    await seedShare(orgId, "file", viewNote, member.userId, "edit");
    await seedDeny(orgId, "file", lockedNote, member.userId);
    await seedLock(orgId, "folder", lockedFolder, { type: "user", id: member.userId });
  });
  async function readTeamAccess(user = owner): Promise<TeamAccessBody> {
    const res = await get(user, `/api/orgs/${orgId}/team-access`);
    expect(res.status).toBe(200);
    return (await res.json()) as TeamAccessBody;
  }

  // ── GET ────────────────────────────────────────────────────────────────────

  it("GET reports private when there is no vault row, and lists every org override", async () => {
    const body = await readTeamAccess();
    expect(body.mode).toBe("private");
    expect(body.grantId).toBeNull();

    expect(body.overrides).toHaveLength(4);
    const byResource = new Map(body.overrides.map((o) => [o.resourceId, o]));
    expect(byResource.get(sharedFolder)).toMatchObject({
      vaultId: vaultA,
      resourceType: "folder",
      permission: "edit",
    });
    expect(byResource.get(privateFolder)).toMatchObject({
      vaultId: vaultA,
      resourceType: "folder",
      permission: "denied",
    });
    expect(byResource.get(lockedFolder)).toMatchObject({
      vaultId: vaultB,
      resourceType: "folder",
      permission: "locked",
    });
    expect(byResource.get(viewNote)).toMatchObject({
      vaultId: vaultB,
      resourceType: "file",
      permission: "view",
    });
  });

  it("GET excludes per-user rows and rows on soft-deleted notes", async () => {
    const body = await readTeamAccess();
    expect(body.overrides.map((o) => o.resourceId)).not.toContain(deletedNote);
    // Three per-user rows exist; none of them is reported.
    expect(await countUserShares(orgId)).toBe(3);
    for (const o of body.overrides) {
      const { rows } = await pool.query<{ principal_type: string }>(
        "SELECT principal_type FROM shares WHERE id = $1",
        [o.id],
      );
      expect(rows[0].principal_type).toBe("org");
    }
  });

  it("GET reports open for an edit vault row and readonly for a view one", async () => {
    const grant = await seedVaultGrant(orgId, "edit");
    let body = await readTeamAccess();
    expect(body.mode).toBe("open");
    expect(body.grantId).toBe(grant);

    await pool.query("UPDATE shares SET permission = 'view' WHERE id = $1", [grant]);
    body = await readTeamAccess();
    expect(body.mode).toBe("readonly");
    expect(body.grantId).toBe(grant);
  });

  it("summarizes selected people across folder descendants in one request", async () => {
    const nested = await seedFolder(vaultA, sharedFolder, "Nested", "Shared/Nested");
    await seedNote(vaultA, nested, "Shared/Nested/N.md", owner.userId);
    await seedItemPrivate(orgId, "folder", nested);

    const res = await post(owner, `/api/orgs/${orgId}/access/summary`, {
      resources: [{ resourceType: "folder", resourceId: sharedFolder }],
      userIds: [member.userId],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "mixed" });
  });

  it("refuses an access summary for a person outside the vault", async () => {
    const res = await post(owner, `/api/orgs/${orgId}/access/summary`, {
      resources: [{ resourceType: "file", resourceId: rootNote }],
      userIds: [outsider.userId],
    });
    expect(res.status).toBe(400);
  });

  // ── PUT ────────────────────────────────────────────────────────────────────

  it("PUT private on a Can edit vault is refused and changes nothing", async () => {
    await seedVaultGrant(orgId, "edit");
    const before = await readTeamAccess();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("default_access_fixed");
    expect(await readTeamAccess()).toEqual(before);
    expect(await effectivePermission(member.userId, sharedNote)).toBe("edit");
    expect(await effectivePermission(member.userId, rootNote)).toBe("edit");
    expect(await countUserShares(orgId)).toBe(3);
  });

  
  it("PUT private on a never-shared vault is refused, so members keep what they wrote", async () => {
    // Sealing would withdraw authorship: every member's own notes would leave
    // their disk. Default access is fixed, so it never happens.
    const mine = await seedNote(vaultA, null, "Mine.md", member.userId);
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(409);
    expect((await readTeamAccess()).grantId).toBeNull();
    expect(rec.disconnected).toEqual([]);
    expect(await effectivePermission(member.userId, mine)).toBe("edit");
  });

  
  it("re-applying private on an already sealed vault changes nothing", async () => {
    await sealVault(orgId);
    const before = await readTeamAccess();
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: false,
      disconnectedDocs: 0,
    });
    expect(rec.disconnected).toEqual([]);
    // The folder settings the conversion kept are left alone.
    expect(await readTeamAccess()).toEqual(before);
  });

  
  it("an admin can read the default, and is refused a change like the owner", async () => {
    expect((await get(admin, `/api/orgs/${orgId}/team-access`)).status).toBe(200);
    await seedVaultGrant(orgId, "edit");
    const res = await put(admin, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(409);
    expect((await readTeamAccess()).mode).toBe("open");
  });

  
  it("Default access is fixed: Can edit and Can view are refused and change nothing", async () => {
    await seedVaultGrant(orgId, "edit");
    for (const user of [owner, admin]) {
      for (const mode of ["open", "readonly"]) {
        const res = await put(user, `/api/orgs/${orgId}/team-access`, { mode });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe("default_access_fixed");
      }
    }
    const after = await readTeamAccess();
    expect(after.mode).toBe("open");
    expect(after.overrides).toHaveLength(4);
  });

  it("POST and DELETE /shares refuse the default-access row, whatever the permission", async () => {
    const grant = await seedVaultGrant(orgId, "edit");
    for (const permission of ["edit", "view", "denied", "locked"]) {
      const res = await post(owner, "/api/shares", {
        resourceType: "vault", resourceId: orgId, principalType: "org", permission,
      });
      expect(res.status, permission).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("default_access_fixed");
    }
    const del = await app.fetch(new Request(`http://local/api/shares/${grant}`, { method: "DELETE", headers: authHeaders(owner) }));
    expect(del.status).toBe(409);
    const after = await readTeamAccess();
    expect(after.mode).toBe("open");
    expect(after.grantId).toBe(grant);
    // A person's own vault level is not default access: still accepted.
    const own = await post(owner, "/api/shares", {
      resourceType: "vault", resourceId: orgId, principalType: "user", principalId: member.userId, permission: "view",
    });
    expect(own.status).toBe(201);
  });

  it("the bulk API refuses an Everyone change on the whole vault, and nothing is written", async () => {
    await seedVaultGrant(orgId, "edit");
    const before = await readTeamAccess();
    for (const mode of ["private", "readonly", "open"]) {
      const res = await post(owner, `/api/orgs/${orgId}/access/bulk`, {
        mode, audience: { type: "org" }, resources: [{ resourceType: "vault", resourceId: orgId }],
      });
      expect(res.status, mode).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("default_access_fixed");
    }
    expect(await readTeamAccess()).toEqual(before);
  });

  
  it("a plain member is refused both verbs", async () => {
    expect((await get(member, `/api/orgs/${orgId}/team-access`)).status).toBe(403);
    expect((await put(member, `/api/orgs/${orgId}/team-access`, { mode: "open" })).status).toBe(403);
  });

  it("a non-member is refused both verbs", async () => {
    // `canManage` resolves the org (it exists) and then fails the role check.
    expect((await get(outsider, `/api/orgs/${orgId}/team-access`)).status).toBe(403);
    expect(
      (await put(outsider, `/api/orgs/${orgId}/team-access`, { mode: "open" })).status,
    ).toBe(403);
  });

  it("an unknown org is 404 and an unknown mode is 400", async () => {
    expect((await get(owner, `/api/orgs/${randomUUID()}/team-access`)).status).toBe(404);
    expect(
      (await put(owner, `/api/orgs/${randomUUID()}/team-access`, { mode: "open" })).status,
    ).toBe(404);
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "shared" })).status).toBe(400);
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, {})).status).toBe(400);
  });

  it("an unauthenticated caller is 401", async () => {
    const res = await app.fetch(new Request(`http://local/api/orgs/${orgId}/team-access`));
    expect(res.status).toBe(401);
  });

  // ── Transactionality ───────────────────────────────────────────────────────

  
});

/**
 * Socket kicks. The rule is the one `DELETE /shares/:id` already follows: a row
 * that goes away kicks every doc it reached, a new grant kicks nobody. A vault
 * row rewritten to the SAME permission never went away, so it kicks nobody
 * either.
 */
describe("team-access — live socket kicks", () => {
  let owner: TestUser;
  let orgId: string;
  let vault: string;
  let folder: string;
  let folderNote: string;
  let rootNote: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@team-kick.test");
    orgId = (await createOrg(owner, "Kick Co", "kick-co")).id;
    vault = await seedVault(orgId);
    folder = await seedFolder(vault, null, "Team", "Team");
    folderNote = await seedNote(vault, folder, "Team/T.md", owner.userId);
    rootNote = await seedNote(vault, null, "Root.md", owner.userId);
  });
  it("a refused change kicks nobody and broadcasts nothing", async () => {
    await seedOrgGrant(orgId, "folder", folder, "edit");
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(409);
    expect(rec.disconnected).toEqual([]);
    expect(rec.aclBroadcasts).toEqual([]);
  });

  
  it("a no-op re-apply broadcasts no ACL change", async () => {
    await sealVault(orgId);
    rec.reset();
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(200);
    expect(rec.aclBroadcasts).toEqual([]);
  });

  
});

/**
 * What a plain MEMBER can still read after the vault is set to Private.
 *
 * The desktop removes a note from disk when it leaves the member's readable
 * set, so "Entire vault → Private" only reaches their disk if the three server
 * surfaces the reconciler consults all agree the set is empty: the resolver's
 * readable-doc set (the vault channel), the visible-folder set, and the
 * ACL-filtered registry listings the pull reads. They are three different
 * queries over the same algebra, so each is asserted separately.
 */
describe("team-access — a member's readable set after Private", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let rootNote: string;
  let folder: string;
  let folderNote: string;
  let ownNote: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@private-removal.test");
    orgId = (await createOrg(owner, "Private Removal Co", "private-removal-co")).id;
    member = await signUp("member@private-removal.test");
    await seedMember(orgId, member.userId, "member");

    vault = await seedVault(orgId, "V");
    rootNote = await seedNote(vault, null, "Root.md", owner.userId);
    folder = await seedFolder(vault, null, "Docs", "Docs");
    folderNote = await seedNote(vault, folder, "Docs/D.md", owner.userId);
    // The member's OWN note: authorship keeps it, by design.
    ownNote = await seedNote(vault, null, "Mine.md", member.userId);

    // Start from a shared vault, the state a team is normally in.
    await seedVaultGrant(orgId, "edit");
  });

  it("shared → the member reads every doc and sees every folder", async () => {
    expect(await listReadableDocsInVault(member.userId, vault)).toEqual(
      new Set([rootNote, folderNote, ownNote]),
    );
    expect((await listVisibleFolders(member.userId, vault)).map((f) => f.path)).toEqual(["Docs"]);
  });

  it("a sealed vault empties the member's readable set, folders and registry listings", async () => {
    await sealVault(orgId);

    // 1. The resolver's set-based dual (the vault channel's authority). NOTHING
    //    survives, `ownNote` included: pressing Private seals the vault, and a
    //    sealed vault drops authorship for everyone.
    expect(await listReadableDocsInVault(member.userId, vault)).toEqual(new Set());
    // Per-doc agreement with the canonical resolver.
    expect(await effectivePermission(member.userId, rootNote)).toBe("none");
    expect(await effectivePermission(member.userId, folderNote)).toBe("none");
    expect(await effectivePermission(member.userId, ownNote)).toBe("none");

    // 2. The folder set: nothing the owner made is visible any more.
    expect(await listVisibleFolders(member.userId, vault)).toEqual([]);

    // 3. What the desktop's registry pull actually reads. Both listings must
    //    still answer 200 with a complete, empty-but-for-mine body — a 403 here
    //    would abort the pull and leave the files on disk forever.
    const notes = await get(member, `/api/notes?vaultId=${vault}`);
    expect(notes.status).toBe(200);
    const noteBody = (await notes.json()) as {
      notes: Array<{ id: string }>;
      tombstones: string[];
    };
    expect(noteBody.notes).toEqual([]);
    // Answered, not withheld: `null` tombstones means "I don't know" to the
    // client and stops it removing anything at all.
    expect(Array.isArray(noteBody.tombstones)).toBe(true);

    const folders = await get(member, `/api/folders?vaultId=${vault}`);
    expect(folders.status).toBe(200);
    const folderBody = (await folders.json()) as {
      folders: Array<{ id: string }>;
      tombstones: string[];
    };
    expect(folderBody.folders).toEqual([]);
    expect(Array.isArray(folderBody.tombstones)).toBe(true);
  });

  it("empties the owner's too — the setting applies to the seat that made it", async () => {
    // The complaint this answers: Private meant one thing on a folder (the org
    // deny drops owners, admins and the author) and another on the vault
    // (everyone kept what they wrote, and in a vault you set up yourself that
    // is nearly everything — so pressing it changed nothing you could see).
    // Sealed means sealed, for the person who pressed it most of all.
    await sealVault(orgId);

    expect(await listReadableDocsInVault(owner.userId, vault)).toEqual(new Set());
    expect(await effectivePermission(owner.userId, rootNote)).toBe("none");
    expect(await effectivePermission(owner.userId, folderNote)).toBe("none");
    expect(await effectivePermission(owner.userId, ownNote)).toBe("none");
    // No readable note left to hang it on, so no folder either.
    expect(await listVisibleFolders(owner.userId, vault)).toEqual([]);
  });

  it("a folder shared with the team still lifts out of a sealed vault", async () => {
    // Sealed is a FLOOR, not a wall: it is the one thing an item set Private
    // does differently, because there the point is to withdraw a single item
    // from a team that can otherwise reach it.
    await sealVault(orgId);
    await seedOrgGrant(orgId, "folder", folder, "edit");

    for (const who of [owner, member]) {
      expect(await listReadableDocsInVault(who.userId, vault)).toEqual(new Set([folderNote]));
      expect(await effectivePermission(who.userId, folderNote)).toBe("edit");
      expect(await effectivePermission(who.userId, rootNote)).toBe("none");
    }
  });

  it("per-item Private on one folder revokes only that folder — the path that already worked", async () => {
    const res = await app.fetch(
      new Request("http://local/api/shares", {
        method: "POST",
        headers: authHeaders(owner),
        body: JSON.stringify({
          resourceType: "folder",
          resourceId: folder,
          principalType: "org",
          principalId: orgId,
          permission: "denied",
        }),
      }),
    );
    expect(res.status).toBeLessThan(300);
    expect(await listReadableDocsInVault(member.userId, vault)).toEqual(
      new Set([rootNote, ownNote]),
    );
    expect(await listVisibleFolders(member.userId, vault)).toEqual([]);
  });
});

/**
 * The lock overlay a read-only vault publishes.
 *
 * Read-only for the whole vault is stored as ONE `view` grant on the vault
 * resource, not as locks on the items — but to the person reading the sidebar
 * it is a lock on every folder and note, so `GET /vaults/:id/locks` reports it
 * as a synthetic `resource_type: 'vault'` row with `permission: 'locked'`.
 */
describe("team-access — the vault posture in the lock overlay", () => {
  interface LockRow {
    id: string;
    resource_type: "folder" | "file" | "vault";
    resource_id: string;
    principal_type: "user" | "org";
    principal_id: string;
    permission: "locked" | "denied" | "edit";
  }

  let owner: TestUser;
  let member: TestUser;
  let other: TestUser;
  let orgId: string;
  let vault: string;
  let folder: string;
  let note: string;
  let loose: string;

  async function locks(user: TestUser): Promise<LockRow[]> {
    const res = await get(user, `/api/vaults/${vault}/locks`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { locks: LockRow[] }).locks;
  }

  const vaultRows = (rows: LockRow[]) => rows.filter((r) => r.resource_type === "vault");
  const liftRows = (rows: LockRow[]) => rows.filter((r) => r.permission === "edit");

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@vault-lock.test");
    orgId = (await createOrg(owner, "Vault Lock Co", "vault-lock-co")).id;
    member = await signUp("member@vault-lock.test");
    await seedMember(orgId, member.userId, "member");
    other = await signUp("other@vault-lock.test");
    await seedMember(orgId, other.userId, "member");
    vault = await seedVault(orgId, "V");
    folder = await seedFolder(vault, null, "Docs", "Docs");
    note = await seedNote(vault, folder, "Docs/N.md", owner.userId);
    loose = await seedNote(vault, null, "Loose.md", owner.userId);
  });

  it("Read-only publishes exactly one vault row, as a lock, to an ordinary member", async () => {
    expect(vaultRows(await locks(member))).toHaveLength(0);

    expect((await legacyPosture(orgId, "view")).status).toBe(200);

    const rows = await locks(member);
    const posture = vaultRows(rows);
    expect(posture).toHaveLength(1);
    expect(posture[0]).toMatchObject({
      resource_type: "vault",
      resource_id: orgId,
      principal_type: "org",
      principal_id: orgId,
      // Synthesised: the stored row says `view`, which is a grant the client's
      // lock map would drop on the floor.
      permission: "locked",
    });
    // The stored row is untouched — only the wire shape changes.
    const { rows: stored } = await pool.query<{ permission: string }>(
      "SELECT permission FROM shares WHERE resource_type = 'vault' AND resource_id = $1",
      [orgId],
    );
    expect(stored.map((r) => r.permission)).toEqual(["view"]);
  });

  it("Shared and Private publish no vault row at all", async () => {
    await legacyPosture(orgId, "view");
    expect(vaultRows(await locks(member))).toHaveLength(1);

    // An open vault grants; it does not cap.
    await legacyPosture(orgId, "edit");
    expect(vaultRows(await locks(member))).toHaveLength(0);

    // Private deletes the row entirely.
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(vaultRows(await locks(member))).toHaveLength(0);
  });

  it("a per-item lock still appears alongside the vault row", async () => {
    await legacyPosture(orgId, "view");
    await seedLock(orgId, "folder", folder, { type: "org" });

    const rows = await locks(member);
    expect(vaultRows(rows)).toHaveLength(1);
    expect(rows.filter((r) => r.resource_type === "folder" && r.resource_id === folder)).toHaveLength(1);
  });

  it("the owner sees the posture row too — it caps them as well", async () => {
    await legacyPosture(orgId, "view");
    expect(vaultRows(await locks(owner))).toHaveLength(1);
  });

  it("the posture row carries a NON-routable id, never the live grant row's", async () => {
    await legacyPosture(orgId, "view");
    const posture = vaultRows(await locks(member))[0];
    expect(posture.id).toBe(`vault:${orgId}`);

    // The point of the synthetic id: `DELETE /shares/:id` on the real grant row
    // is "Entire vault → Private", and an unlock path that ever passed this id
    // through would do exactly that. Pin it so a future refactor cannot quietly
    // hand the grant row's id back out.
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM shares WHERE resource_type = 'vault' AND resource_id = $1",
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(posture.id).not.toBe(rows[0].id);
  });

  // ── The lifts ──────────────────────────────────────────────────────────────
  //
  // Read-only is a baseline the resolver lets an `edit` row lift, so the client
  // needs those rows to know which subtrees are NOT actually locked.

  it("reports the org edit rows that lift the posture, and only under Read-only", async () => {
    await seedOrgGrant(orgId, "folder", folder, "edit");

    // Shared: no posture, so nothing to lift and nothing to report.
    await legacyPosture(orgId, "edit");
    expect(liftRows(await locks(member))).toHaveLength(0);

    // Read-only clears the item overrides, so re-apply one after the PUT — which
    // is exactly the two-click path an admin takes in the Access panel.
    await legacyPosture(orgId, "view");
    await seedOrgGrant(orgId, "folder", folder, "edit");

    const lifts = liftRows(await locks(member));
    expect(lifts).toHaveLength(1);
    expect(lifts[0]).toMatchObject({
      resource_type: "folder",
      resource_id: folder,
      principal_type: "org",
      permission: "edit",
    });
  });

  it("reports the CALLER's own per-user edit row and never anyone else's", async () => {
    await legacyPosture(orgId, "view");
    await seedShare(orgId, "file", note, member.userId, "edit");
    await seedShare(orgId, "file", loose, other.userId, "edit");

    const mine = liftRows(await locks(member));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      resource_id: note,
      principal_type: "user",
      principal_id: member.userId,
    });
    // The other member's grant is absent: a badge endpoint must not let anyone
    // enumerate who else was lifted out of the vault's Read-only posture.
    expect(mine.map((r) => r.resource_id)).not.toContain(loose);

    const theirs = liftRows(await locks(other));
    expect(theirs.map((r) => r.resource_id)).toEqual([loose]);
  });

  it("reports the caller's own deeper edit row in a Shared vault, where it lifts their own ancestor Can view", async () => {
    // Members & Access: Can view on a parent folder, Can edit on one of its
    // subfolders. The resolver gives edit inside the subfolder (deepest
    // per-user row wins); the overlay must carry that lift or the client
    // inherits the parent's padlock and opens the subfolder read-only.
    await legacyPosture(orgId, "edit");
    const sub = await seedFolder(vault, folder, "Sub", "Docs/Sub");
    const subNote = await seedNote(vault, sub, "Docs/Sub/S.md", owner.userId);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'user', $4, 'readonly')`,
      [randomUUID(), orgId, folder, member.userId],
    );
    await seedShare(orgId, "folder", sub, member.userId, "edit");
    // An org edit row is still not a lift without a posture to lift.
    await seedOrgGrant(orgId, "file", loose, "edit");

    expect(await effectivePermission(member.userId, subNote)).toBe("edit");
    expect(await effectivePermission(member.userId, note)).toBe("view");

    const rows = await locks(member);
    expect(vaultRows(rows)).toHaveLength(0);
    expect(rows).toContainEqual(
      expect.objectContaining({ resource_type: "folder", resource_id: folder, principal_id: member.userId, permission: "readonly" }),
    );
    const lifts = liftRows(rows);
    expect(lifts).toHaveLength(1);
    expect(lifts[0]).toMatchObject({
      resource_type: "folder",
      resource_id: sub,
      principal_type: "user",
      principal_id: member.userId,
    });
    // Never another member's grant.
    expect(liftRows(await locks(other))).toHaveLength(0);
  });

  it("never reports another member's per-user Can view / No access rows", async () => {
    const insert = (resourceId: string, userId: string, permission: string) =>
      pool.query(
        `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ($1, $2, 'folder', $3, 'user', $4, $5)`,
        [randomUUID(), orgId, resourceId, userId, permission],
      );
    const sub = await seedFolder(vault, folder, "Sub", "Docs/Sub");
    await insert(folder, other.userId, "readonly");
    await insert(sub, other.userId, "denied");
    await insert(folder, member.userId, "readonly");
    await seedLock(orgId, "file", note, { type: "user", id: other.userId });
    await seedLock(orgId, "folder", folder, { type: "org" });

    // A plain member sees the Everyone lock and their own row, nothing of the other member's.
    const mine = await locks(member);
    expect(mine.some((r) => r.principal_type === "user" && r.principal_id !== member.userId)).toBe(false);
    expect(mine).toContainEqual(expect.objectContaining({ resource_id: folder, principal_id: member.userId }));
    expect(mine).toContainEqual(expect.objectContaining({ resource_id: folder, principal_type: "org", permission: "locked" }));

    // The other member sees their own three rows.
    const theirs = (await locks(other)).filter((r) => r.principal_type === "user");
    expect(theirs.every((r) => r.principal_id === other.userId)).toBe(true);
    expect(theirs).toHaveLength(3);

    // An owner sees another member's legacy `locked` row (for Unlock), but not
    // their Can view or No access rows.
    const owners = (await locks(owner)).filter(
      (r) => r.principal_type === "user" && r.principal_id !== owner.userId,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ resource_id: note, principal_id: other.userId, permission: "locked" });
  });

  it("does not report a view grant or the vault grant itself as a lift", async () => {
    await legacyPosture(orgId, "view");
    await seedOrgGrant(orgId, "file", note, "view");

    // The stored vault row IS `edit`-shaped machinery, but it is the posture,
    // not an item exception, and its resource_type keeps it out.
    expect(liftRows(await locks(member))).toHaveLength(0);
  });

  it("a member of ANOTHER org is refused outright", async () => {
    const stranger = await signUp("stranger@vault-lock.test");
    await createOrg(stranger, "Other Co", "other-co-vault-lock");
    await legacyPosture(orgId, "view");

    const res = await get(stranger, `/api/vaults/${vault}/locks`);
    expect(res.status).toBe(403);
  });
});

/** A vault posture from before 2026-11-25 (Can edit / Can view by default),
 *  which the API no longer writes: the conversion moved every vault off it,
 *  but the resolver and the lock overlay still answer for it. */
async function legacyPosture(orgId: string, permission: "edit" | "view"): Promise<{ status: number }> {
  await pool.query(
    // Like the old control, it enforced the mode: every org row goes first.
    "DELETE FROM shares WHERE org_id = $1 AND principal_type = 'org'",
    [orgId],
  );
  await seedVaultGrant(orgId, permission);
  return { status: 200 };
}
