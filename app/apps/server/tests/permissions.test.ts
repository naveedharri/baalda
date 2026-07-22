import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effectivePermission } from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
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

describe("effective-permission resolver matrix (spec 04 §3)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("vault owner -> edit on everything", async () => {
    const org = await seedOrg("Acme", "acme-owner");
    const owner = await seedUser("owner@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("vault admin -> edit on everything", async () => {
    const org = await seedOrg("Acme", "acme-admin");
    const admin = await seedUser("admin@a.com");
    await seedMember(org, admin, "admin");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(admin, doc)).toBe("edit");
  });

  it("plain member with no share -> none", async () => {
    const org = await seedOrg("Acme", "acme-none");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("member with a folder view-share -> view (inherited by the note)", async () => {
    const org = await seedOrg("Acme", "acme-fview");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const doc = await seedNote(vault, folder, "Shared/note.md");
    await seedShare(org, "folder", folder, member, "view");
    expect(await effectivePermission(member, doc)).toBe("view");
  });

  it("file-level edit share raises above a folder view share", async () => {
    const org = await seedOrg("Acme", "acme-override");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const doc = await seedNote(vault, folder, "Shared/note.md");
    await seedShare(org, "folder", folder, member, "view");
    await seedShare(org, "file", doc, member, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("folder grant inherits to a descendant at depth >= 2", async () => {
    const org = await seedOrg("Acme", "acme-depth");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Top", "Top");
    const mid = await seedFolder(vault, top, "Mid", "Top/Mid");
    const leaf = await seedFolder(vault, mid, "Leaf", "Top/Mid/Leaf");
    const doc = await seedNote(vault, leaf, "Top/Mid/Leaf/deep.md");
    // share the TOP folder; the doc is three levels down
    await seedShare(org, "folder", top, member, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("a non-member with no share -> none", async () => {
    const org = await seedOrg("Acme", "acme-outsider");
    const outsider = await seedUser("out@a.com");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(outsider, doc)).toBe("none");
  });

  it("view share does not exceed view; highest-wins picks edit when both present on different folders", async () => {
    const org = await seedOrg("Acme", "acme-highest");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Top", "Top");
    const sub = await seedFolder(vault, top, "Sub", "Top/Sub");
    const doc = await seedNote(vault, sub, "Top/Sub/note.md");
    await seedShare(org, "folder", top, member, "edit"); // ancestor edit
    await seedShare(org, "folder", sub, member, "view"); // nearer view
    // highest-wins -> edit
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("unknown doc -> none", async () => {
    expect(await effectivePermission("nobody", "no-such-doc")).toBe("none");
  });

  it("Open vault: member gets edit on a ROOT note (folder_id NULL, no folder to share)", async () => {
    const org = await seedOrg("Acme", "acme-open-root");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md"); // vault root, no folder
    await seedVaultGrant(org, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("Read-only vault: member gets view via the org-wide grant", async () => {
    const org = await seedOrg("Acme", "acme-readonly");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    await seedVaultGrant(org, "view");
    expect(await effectivePermission(member, doc)).toBe("view");
  });

  it("a vault grant does not leak to non-members", async () => {
    const org = await seedOrg("Acme", "acme-open-outsider");
    const outsider = await seedUser("out@a.com");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    await seedVaultGrant(org, "edit");
    expect(await effectivePermission(outsider, doc)).toBe("none");
  });

  // ── private-by-default (opt-in team sharing) ──────────────────────────────

  it("private-by-default: creator gets edit on their own note; another member gets none", async () => {
    const org = await seedOrg("Acme", "acme-creator");
    const author = await seedUser("author@a.com");
    const other = await seedUser("other@a.com");
    await seedMember(org, author, "member");
    await seedMember(org, other, "member");
    const vault = await seedVault(org); // no vault grant → private
    const doc = await seedNote(vault, null, "mine.md", author);
    expect(await effectivePermission(author, doc)).toBe("edit"); // creator
    expect(await effectivePermission(other, doc)).toBe("none"); // not shared
  });

  it("Share with team: an org grant on a folder gives every member access", async () => {
    const org = await seedOrg("Acme", "acme-team-folder");
    const author = await seedUser("author@a.com");
    const other = await seedUser("other@a.com");
    await seedMember(org, author, "member");
    await seedMember(org, other, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Team", "Team");
    const doc = await seedNote(vault, folder, "Team/shared.md", author);
    // "Share with team" = an org-principal edit grant on the folder.
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'edit')`,
      [org, folder],
    );
    expect(await effectivePermission(other, doc)).toBe("edit"); // now visible to team
    // …but still not to a non-member who merely knows the id.
    const outsider = await seedUser("out@a.com");
    expect(await effectivePermission(outsider, doc)).toBe("none");
  });

  it("a lock still caps an Open-vault member at view", async () => {
    const org = await seedOrg("Acme", "acme-open-locked");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Specs", "Specs");
    const doc = await seedNote(vault, folder, "Specs/frozen.md");
    await seedVaultGrant(org, "edit");
    await seedLock(org, "folder", folder, { type: "org" });
    expect(await effectivePermission(member, doc)).toBe("view");
  });
});
