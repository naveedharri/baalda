import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAccessContext,
  effectivePermission,
  resolveAccessForUser,
} from "../src/permissions/resolver.js";
import { canEditFolder } from "../src/permissions/http-gates.js";
import {
  listReadableDocsInVault,
  listVisibleFolders,
} from "../src/permissions/vault-docs.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  seedDeny,
  seedFolder,
  seedItemPrivate,
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
 * The per-member DENY (`shares.permission = 'denied'`) — the Access panel's
 * "No access (blocked)".
 *
 * Every test here is really the same assertion from a different angle: a deny
 * has to beat the rule that would otherwise grant. Locks only cap edit→view, so
 * before this there was no way to keep one person out of a folder in a vault
 * everyone else could read, and each of the allow paths below (role, org grant,
 * explicit share, authorship) had to be closed separately.
 */
// File-level, not per-describe: a describe-scoped `afterAll` closes the pool
// the moment the FIRST block finishes, and every later block then fails on a
// dead pool.
afterAll(async () => {
  await pool.end();
});

describe("per-member deny", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("beats the vault-wide Open grant", async () => {
    const org = await seedOrg("Acme", "deny-open");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    const doc = await seedNote(vault, folder, "HR/salaries.md");

    expect(await effectivePermission(member, doc)).toBe("edit");
    await seedDeny(org, "folder", folder, member);
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("beats an explicit per-user edit share on the note itself", async () => {
    const org = await seedOrg("Acme", "deny-share");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    const doc = await seedNote(vault, folder, "HR/note.md");
    await seedShare(org, "file", doc, member, "edit");

    expect(await effectivePermission(member, doc)).toBe("edit");
    await seedDeny(org, "folder", folder, member);
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("beats owner and admin — a lock only caps them at view, a deny removes them", async () => {
    const org = await seedOrg("Acme", "deny-admin");
    const owner = await seedUser("o@a.com");
    const admin = await seedUser("a@a.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Private", "Private");
    const doc = await seedNote(vault, folder, "Private/note.md");

    await seedLock(org, "folder", folder, { type: "user", id: admin });
    expect(await effectivePermission(admin, doc)).toBe("view");

    await seedDeny(org, "folder", folder, admin);
    expect(await effectivePermission(admin, doc)).toBe("none");
    // …and only for that admin.
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("beats the note-creator escape hatch", async () => {
    // The sharpest case: "make this private from Sam" has to mean it on the
    // notes Sam wrote, or the feature is a no-op exactly where it matters.
    const org = await seedOrg("Acme", "deny-creator");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Drafts", "Drafts");
    const doc = await seedNote(vault, folder, "Drafts/mine.md", member);

    expect(await effectivePermission(member, doc)).toBe("edit");
    await seedDeny(org, "folder", folder, member);
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("inherits down a folder subtree", async () => {
    const org = await seedOrg("Acme", "deny-subtree");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Ops", "Ops");
    const nested = await seedFolder(vault, top, "Payroll", "Ops/Payroll");
    const deep = await seedNote(vault, nested, "Ops/Payroll/2026.md");

    await seedDeny(org, "folder", top, member);
    expect(await effectivePermission(member, deep)).toBe("none");
  });

  it("applies to a single file without touching its siblings", async () => {
    const org = await seedOrg("Acme", "deny-file");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Team", "Team");
    const hidden = await seedNote(vault, folder, "Team/hidden.md");
    const sibling = await seedNote(vault, folder, "Team/open.md");

    await seedDeny(org, "file", hidden, member);
    expect(await effectivePermission(member, hidden)).toBe("none");
    expect(await effectivePermission(member, sibling)).toBe("edit");
  });

  it("removes the doc from the readable set and the folder from the tree", async () => {
    // The resolver and the set-based dual must agree, or a denied member keeps
    // syncing a doc they can no longer resolve.
    const org = await seedOrg("Acme", "deny-sets");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const secret = await seedFolder(vault, null, "Secret", "Secret");
    const nested = await seedFolder(vault, secret, "Deeper", "Secret/Deeper");
    const open = await seedFolder(vault, null, "Open", "Open");
    const hiddenDoc = await seedNote(vault, nested, "Secret/Deeper/x.md");
    const openDoc = await seedNote(vault, open, "Open/y.md");

    await seedDeny(org, "folder", secret, member);

    const readable = await listReadableDocsInVault(member, vault);
    expect(readable.has(hiddenDoc)).toBe(false);
    expect(readable.has(openDoc)).toBe(true);

    const folders = await listVisibleFolders(member, vault);
    const paths = folders.map((f) => f.path);
    expect(paths).toContain("Open");
    expect(paths).not.toContain("Secret");
    expect(paths).not.toContain("Secret/Deeper");
  });

  it("hides a denied folder from an ADMIN's tree too", async () => {
    const org = await seedOrg("Acme", "deny-admin-tree");
    const admin = await seedUser("a@a.com");
    await seedMember(org, admin, "admin");
    const vault = await seedVault(org);
    const secret = await seedFolder(vault, null, "Secret", "Secret");
    const doc = await seedNote(vault, secret, "Secret/x.md");

    await seedDeny(org, "folder", secret, admin);
    expect((await listVisibleFolders(admin, vault)).map((f) => f.path)).not.toContain("Secret");
    expect((await listReadableDocsInVault(admin, vault)).has(doc)).toBe(false);
    expect(await canEditFolder(admin, secret)).toBe(false);
  });

  it("resolve-access reports the block as `denied`, not as a missing grant", async () => {
    const org = await seedOrg("Acme", "deny-resolve");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    await seedDeny(org, "folder", folder, member);

    const ctx = await buildAccessContext("folder", folder);
    expect(ctx).not.toBeNull();
    const resolved = await resolveAccessForUser(ctx!, member, "member");
    expect(resolved.permission).toBe("none");
    expect(resolved.denied).toBe(true);
  });

  it("does not leak to other members", async () => {
    const org = await seedOrg("Acme", "deny-scope");
    const blocked = await seedUser("b@a.com");
    const other = await seedUser("o2@a.com");
    await seedMember(org, blocked, "member");
    await seedMember(org, other, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    const doc = await seedNote(vault, folder, "HR/n.md");

    await seedDeny(org, "folder", folder, blocked);
    expect(await effectivePermission(blocked, doc)).toBe("none");
    expect(await effectivePermission(other, doc)).toBe("edit");
  });
});

/**
 * An ORG-scoped deny — the Access panel's per-item **Private**.
 *
 * This is the row that makes item-Private possible at all. Before it, "Private"
 * on a folder just cleared that folder's own grants, and in a Shared vault the
 * vault-wide grant still reached it — so the segment snapped straight back to
 * Shared and nothing had changed. It removes the TEAM's reach and nothing else:
 * the creator, anyone with a personal share, and owners/admins keep the item,
 * which is exactly "only you and people you share it with" — and is what stops
 * an owner making a folder that nobody, themselves included, can ever reach.
 */
describe("item set to Private (org deny)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("overrides the vault-wide Open grant for a plain member", async () => {
    const org = await seedOrg("Acme", "priv-open");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    const doc = await seedNote(vault, folder, "HR/n.md");
    const elsewhere = await seedNote(vault, null, "open.md");

    expect(await effectivePermission(member, doc)).toBe("edit");
    await seedItemPrivate(org, "folder", folder);
    expect(await effectivePermission(member, doc)).toBe("none");
    // …and only that folder.
    expect(await effectivePermission(member, elsewhere)).toBe("edit");
  });

  it("overrides a team share on an ANCESTOR folder", async () => {
    const org = await seedOrg("Acme", "priv-ancestor");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Team", "Team");
    const inner = await seedFolder(vault, top, "Salaries", "Team/Salaries");
    const doc = await seedNote(vault, inner, "Team/Salaries/2026.md");
    // The parent is shared with the team…
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'edit')`,
      [org, top],
    );
    expect(await effectivePermission(member, doc)).toBe("edit");

    await seedItemPrivate(org, "folder", inner);
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("leaves explicit grantees alone — and nobody else, the author and owners included", async () => {
    const org = await seedOrg("Acme", "priv-keeps");
    const owner = await seedUser("o@a.com");
    const admin = await seedUser("a@a.com");
    const author = await seedUser("w@a.com");
    const invited = await seedUser("i@a.com");
    const outsider = await seedUser("x@a.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, author, "member");
    await seedMember(org, invited, "member");
    await seedMember(org, outsider, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Drafts", "Drafts");
    const doc = await seedNote(vault, folder, "Drafts/d.md", author);
    await seedShare(org, "file", doc, invited, "view");

    await seedItemPrivate(org, "folder", folder);

    expect(await effectivePermission(invited, doc)).toBe("view"); // named in the list
    expect(await effectivePermission(outsider, doc)).toBe("none");
    // Neither role nor authorship is an exemption. A restriction its author
    // can't observe is one they have to take on trust, and in a vault you set
    // up yourself you wrote nearly everything — so sparing the author would
    // make Private unobservable exactly where it's used.
    expect(await effectivePermission(owner, doc)).toBe("none");
    expect(await effectivePermission(admin, doc)).toBe("none");
    expect(await effectivePermission(author, doc)).toBe("none");
  });

  it("reports the same answer in the panel as the enforcer gives", async () => {
    // `resolveAccessForUser` renders "who can access"; `effectivePermission`
    // decides the sync token. They disagreed once — the panel said No access on
    // a member's own note while the enforcer handed out edit — which is worse
    // than either answer alone, because it makes the panel untrustworthy.
    const org = await seedOrg("Acme", "priv-agree");
    const author = await seedUser("w@a.com");
    await seedMember(org, author, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "mine.md", author);

    const check = async (expected: string) => {
      const ctx = await buildAccessContext("file", doc);
      const resolved = await resolveAccessForUser(ctx!, author, "member");
      expect(resolved.permission).toBe(expected);
      expect(await effectivePermission(author, doc)).toBe(expected);
    };
    await check("edit"); // their own note, private-by-default vault
    await seedItemPrivate(org, "file", doc);
    await check("none"); // …and Private takes it from them too
  });

  it("still lets an owner lift a Private they applied to themselves", async () => {
    // The safety net is NOT an exemption from the rule — it's that managing
    // shares is gated on role, never on effective permission. Without this an
    // owner could make a folder they can neither reach nor un-restrict.
    const org = await seedOrg("Acme", "priv-undo");
    const owner = await seedUser("o@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Locked", "Locked");
    const doc = await seedNote(vault, folder, "Locked/x.md");
    await seedVaultGrant(org, "edit");
    const privateRow = await seedItemPrivate(org, "folder", folder);
    expect(await effectivePermission(owner, doc)).toBe("none");

    // …which is exactly what `DELETE /api/shares/:id` does, and its gate
    // (`canManage`) asks for the role, not for access to the resource.
    await pool.query("DELETE FROM shares WHERE id = $1", [privateRow]);
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("takes the docs and the folder out of everyone's tree, the owner's included", async () => {
    // The set-based dual has to agree with the resolver here or the two would
    // disagree about the owner, and a doc that resolves to `none` would keep
    // syncing to them.
    const org = await seedOrg("Acme", "priv-sets");
    const owner = await seedUser("o@a.com");
    const member = await seedUser("m@a.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const secret = await seedFolder(vault, null, "Secret", "Secret");
    const nested = await seedFolder(vault, secret, "Deep", "Secret/Deep");
    const hidden = await seedNote(vault, nested, "Secret/Deep/x.md");
    const open = await seedNote(vault, null, "open.md");

    await seedItemPrivate(org, "folder", secret);

    for (const who of [member, owner]) {
      const docs = await listReadableDocsInVault(who, vault);
      expect(docs.has(hidden)).toBe(false);
      expect(docs.has(open)).toBe(true);
      expect((await listVisibleFolders(who, vault)).map((f) => f.path)).not.toContain("Secret");
    }
  });

  it("takes a member's OWN notes too, and gives them back on an explicit share", async () => {
    // The set-based dual has to drop authorship exactly where the resolver
    // does, or a Private folder would keep syncing its author's own notes.
    const org = await seedOrg("Acme", "priv-mine");
    const author = await seedUser("w@a.com");
    await seedMember(org, author, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const mine = await seedNote(vault, folder, "Shared/mine.md", author);
    const theirs = await seedNote(vault, folder, "Shared/theirs.md");

    await seedItemPrivate(org, "folder", folder);

    let docs = await listReadableDocsInVault(author, vault);
    expect(docs.has(mine)).toBe(false);
    expect(docs.has(theirs)).toBe(false);

    // Naming yourself in the list is the way back in — the same row a teammate
    // would get.
    await seedShare(org, "folder", folder, author, "edit");
    docs = await listReadableDocsInVault(author, vault);
    expect(docs.has(mine)).toBe(true);
    expect(docs.has(theirs)).toBe(true);
  });

  it("is overridden for one person by an explicit share, and a personal block wins back", async () => {
    // The three rows layered on one resource, in the order that decides them.
    const org = await seedOrg("Acme", "priv-stack");
    const admin = await seedUser("a@a.com");
    await seedMember(org, admin, "admin");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "HR", "HR");
    const doc = await seedNote(vault, folder, "HR/n.md");

    expect(await effectivePermission(admin, doc)).toBe("edit");
    await seedItemPrivate(org, "folder", folder);
    expect(await effectivePermission(admin, doc)).toBe("none"); // Private reaches admins
    await seedShare(org, "folder", folder, admin, "edit"); // "…people you share it with"
    expect(await effectivePermission(admin, doc)).toBe("edit");
    await seedDeny(org, "folder", folder, admin); // a personal block still wins
    expect(await effectivePermission(admin, doc)).toBe("none");
  });
});

/**
 * The vault-wide **Read-only** posture.
 *
 * It is a plain org `view` grant on the vault resource, and a grant only ever
 * RAISES permission — so owners, admins and note creators all kept `edit`
 * through shortcuts that ran before any grant was consulted, and the setting
 * silently did not apply to the person who chose it, despite the button reading
 * "Everyone can read everything, not edit."
 *
 * It can't be fixed with a lock: a vault-scoped lock would need the same
 * (resource, principal) key the grant already occupies. So the grant is now
 * read as a *baseline for everyone* — when it says `view`, those shortcuts are
 * skipped and the ordinary highest-wins lookup decides, which still lets a
 * folder marked Shared lift someone back out.
 */
describe("vault-wide read-only cap", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** Set the vault posture, replacing whatever grant is there (one row per
   *  (resource, principal) — the same upsert `POST /api/shares` does). */
  const setVaultPosture = (orgId: string, permission: "view" | "edit") =>
    pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'vault', $1, 'org', $1, $2)
       ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
       DO UPDATE SET permission = EXCLUDED.permission`,
      [orgId, permission],
    );

  it("caps owner, admin and member alike", async () => {
    const org = await seedOrg("Acme", "ro-vault");
    const owner = await seedUser("o@a.com");
    const admin = await seedUser("a@a.com");
    const member = await seedUser("m@a.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    await seedVaultGrant(org, "edit");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Docs", "Docs");
    const doc = await seedNote(vault, folder, "Docs/n.md");

    for (const who of [owner, admin, member]) {
      expect(await effectivePermission(who, doc)).toBe("edit");
    }

    await setVaultPosture(org, "view");
    for (const who of [owner, admin, member]) {
      expect(await effectivePermission(who, doc)).toBe("view");
    }
    // It never GRANTS: an outsider is still shut out entirely.
    const outsider = await seedUser("x@a.com");
    expect(await effectivePermission(outsider, doc)).toBe("none");

    // …and a folder marked Shared lifts everyone back out of it, which is the
    // per-item override the panel offers.
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'edit')`,
      [org, folder],
    );
    for (const who of [owner, admin, member]) {
      expect(await effectivePermission(who, doc)).toBe("edit");
    }
  });

  it("caps a member on a note they created themselves", async () => {
    // The creator shortcut is a shortcut like any other: read-only has to mean
    // read-only, or "everyone" quietly excludes whoever wrote the note.
    const org = await seedOrg("Acme", "ro-creator");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const mine = await seedNote(vault, null, "mine.md", member);

    expect(await effectivePermission(member, mine)).toBe("edit");
    await setVaultPosture(org, "view");
    expect(await effectivePermission(member, mine)).toBe("view");
  });

  it("reaches a note at the vault ROOT, which no folder grant can", async () => {
    // The whole reason the vault scope exists: a root note has no folder to
    // hang a lock on.
    const org = await seedOrg("Acme", "ro-root");
    const owner = await seedUser("o@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");

    expect(await effectivePermission(owner, doc)).toBe("edit");
    await setVaultPosture(org, "view");
    expect(await effectivePermission(owner, doc)).toBe("view");
  });

  it("still lets an owner edit content in ANOTHER vault", async () => {
    const orgA = await seedOrg("A", "ro-a");
    const orgB = await seedOrg("B", "ro-b");
    const owner = await seedUser("o@a.com");
    await seedMember(orgA, owner, "owner");
    await seedMember(orgB, owner, "owner");
    const vaultB = await seedVault(orgB);
    const doc = await seedNote(vaultB, null, "b.md");

    await setVaultPosture(orgA, "view");
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });
});
