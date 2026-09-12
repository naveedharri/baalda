import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAccessContext,
  resolveAccessForUser,
} from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/** Insert a `locked` share (seedShare only covers user view/edit grants). */
async function seedLock(
  orgId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  principalType: "org" | "user",
  principalId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, $5, $6, 'locked')`,
    [randomUUID(), orgId, resourceType, resourceId, principalType, principalId],
  );
}

describe("resolve-access: buildAccessContext + resolveAccessForUser", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("file resource: a Shared vault gives owner and member edit alike", async () => {
    const org = await seedOrg("Acme", "acme-ra1");
    const owner = await seedUser("owner@a.com");
    await seedMember(org, owner, "owner");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    // Shared, the state POST /api/vaults leaves a new vault in.
    await seedVaultGrant(org, "edit");
    const folder = await seedFolder(vault, null, "F", "F");
    const doc = await seedNote(vault, folder, "F/n.md");

    const ctx = await buildAccessContext("file", doc);
    expect(ctx).not.toBeNull();
    expect(ctx!.docId).toBe(doc);
    expect(ctx!.folderIds).toContain(folder);
    expect((await resolveAccessForUser(ctx!, owner, "owner")).permission).toBe("edit");
    expect((await resolveAccessForUser(ctx!, member, "member")).permission).toBe("edit");
  });

  it("file resource: a Private vault gives the owner no more than the member", async () => {
    // The panel's "who can access" list and the enforcer have to agree, and
    // this is the row people check first: with no org grant the vault is
    // Private, and Private stopped exempting the person who owns it. Neither
    // of these two wrote the note, so neither can reach it.
    const org = await seedOrg("Acme", "acme-ra1b");
    const owner = await seedUser("owner@b.com");
    await seedMember(org, owner, "owner");
    const member = await seedUser("m@b.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "F", "F");
    const doc = await seedNote(vault, folder, "F/n.md");

    const ctx = await buildAccessContext("file", doc);
    expect((await resolveAccessForUser(ctx!, owner, "owner")).permission).toBe("none");
    expect((await resolveAccessForUser(ctx!, member, "member")).permission).toBe("none");

    // Authorship is what a Private vault leaves standing, for both of them.
    const mine = await seedNote(vault, folder, "F/mine.md", owner);
    const mineCtx = await buildAccessContext("file", mine);
    expect((await resolveAccessForUser(mineCtx!, owner, "owner")).permission).toBe("edit");
    expect((await resolveAccessForUser(mineCtx!, member, "member")).permission).toBe("none");
  });

  it("folder resource resolves via folder shares (docId is null)", async () => {
    const org = await seedOrg("Acme", "acme-ra2");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "F", "F");
    await seedShare(org, "folder", folder, member, "view");

    const ctx = await buildAccessContext("folder", folder);
    expect(ctx).not.toBeNull();
    expect(ctx!.docId).toBeNull();
    expect(ctx!.folderIds).toContain(folder);
    expect((await resolveAccessForUser(ctx!, member, "member")).permission).toBe("view");
  });

  it("org lock caps an edit-granted member to view (capped=true)", async () => {
    const org = await seedOrg("Acme", "acme-ra3");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "F", "F");
    const doc = await seedNote(vault, folder, "F/n.md");
    await seedShare(org, "folder", folder, member, "edit");
    await seedLock(org, "folder", folder, "org", org);

    const ctx = await buildAccessContext("file", doc);
    const r = await resolveAccessForUser(ctx!, member, "member");
    expect(r.permission).toBe("view");
    expect(r.capped).toBe(true);
  });

  it("a lock caps the owner too (capped=true)", async () => {
    const org = await seedOrg("Acme", "acme-ra4");
    const owner = await seedUser("o@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit"); // the lock has to have an edit to cap
    const doc = await seedNote(vault, null, "n.md");
    await seedLock(org, "file", doc, "org", org);

    const ctx = await buildAccessContext("file", doc);
    const r = await resolveAccessForUser(ctx!, owner, "owner");
    expect(r.permission).toBe("view");
    expect(r.capped).toBe(true);
  });

  it("a lock never grants: unshared member stays none (capped=false)", async () => {
    const org = await seedOrg("Acme", "acme-ra5");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "n.md");
    await seedLock(org, "file", doc, "org", org);

    const ctx = await buildAccessContext("file", doc);
    const r = await resolveAccessForUser(ctx!, member, "member");
    expect(r.permission).toBe("none");
    expect(r.capped).toBe(false);
  });

  it("unknown resource -> null context", async () => {
    expect(await buildAccessContext("file", "no-such-doc")).toBeNull();
    expect(await buildAccessContext("folder", "no-such-folder")).toBeNull();
  });
});
