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

  // ── PUT ────────────────────────────────────────────────────────────────────

  it("PUT open clears every override and opens a previously Private folder", async () => {
    // The member cannot reach the Private folder's note today.
    expect(await effectivePermission(member.userId, privateNote)).toBe("none");
    expect(await effectivePermission(member.userId, rootNote)).toBe("none");

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      cleared: number;
      postureChanged: boolean;
    };
    expect(body.mode).toBe("open");
    // `cleared` counts ITEM settings only — the four overrides. The posture
    // going from Private to Shared is reported on its own.
    expect(body.cleared).toBe(4);
    expect(body.postureChanged).toBe(true);
    // Every cleared row was a restriction, or a grant no wider than the new
    // vault-wide `edit`. Nobody lost access, so nobody is disconnected.
    expect(body.disconnectedDocs).toBe(0);
    expect(rec.disconnected).toEqual([]);
    // Both collections of the org hear about it.
    expect(new Set(rec.aclBroadcasts)).toEqual(new Set([vaultA, vaultB]));

    const after = await readTeamAccess();
    expect(after.mode).toBe("open");
    expect(after.grantId).not.toBeNull();
    expect(after.overrides).toEqual([]);

    expect(await effectivePermission(member.userId, privateNote)).toBe("edit");
    expect(await effectivePermission(member.userId, rootNote)).toBe("edit");
    // Per-user rows are none of this control's business.
    expect(await countUserShares(orgId)).toBe(3);
  });

  it("PUT private removes the team's reach into a previously Shared folder", async () => {
    await seedVaultGrant(orgId, "edit");
    expect(await effectivePermission(member.userId, sharedNote)).toBe("edit");
    expect(await effectivePermission(member.userId, rootNote)).toBe("edit");

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      cleared: number;
      postureChanged: boolean;
    };
    expect(body.mode).toBe("private");
    // Four item settings; the vault row is `postureChanged`, not a fifth item.
    expect(body.cleared).toBe(4);
    expect(body.postureChanged).toBe(true);

    const after = await readTeamAccess();
    expect(after.mode).toBe("private");
    // Private writes a `denied` row rather than deleting the grant: absence
    // means "never shared", which is a weaker thing that leaves authors their
    // own notes. The id is stable across all three modes because the upsert
    // rewrites one row in place.
    expect(after.grantId).not.toBeNull();
    expect(after.overrides).toEqual([]);

    expect(await effectivePermission(member.userId, sharedNote)).toBe("none");
    expect(await effectivePermission(member.userId, rootNote)).toBe("none");
    expect(await countUserShares(orgId)).toBe(3);
  });

  it("PUT readonly caps everyone — including the owner — at view", async () => {
    await seedVaultGrant(orgId, "edit");

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      mode: "readonly",
      cleared: 4,
      postureChanged: true,
    });

    const after = await readTeamAccess();
    expect(after.mode).toBe("readonly");
    expect(after.grantId).not.toBeNull();
    expect(after.overrides).toEqual([]);

    expect(await effectivePermission(member.userId, rootNote)).toBe("view");
    // A folder that used to be org-edit is now just as read-only as the rest.
    expect(await effectivePermission(member.userId, sharedNote)).toBe("view");
    expect(await effectivePermission(owner.userId, rootNote)).toBe("view");
  });

  it("PUT clears an org row stranded on a soft-deleted note, without counting it", async () => {
    // Invisible to the user — GET never listed it, because the note is deleted.
    expect(await orgRowsOn(deletedNote)).toHaveLength(1);
    const listed = (await readTeamAccess()).overrides.map((o) => o.resourceId);
    expect(listed).not.toContain(deletedNote);

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    // Still four: the count reports what GET showed, not what was swept up.
    expect((await res.json()) as unknown).toMatchObject({ cleared: 4 });

    // Gone all the same — a restored note must not come back carrying an
    // override the whole-vault setting was applied to remove.
    expect(await orgRowsOn(deletedNote)).toEqual([]);
  });

  it("PUT is idempotent — re-applying the current mode clears nothing and keeps the grant id", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" })).status).toBe(200);
    const first = await readTeamAccess();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      mode: "open",
      cleared: 0,
      postureChanged: false,
      disconnectedDocs: 0,
    });

    const second = await readTeamAccess();
    expect(second.mode).toBe("open");
    expect(second.grantId).toBe(first.grantId);
  });

  it("PUT readonly kicks only the docs an org edit grant reached", async () => {
    // Private vault, so the posture does not narrow — it widens to Read-only.
    // Of the four overrides only the `edit` folder outranks the new baseline.
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 4,
      postureChanged: true,
      disconnectedDocs: 1,
    });
    expect(rec.disconnected).toEqual([{ vaultId: vaultA, docId: sharedNote }]);
  });

  it("PUT private seals a never-shared vault, which narrows it and kicks everything", async () => {
    // The vault has no posture row, which reads as Private but is the WEAKER
    // state: people still keep the notes they wrote. Pressing Private writes
    // the `denied` row, which takes that away too — so this is a posture change
    // and a narrowing, and every doc goes, not just the two the cleared item
    // grants reached.
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 4,
      postureChanged: true,
    });
    expect(rec.disconnected).toContainEqual({ vaultId: vaultA, docId: sharedNote });
    expect(rec.disconnected).toContainEqual({ vaultId: vaultB, docId: viewNote });
  });

  it("re-applying private on an already sealed vault changes nothing", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );
    rec.reset();
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: false,
      disconnectedDocs: 0,
    });
    expect(rec.disconnected).toEqual([]);
  });

  it("an admin, not just the owner, can read and enforce the posture", async () => {
    expect((await get(admin, `/api/orgs/${orgId}/team-access`)).status).toBe(200);
    const res = await put(admin, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    expect((await readTeamAccess()).mode).toBe("open");
  });

  it("a PUT on one org leaves another org's rows and posture alone", async () => {
    // A second org owned by the same person — the query scoping, not the
    // caller's identity, is what has to keep these apart.
    const otherOrg = (await createOrg(owner, "Other Co", "other-co")).id;
    const otherVault = await seedVault(otherOrg, "Other");
    const otherFolder = await seedFolder(otherVault, null, "Keep", "Keep");
    await seedNote(otherVault, otherFolder, "Keep/K.md", owner.userId);
    const otherGrant = await seedOrgGrant(otherOrg, "folder", otherFolder, "edit");
    const otherPosture = await seedVaultGrant(otherOrg, "view");

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    // Only this org's four item settings were counted or touched.
    expect((await res.json()) as unknown).toMatchObject({ cleared: 4 });

    expect(await orgRowsOn(otherFolder)).toEqual([otherGrant]);
    const otherBody = (await (
      await get(owner, `/api/orgs/${otherOrg}/team-access`)
    ).json()) as TeamAccessBody;
    expect(otherBody.mode).toBe("readonly");
    expect(otherBody.grantId).toBe(otherPosture);
    expect(otherBody.overrides).toHaveLength(1);
  });

  // ── Auth and validation ────────────────────────────────────────────────────

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

  it("a failed INSERT rolls the deletes back", async () => {
    const before = await readTeamAccess();
    expect(before.overrides).toHaveLength(4);

    const realConnect = pool.connect.bind(pool);
    const spy = vi.spyOn(pool, "connect");
    // Two things this mock has to get right:
    //  - `pool.query` calls `connect` in its CALLBACK form, so that form must
    //    pass straight through or every other query in the process hangs.
    //  - the route hands its connection back to the pool, so patch a PROXY and
    //    never the client itself — a pooled client carrying a patched `query`
    //    would poison every test that later drew it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (spy as any).mockImplementation((cb?: unknown) => {
      if (typeof cb === "function") return (realConnect as never as (c: unknown) => unknown)(cb);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return realConnect().then((client: any) =>
        new Proxy(client, {
          get(target, prop) {
            if (prop === "query") {
              return (sql: unknown, params?: unknown) =>
                typeof sql === "string" && sql.includes("INSERT INTO shares")
                  ? Promise.reject(new Error("forced INSERT failure"))
                  : target.query(sql, params);
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
    });

    try {
      const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    const after = await readTeamAccess();
    expect(after.mode).toBe("private");
    expect(after.overrides).toHaveLength(4);
    expect(await countUserShares(orgId)).toBe(3);
    // The silent sweep of the soft-deleted note's row rolled back too.
    expect(await orgRowsOn(deletedNote)).toHaveLength(1);
  });
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
  it("sealing kicks the whole vault, the cleared folder override included", async () => {
    await seedOrgGrant(orgId, "folder", folder, "edit");
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    // The posture itself narrows here (never-shared → sealed), so the per-item
    // walk underneath is pure duplication and one vault-wide query answers it.
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 1,
      postureChanged: true,
    });
    expect(rec.disconnected).toContainEqual({ vaultId: vault, docId: folderNote });
    expect(rec.disconnected).toContainEqual({ vaultId: vault, docId: rootNote });
    expect(rec.aclBroadcasts).toContain(vault);
  });

  it("readonly → open kicks nothing and keeps the same grant id", async () => {
    await seedVaultGrant(orgId, "view");
    const before = (await (
      await get(owner, `/api/orgs/${orgId}/team-access`)
    ).json()) as { grantId: string | null };
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    // Everyone gains edit. A kick here would cost the whole vault a reconnect
    // for a change that takes nothing away.
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: true,
      disconnectedDocs: 0,
    });
    expect(rec.disconnected).toEqual([]);

    const after = (await (
      await get(owner, `/api/orgs/${orgId}/team-access`)
    ).json()) as { mode: string; grantId: string | null };
    expect(after.mode).toBe("open");
    // Rewritten in place by the upsert, not deleted and re-created.
    expect(after.grantId).toBe(before.grantId);
  });

  it("a no-op re-apply broadcasts no ACL change", async () => {
    await seedVaultGrant(orgId, "edit");
    rec.reset();
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" })).status).toBe(200);
    expect(rec.aclBroadcasts).toEqual([]);
  });

  it("re-applying open on an already-open vault with no overrides kicks nothing", async () => {
    await seedVaultGrant(orgId, "edit");
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: false,
      disconnectedDocs: 0,
    });
    expect(rec.disconnected).toEqual([]);
  });

  it("open on a Private vault with no overrides kicks nothing", async () => {
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(res.status).toBe(200);
    // The posture moved, but nothing was taken away, so nobody is kicked.
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: true,
      disconnectedDocs: 0,
    });
    expect(rec.disconnected).toEqual([]);
  });

  it("readonly on an open vault kicks every doc", async () => {
    await seedVaultGrant(orgId, "edit");
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 0,
      postureChanged: true,
      disconnectedDocs: 2,
    });
    expect(rec.disconnected).toContainEqual({ vaultId: vault, docId: folderNote });
    expect(rec.disconnected).toContainEqual({ vaultId: vault, docId: rootNote });
  });

  it("a doc reached by both the vault row and a folder override is kicked once", async () => {
    await seedVaultGrant(orgId, "edit");
    await seedOrgGrant(orgId, "folder", folder, "edit");
    rec.reset();

    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      cleared: 1,
      postureChanged: true,
      disconnectedDocs: 2,
    });
    expect(rec.disconnected).toHaveLength(2);
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

  it("private empties the member's readable set, folders and registry listings", async () => {
    const res = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(res.status).toBe(200);

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
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });

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
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    await seedOrgGrant(orgId, "folder", folder, "edit");

    for (const who of [owner, member]) {
      expect(await listReadableDocsInVault(who.userId, vault)).toEqual(new Set([folderNote]));
      expect(await effectivePermission(who.userId, folderNote)).toBe("edit");
      expect(await effectivePermission(who.userId, rootNote)).toBe("none");
    }
  });

  it("the owner can still put it back, having lost the content", async () => {
    // The safety net is not an exemption — it is that managing access is
    // role-gated (`canManage`) and never asks for effective permission. An
    // owner who locked themselves out of the content can always undo it.
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(await effectivePermission(owner.userId, ownNote)).toBe("none");

    const back = await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(back.status).toBe(200);
    expect(await listReadableDocsInVault(owner.userId, vault)).toEqual(
      new Set([rootNote, folderNote, ownNote]),
    );
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

    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" })).status).toBe(200);

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
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    expect(vaultRows(await locks(member))).toHaveLength(1);

    // An open vault grants; it does not cap.
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(vaultRows(await locks(member))).toHaveLength(0);

    // Private deletes the row entirely.
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" });
    expect(vaultRows(await locks(member))).toHaveLength(0);
  });

  it("a per-item lock still appears alongside the vault row", async () => {
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    await seedLock(orgId, "folder", folder, { type: "org" });

    const rows = await locks(member);
    expect(vaultRows(rows)).toHaveLength(1);
    expect(rows.filter((r) => r.resource_type === "folder" && r.resource_id === folder)).toHaveLength(1);
  });

  it("the owner sees the posture row too — it caps them as well", async () => {
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    expect(vaultRows(await locks(owner))).toHaveLength(1);
  });

  it("the posture row carries a NON-routable id, never the live grant row's", async () => {
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
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
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "open" });
    expect(liftRows(await locks(member))).toHaveLength(0);

    // Read-only clears the item overrides, so re-apply one after the PUT — which
    // is exactly the two-click path an admin takes in the Access panel.
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
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
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
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

  it("does not report a view grant or the vault grant itself as a lift", async () => {
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });
    await seedOrgGrant(orgId, "file", note, "view");

    // The stored vault row IS `edit`-shaped machinery, but it is the posture,
    // not an item exception, and its resource_type keeps it out.
    expect(liftRows(await locks(member))).toHaveLength(0);
  });

  it("a member of ANOTHER org is refused outright", async () => {
    const stranger = await signUp("stranger@vault-lock.test");
    await createOrg(stranger, "Other Co", "other-co-vault-lock");
    await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "readonly" });

    const res = await get(stranger, `/api/vaults/${vault}/locks`);
    expect(res.status).toBe(403);
  });
});
