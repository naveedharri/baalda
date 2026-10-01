import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createResolverCache,
  effectivePermission,
  type Permission,
} from "../src/permissions/resolver.js";
import { syncPermission } from "../src/trash/access.js";
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
 * The drift test for the batched half of `ResolverCache` (#263): `membership`
 * (role + join snapshot + posture in one read), the one-read share rows, and
 * `prefetch` (locations, chains and share rows for a whole batch in three
 * reads). `resolver-cache-drift.test.ts` covers the plain memo; this one adds
 * the seats and states those paths could get wrong — a join snapshot, org
 * grants on a folder and a file, a per-user vault grant, a doc in Trash, an
 * id that does not exist — and asserts three answers are EQUAL for every
 * (user, doc): uncached, cached, and cached + prefetched. Too wide is a
 * security bug; too narrow sends a revocation to a client that should keep the
 * file. Neither is acceptable, so "plausible" is not the bar.
 */

type Posture = "shared" | "read-only" | "sealed" | "never-shared";

/** A query counter in front of the pool, for the round-trip assertion. */
function counted() {
  let n = 0;
  const db = {
    query: ((...args: Parameters<typeof pool.query>) => {
      n++;
      return (pool.query as (...a: unknown[]) => unknown)(...args);
    }) as typeof pool.query,
  };
  return { db, count: () => n, reset: () => (n = 0) };
}

async function orgGrant(orgId: string, type: "folder" | "file", id: string, permission: "edit" | "view") {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'org', $1, $4)`,
    [orgId, type, id, permission],
  );
}

async function buildFixture(slug: string, posture: Posture) {
  const org = await seedOrg(`Prefetch ${slug}`, `prefetch-${slug}`);
  const owner = await seedUser(`owner-${slug}@p.test`);
  const admin = await seedUser(`admin-${slug}@p.test`);
  const member = await seedUser(`member-${slug}@p.test`);
  const scoped = await seedUser(`scoped-${slug}@p.test`);
  const blocked = await seedUser(`blocked-${slug}@p.test`);
  const joiner = await seedUser(`joiner-${slug}@p.test`);
  const viewer = await seedUser(`viewer-${slug}@p.test`);
  const outsider = await seedUser(`out-${slug}@p.test`);
  await seedMember(org, owner, "owner");
  await seedMember(org, admin, "admin");
  await seedMember(org, member, "member");
  await seedMember(org, scoped, "member");
  await seedMember(org, blocked, "member");
  await seedMember(org, joiner, "member");
  await seedMember(org, viewer, "member");

  const vault = await seedVault(org);
  if (posture === "shared") await seedVaultGrant(org, "edit");
  if (posture === "read-only") await seedVaultGrant(org, "view");
  if (posture === "sealed") await sealVault(org);

  const top = await seedFolder(vault, null, "Projects", "Projects", owner);
  const mid = await seedFolder(vault, top, "Alpha", "Projects/Alpha", owner);
  const deep = await seedFolder(vault, mid, "Notes", "Projects/Alpha/Notes", member);
  const locked = await seedFolder(vault, null, "Frozen", "Frozen", owner);
  const priv = await seedFolder(vault, null, "Secret", "Secret", owner);
  const team = await seedFolder(vault, null, "Team", "Team", owner);

  const live = [
    await seedNote(vault, null, "root.md", owner),
    await seedNote(vault, null, "mine.md", member), // authorship at the root
    await seedNote(vault, top, "Projects/brief.md", owner),
    await seedNote(vault, mid, "Projects/Alpha/spec.md", member),
    await seedNote(vault, deep, "Projects/Alpha/Notes/day.md", scoped),
    await seedNote(vault, locked, "Frozen/contract.md", owner),
    await seedNote(vault, priv, "Secret/keys.md", member), // creator inside a Private item
    await seedNote(vault, team, "Team/plan.md", owner), // org folder grant
    await seedNote(vault, null, "shared-file.md", owner), // org file grant
    await seedFile(vault, mid, "Projects/Alpha/diagram.png"),
    await seedFile(vault, null, "cover.png"),
  ];
  // In Trash, inside its window: no live answer, a sync answer via includeDeleted.
  const trashed = await seedNote(vault, mid, "Projects/Alpha/old.md", member);
  await pool.query(
    "UPDATE notes SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
    [trashed],
  );
  // In Trash past its window: nothing at all.
  const expired = await seedNote(vault, null, "expired.md", member);
  await pool.query(
    "UPDATE notes SET deleted_at = now() - interval '40 days', purge_after = now() - interval '10 days' WHERE id = $1",
    [expired],
  );
  const missing = "00000000-0000-0000-0000-000000000000";

  await seedShare(org, "folder", mid, scoped, "edit");
  await seedShare(org, "file", live[0], scoped, "view");
  await seedShare(org, "file", live[6], joiner, "edit");
  await seedUserVaultGrant(org, blocked, "edit");
  await seedUserVaultGrant(org, viewer, "view");
  await orgGrant(org, "folder", team, "edit");
  await orgGrant(org, "file", live[8], "view");
  await seedLock(org, "folder", locked, { type: "org" });
  await seedLock(org, "file", live[9], { type: "user", id: scoped });
  await seedDeny(org, "folder", top, blocked);
  await seedItemPrivate(org, "folder", priv);
  // Everything so far existed when the joiner joined (a Read-only default).
  await pool.query(
    `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
     VALUES ($1, $2, 'readonly', 0, now() + interval '1 day')
     ON CONFLICT (organization_id, user_id)
       DO UPDATE SET mode = 'readonly', access_revision = 0, snapshot_at = now() + interval '1 day'`,
    [org, joiner],
  );

  return {
    users: [owner, admin, member, scoped, blocked, joiner, viewer, outsider],
    live,
    docs: [...live, trashed, expired, missing],
  };
}

describe("ResolverCache batching is the same algebra", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  for (const posture of ["shared", "read-only", "sealed", "never-shared"] as const) {
    it(`uncached ≡ cached ≡ prefetched — ${posture} vault`, async () => {
      const { users, docs } = await buildFixture(posture, posture);

      const uncached: Permission[] = [];
      const uncachedSync: Permission[] = [];
      for (const user of users) {
        for (const doc of docs) {
          uncached.push(await effectivePermission(user, doc));
          uncachedSync.push(await syncPermission(user, doc));
        }
      }

      // One cache per user, as a batch route makes one per request.
      const cached: Permission[] = [];
      const cachedSync: Permission[] = [];
      const prefetched: Permission[] = [];
      const prefetchedSync: Permission[] = [];
      for (const user of users) {
        const plain = createResolverCache();
        const batch = createResolverCache();
        await batch.prefetch(pool, docs);
        for (const doc of docs) {
          cached.push(await effectivePermission(user, doc, pool, plain));
          cachedSync.push(await syncPermission(user, doc, pool, plain));
          prefetched.push(await effectivePermission(user, doc, pool, batch));
          prefetchedSync.push(await syncPermission(user, doc, pool, batch));
        }
      }

      expect(cached).toEqual(uncached);
      expect(prefetched).toEqual(uncached);
      expect(cachedSync).toEqual(uncachedSync);
      expect(prefetchedSync).toEqual(uncachedSync);
      // Vacuous fixtures (all `none`, or no Trash-only answers) prove nothing.
      expect(new Set(uncached).size).toBeGreaterThan(1);
      expect(uncachedSync).not.toEqual(uncached);
    });
  }

  it("one prefetched cache shared by every user still answers per user", async () => {
    const { users, docs } = await buildFixture("shared-cache", "shared");
    const expected: Permission[] = [];
    for (const user of users) for (const doc of docs) expected.push(await effectivePermission(user, doc));

    const cache = createResolverCache();
    await cache.prefetch(pool, docs);
    const actual = await Promise.all(
      users.flatMap((user) => docs.map((doc) => effectivePermission(user, doc, pool, cache))),
    );
    expect(actual).toEqual(expected);
  });

  it("prefetch never preloads a soft-deleted note or a missing id", async () => {
    const { docs, live } = await buildFixture("preload", "shared");
    const cache = createResolverCache();
    await cache.prefetch(pool, docs);
    for (const doc of live) expect(cache.preloaded(doc)).toBeDefined();
    for (const doc of docs.slice(live.length)) expect(cache.preloaded(doc)).toBeUndefined();
  });

  it("a prefetched batch costs a constant number of reads", async () => {
    const { users, live } = await buildFixture("count", "shared");
    const user = users[3]; // the scoped member: every overlay applies to them
    const c = counted();

    for (const doc of live) await effectivePermission(user, doc, c.db);
    const uncached = c.count();

    c.reset();
    const cache = createResolverCache();
    await cache.prefetch(c.db, live);
    for (const doc of live) await effectivePermission(user, doc, c.db, cache);
    const batched = c.count();

    // Three prefetch reads + one membership read, whatever the doc count.
    expect(batched).toBeLessThanOrEqual(4);
    expect(batched).toBeLessThan(uncached);
  });
});
