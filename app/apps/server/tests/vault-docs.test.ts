import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
} from "../src/permissions/vault-docs.js";
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

async function seedVaultShare(
  orgId: string,
  principalType: "org" | "user",
  principalId: string,
  permission: "view" | "edit",
): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, $3, $4, $5)`,
    [randomUUID(), orgId, principalType, principalId, permission],
  );
}

async function seedLock(
  orgId: string,
  resourceType: "folder" | "file",
  resourceId: string,
  principalId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO shares
       (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, 'user', $5, 'locked')`,
    [randomUUID(), orgId, resourceType, resourceId, principalId],
  );
}

async function assertAgrees(userId: string, vaultId: string, docIds: string[]): Promise<void> {
  const set = await listReadableDocsInVault(userId, vaultId);
  for (const docId of docIds) {
    const eff = await effectivePermission(userId, docId);
    expect(set.has(docId), `docId=${docId} eff=${eff}`).toBe(eff !== "none");
  }
}

// File-level, not per-describe: a `describe`-scoped afterAll closes the pool as
// soon as the first block finishes, which would break every block after it.
afterAll(async () => {
  await pool.end();
});

describe("listReadableDocsInVault agrees with effectivePermission (spec 05 §3.1)", () => {
  beforeEach(async () => {
    await resetDb();
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

  it("honors vault-scoped grants (the Open/Read-only default and per-user)", async () => {
    const org = await seedOrg("Gamma", "gamma-vd");
    const owner = await seedUser("o3@g.com");
    const member = await seedUser("m3@g.com");
    const guest = await seedUser("g3@g.com"); // per-user vault grant, not a member
    const outsider = await seedUser("x3@g.com"); // nothing at all
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");

    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Team", "Team");
    const rootNote = await seedNote(vault, null, "root.md"); // folderless — only a
    const teamNote = await seedNote(vault, folder, "Team/t.md"); // vault grant reaches it
    const all = [rootNote, teamNote];

    // The org-wide "Open" grant every new vault gets (registry POST /vaults).
    await seedVaultShare(org, "org", org, "edit");
    // A per-user vault grant for someone who is NOT a member.
    await seedVaultShare(org, "user", guest, "view");

    for (const u of [owner, member, guest, outsider]) {
      await assertAgrees(u, vault, all);
    }
    // A plain member reads EVERYTHING via the org-wide grant — this is what feeds
    // a freshly-joined member's background vault sync (regression: this set used
    // to come back empty, so new members saw blank notes until they opened each).
    expect(await listReadableDocsInVault(member, vault)).toEqual(new Set(all));
    // Per-user vault grant works even without membership…
    expect(await listReadableDocsInVault(guest, vault)).toEqual(new Set(all));
    // …but the org-wide grant never leaks to outsiders.
    expect(await listReadableDocsInVault(outsider, vault)).toEqual(new Set());
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

// The tombstone set is the ONLY thing that lets a client tell "this note was
// deleted" (remove the local file) from "I lost the share" (keep it). These tests
// pin the property that makes that safe: the two sets are exact complements over
// the docs a user may see, and a doc the user can't see appears in NEITHER — so
// the client's fallback for an unknown doc is always "leave it alone".
describe("listDeletedReadableDocsInVault", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns exactly the deleted notes an owner could otherwise read", async () => {
    const org = await seedOrg("Tomb", "tomb-owner");
    const owner = await seedUser("owner@tomb.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const live = await seedNote(vault, null, "live.md");
    const gone = await seedNote(vault, null, "gone.md");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);

    expect(await listDeletedReadableDocsInVault(owner, vault)).toEqual(new Set([gone]));
    // Complementary, never overlapping: a doc is live or dead, never both.
    expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set([live]));
  });

  it("never reports a note the caller had no access to", async () => {
    // This is the whole safety argument. `member` has no grant on the note, so
    // when it's deleted they get NO tombstone — they fall into the client's
    // "absent from both lists" branch, which keeps the file. A missed delete is
    // the acceptable failure; a wrong delete is not.
    const org = await seedOrg("Tomb2", "tomb-private");
    const owner = await seedUser("owner@tomb2.com");
    const member = await seedUser("member@tomb2.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const privateNote = await seedNote(vault, null, "secret.md", owner);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [privateNote]);

    expect(await listDeletedReadableDocsInVault(owner, vault)).toEqual(new Set([privateNote]));
    expect(await listDeletedReadableDocsInVault(member, vault)).toEqual(new Set());
  });

  it("reports a tombstone through a folder share, and stops once it's revoked", async () => {
    // The permission data survives the soft delete (created_by, folder_id and the
    // shares rows are untouched), so a tombstone resolves exactly as the live note
    // did. Revoking the share then withholds it — which is correct: an
    // un-shared-AND-deleted note must not be removed from that user's disk.
    const org = await seedOrg("Tomb3", "tomb-share");
    const owner = await seedUser("owner@tomb3.com");
    const member = await seedUser("member@tomb3.com");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const note = await seedNote(vault, folder, "Shared/n.md", owner);
    const share = await seedShare(org, "folder", folder, member, "view");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [note]);

    expect(await listDeletedReadableDocsInVault(member, vault)).toEqual(new Set([note]));
    await pool.query("DELETE FROM shares WHERE id = $1", [share]);
    expect(await listDeletedReadableDocsInVault(member, vault)).toEqual(new Set());
  });

  it("returns empty for a non-member and for an unknown vault", async () => {
    const org = await seedOrg("Tomb4", "tomb-outsider");
    const owner = await seedUser("owner@tomb4.com");
    await seedMember(org, owner, "owner");
    const outsider = await seedUser("out@tomb4.com");
    const vault = await seedVault(org);
    const gone = await seedNote(vault, null, "gone.md");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);

    expect(await listDeletedReadableDocsInVault(outsider, vault)).toEqual(new Set());
    expect(await listDeletedReadableDocsInVault(owner, randomUUID())).toEqual(new Set());
  });

  it("never returns a file id — files have no deleted_at", async () => {
    const org = await seedOrg("Tomb5", "tomb-files");
    const owner = await seedUser("owner@tomb5.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const fileId = randomUUID();
    await pool.query(
      "INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, NULL, 'a.md')",
      [fileId, vault],
    );
    // The file IS readable...
    expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set([fileId]));
    // ...but can never be a tombstone, so the client can't be told to delete it.
    expect(await listDeletedReadableDocsInVault(owner, vault)).toEqual(new Set());
  });
});
