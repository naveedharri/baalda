import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { effectivePermission } from "../src/permissions/resolver.js";
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
} from "./helpers/seed.js";

// The vault channel derives a subscriber's readable-doc set from
// listReadableDocsInVault (spec 05 §3.1). It MUST agree, per doc, with the
// canonical effectivePermission resolver — a doc is in the set iff the resolver
// says the user has some (non-none) access. This cross-check is the guardrail
// against the set-based query drifting from the resolver.

async function seedLock(
  workspaceId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  principalId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, workspace_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, 'locked')`,
    [randomUUID(), workspaceId, resourceType, resourceId, principalId],
  );
}

async function assertAgrees(userId: string, vaultId: string, docIds: string[]): Promise<void> {
  const set = await listReadableDocsInVault(userId, vaultId);
  for (const docId of docIds) {
    const eff = await effectivePermission(userId, docId);
    expect(set.has(docId), `docId=${docId} eff=${eff}`).toBe(eff !== "none");
  }
}

describe("listReadableDocsInVault agrees with effectivePermission (spec 05 §3.1)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("matches the resolver across owner / folder-share / file-share / none / lock", async () => {
    const org = await seedOrg("Acme", "acme-vd");
    const owner = await seedUser("owner@a.com");
    const alice = await seedUser("alice@a.com");
    const bob = await seedUser("bob@a.com");
    const carol = await seedUser("carol@a.com");
    const dave = await seedUser("dave@a.com");
    for (const [u, r] of [
      [owner, "owner"],
      [alice, "member"],
      [bob, "member"],
      [carol, "member"],
      [dave, "member"],
    ] as const) {
      await seedMember(org, u, r);
    }

    const vault = await seedVault(org);
    const shared = await seedFolder(vault, null, "Shared", "Shared");
    const deep = await seedFolder(vault, shared, "Deep", "Shared/Deep");
    const priv = await seedFolder(vault, null, "Private", "Private");

    const rootNote = await seedNote(vault, null, "root.md");
    const s1 = await seedNote(vault, shared, "Shared/s1.md");
    const d1 = await seedNote(vault, deep, "Shared/Deep/d1.md");
    const p1 = await seedNote(vault, priv, "Private/p1.md");
    const all = [rootNote, s1, d1, p1];

    await seedShare(org, "folder", shared, alice, "view"); // alice: Shared subtree
    await seedShare(org, "file", p1, bob, "edit"); // bob: just p1
    await seedLock(org, "folder", shared, dave); // dave: lock only → no read

    // Agreement with the resolver, per user, across every doc.
    for (const u of [owner, alice, bob, carol, dave]) {
      await assertAgrees(u, vault, all);
    }

    // And the concrete expected sets, so a resolver bug can't make both wrong.
    expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set(all));
    expect(await listReadableDocsInVault(alice, vault)).toEqual(new Set([s1, d1]));
    expect(await listReadableDocsInVault(bob, vault)).toEqual(new Set([p1]));
    expect(await listReadableDocsInVault(carol, vault)).toEqual(new Set());
    expect(await listReadableDocsInVault(dave, vault)).toEqual(new Set());
  });

  it("excludes soft-deleted notes and returns empty for a non-member", async () => {
    const org = await seedOrg("Beta", "beta-vd");
    const owner = await seedUser("o2@b.com");
    await seedMember(org, owner, "owner");
    const outsider = await seedUser("out@x.com"); // not a member
    const vault = await seedVault(org);
    const live = await seedNote(vault, null, "live.md");
    const gone = await seedNote(vault, null, "gone.md");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);

    expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set([live]));
    expect(await listReadableDocsInVault(outsider, vault)).toEqual(new Set());
  });
});
