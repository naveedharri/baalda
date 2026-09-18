import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createResolverCache,
  effectivePermission,
  type Permission,
} from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedDeny,
  seedFile,
  seedFolder,
  seedItemPrivate,
  seedLock,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * THE drift test for `ResolverCache`.
 *
 * The bulk routes resolve permission for up to 200 docs in one request, and they
 * do it by memoising the resolver's INPUTS — the member role, the vault posture,
 * a folder's ancestor chain — because those are facts about the vault or the
 * folder and were 4 of the 7–8 queries every single doc used to pay for.
 *
 * What must never happen is a second permission ALGEBRA. CLAUDE.md is explicit
 * about why: a set-based "editable docs" query that disagreed with
 * `effectivePermission` would not surface as a 403, it would be a healing LOOP —
 * the client is told a doc is empty, pushes, is refused, and `ready.empty` names
 * it again on the next connect, forever.
 *
 * So this walks a fixture with every branch the resolver has — a role shortcut,
 * authorship, an org grant, a per-user grant, a folder share inherited two
 * levels down, a lock, a per-user deny, an item set Private, and each of the
 * four vault postures — and asserts the CACHED answer equals the UNCACHED one
 * for every (user, doc) pair. Not "is plausible": equal.
 */

interface Fixture {
  users: string[];
  docs: string[];
}

/** One vault's worth of every ACL shape, under whichever posture is asked for. */
async function buildFixture(
  slug: string,
  posture: "shared" | "read-only" | "sealed" | "never-shared",
): Promise<Fixture> {
  const org = await seedOrg(`Acme ${slug}`, `acme-${slug}`);
  const owner = await seedUser(`owner-${slug}@a.com`);
  const admin = await seedUser(`admin-${slug}@a.com`);
  const member = await seedUser(`member-${slug}@a.com`);
  const scoped = await seedUser(`scoped-${slug}@a.com`);
  const blocked = await seedUser(`blocked-${slug}@a.com`);
  const outsider = await seedUser(`out-${slug}@a.com`);
  await seedMember(org, owner, "owner");
  await seedMember(org, admin, "admin");
  await seedMember(org, member, "member");
  await seedMember(org, scoped, "member");
  await seedMember(org, blocked, "member");

  const vault = await seedVault(org);
  if (posture === "shared") await seedVaultGrant(org, "edit");
  if (posture === "read-only") await seedVaultGrant(org, "view");
  if (posture === "sealed") await sealVault(org);

  // A three-level tree, so an inherited grant has somewhere to be inherited from.
  const top = await seedFolder(vault, null, "Projects", "Projects", owner);
  const mid = await seedFolder(vault, top, "Alpha", "Projects/Alpha", owner);
  const deep = await seedFolder(vault, mid, "Notes", "Projects/Alpha/Notes", member);
  const locked = await seedFolder(vault, null, "Frozen", "Frozen", owner);
  const priv = await seedFolder(vault, null, "Secret", "Secret", owner);

  const docs = [
    await seedNote(vault, null, "root.md", owner),
    await seedNote(vault, top, "Projects/brief.md", owner),
    await seedNote(vault, mid, "Projects/Alpha/spec.md", member),
    await seedNote(vault, deep, "Projects/Alpha/Notes/day.md", scoped),
    await seedNote(vault, locked, "Frozen/contract.md", owner),
    await seedNote(vault, priv, "Secret/keys.md", owner),
    // A `files` row: same resolver, no `created_by` column to fall back on.
    await seedFile(vault, mid, "Projects/Alpha/diagram.png"),
    await seedFile(vault, null, "cover.png"),
  ];

  // Every overlay the resolver knows about, all live at once.
  await seedShare(org, "folder", mid, scoped, "edit"); // inherited two levels down
  await seedShare(org, "file", docs[0], scoped, "view"); // a file share raising a root note
  await seedUserVaultGrant(org, blocked, "edit"); // …that a deny must still beat
  await seedLock(org, "folder", locked, { type: "org" }); // caps everyone at view
  await seedLock(org, "file", docs[6], { type: "user", id: scoped });
  await seedDeny(org, "folder", top, blocked); // per-user Private, beats everything
  await seedItemPrivate(org, "folder", priv); // item Private: drops org grants

  return { users: [owner, admin, member, scoped, blocked, outsider], docs };
}

describe("ResolverCache is the same algebra", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  for (const posture of ["shared", "read-only", "sealed", "never-shared"] as const) {
    it(`cached ≡ per-doc effectivePermission — ${posture} vault`, async () => {
      const { users, docs } = await buildFixture(posture, posture);

      const uncached: Permission[] = [];
      for (const user of users) {
        for (const doc of docs) uncached.push(await effectivePermission(user, doc));
      }

      // How a batch route actually uses it: ONE cache for the whole request,
      // shared across every doc and (here) every user.
      const cache = createResolverCache();
      const cached: Permission[] = [];
      for (const user of users) {
        for (const doc of docs) cached.push(await effectivePermission(user, doc, pool, cache));
      }

      expect(cached).toEqual(uncached);
      // A fixture that answered `none` everywhere would pass vacuously.
      expect(new Set(uncached).size).toBeGreaterThan(1);
    });
  }

  it("is a memo, not a shortcut: concurrent resolves agree with serial ones", async () => {
    const { users, docs } = await buildFixture("concurrent", "shared");
    const user = users[3]; // the scoped member — the most overlay-dependent seat
    const serial: Permission[] = [];
    for (const doc of docs) serial.push(await effectivePermission(user, doc));

    const cache = createResolverCache();
    const parallel = await Promise.all(
      docs.map((doc) => effectivePermission(user, doc, pool, cache)),
    );
    expect(parallel).toEqual(serial);
  });
});
