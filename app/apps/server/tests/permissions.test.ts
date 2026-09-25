import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault, listVisibleFolders } from "../src/permissions/vault-docs.js";
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
  sealVault,
} from "./helpers/seed.js";

describe("effective-permission resolver matrix (spec 04 §3)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("vault owner -> edit on everything, in a SHARED vault", async () => {
    const org = await seedOrg("Acme", "acme-owner");
    const owner = await seedUser("owner@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit"); // what POST /api/vaults creates
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("vault admin -> edit on everything, in a SHARED vault", async () => {
    const org = await seedOrg("Acme", "acme-admin");
    const admin = await seedUser("admin@a.com");
    await seedMember(org, admin, "admin");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(admin, doc)).toBe("edit");
  });

  it("a NEVER-SHARED vault gives an owner and an admin no more than a member", async () => {
    // No posture row at all (a vault created while private-by-default was the
    // rule): the role shortcut is withdrawn and people keep what they wrote.
    // This note has no author, so nobody reaches it. A vault SET to Private is
    // a different row — see the sealed tests below.
    const org = await seedOrg("Acme", "acme-private-posture");
    const owner = await seedUser("owner@p.com");
    const admin = await seedUser("admin@p.com");
    const member = await seedUser("member@p.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    const vault = await seedVault(org); // no grant == Private
    const doc = await seedNote(vault, null, "root.md");

    for (const u of [owner, admin, member]) {
      expect(await effectivePermission(u, doc)).toBe("none");
    }
  });

  it("a SEALED vault (the Private button) keeps owners and admins, and leaves a member only grants", async () => {
    // The difference between this and the test below is the whole design. No
    // row at all means "never shared" — the private-by-default space, where
    // what you wrote is yours. An org `denied` row on the vault means someone
    // pressed Private, which withdraws the TEAM: owners and admins keep every
    // note, a member keeps nothing they were not given — not even what they
    // wrote (#217).
    const org = await seedOrg("Acme", "acme-sealed");
    const owner = await seedUser("owner@s.com");
    const admin = await seedUser("admin@s.com");
    const member = await seedUser("member@s.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const mine = await seedNote(vault, null, "mine.md", owner);
    const theirs = await seedNote(vault, null, "theirs.md", member);
    await sealVault(org);

    for (const doc of [mine, theirs]) {
      expect(await effectivePermission(owner, doc)).toBe("edit");
      expect(await effectivePermission(admin, doc)).toBe("edit");
      expect(await effectivePermission(member, doc)).toBe("none");
    }

    // A grant still lifts a member out of it — sealed is a floor, not a wall.
    await seedShare(org, "file", theirs, member, "edit");
    expect(await effectivePermission(member, theirs)).toBe("edit");
    expect(await effectivePermission(member, mine)).toBe("none");
  });

  it("owner seals a vault they authored: still reads every note; a member sees nothing, or only a shared folder", async () => {
    const org = await seedOrg("Acme", "acme-sealed-author");
    const owner = await seedUser("owner@sa.com");
    const member = await seedUser("member@sa.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const shared = await seedFolder(vault, null, "Shared", "Shared", owner);
    const other = await seedFolder(vault, null, "Other", "Other", owner);
    const rootNote = await seedNote(vault, null, "root.md", owner);
    const sharedNote = await seedNote(vault, shared, "Shared/a.md", owner);
    const otherNote = await seedNote(vault, other, "Other/b.md", owner);
    const legacy = await seedNote(vault, other, "Other/legacy.md", null);
    await sealVault(org);

    for (const doc of [rootNote, sharedNote, otherNote, legacy]) {
      expect(await effectivePermission(owner, doc)).toBe("edit");
      expect(await effectivePermission(member, doc)).toBe("none");
    }
    expect(await listReadableDocsInVault(owner, vault)).toEqual(
      new Set([rootNote, sharedNote, otherNote, legacy]),
    );
    expect(await listReadableDocsInVault(member, vault)).toEqual(new Set());

    // The team is given one folder: the member reads exactly that folder.
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'view')`,
      [org, shared],
    );
    expect(await effectivePermission(member, sharedNote)).toBe("view");
    expect(await effectivePermission(member, otherNote)).toBe("none");
    expect(await listReadableDocsInVault(member, vault)).toEqual(new Set([sharedNote]));
    expect((await listVisibleFolders(member, vault)).map((f) => f.id)).toEqual([shared]);
    expect((await listVisibleFolders(owner, vault)).map((f) => f.id).sort()).toEqual(
      [shared, other].sort(),
    );
    expect(await listReadableDocsInVault(owner, vault)).toEqual(
      new Set([rootNote, sharedNote, otherNote, legacy]),
    );
  });

  it("a Read-only vault still caps the owner at view, unlike Private", async () => {
    const org = await seedOrg("Acme", "acme-ro-owner");
    const owner = await seedUser("owner@ro.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const mine = await seedNote(vault, null, "mine.md", owner);
    await seedVaultGrant(org, "view");
    expect(await effectivePermission(owner, mine)).toBe("view");
  });

  it("a never-shared vault still leaves everyone what they wrote", async () => {
    const org = await seedOrg("Acme", "acme-private-author");
    const owner = await seedUser("owner@pa.com");
    const member = await seedUser("member@pa.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const mine = await seedNote(vault, null, "mine.md", owner);
    const theirs = await seedNote(vault, null, "theirs.md", member);

    expect(await effectivePermission(owner, mine)).toBe("edit");
    expect(await effectivePermission(owner, theirs)).toBe("none");
    expect(await effectivePermission(member, theirs)).toBe("edit");
    expect(await effectivePermission(member, mine)).toBe("none");
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
