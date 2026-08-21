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
describe("per-member deny", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
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
