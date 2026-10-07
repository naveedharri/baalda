import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

/**
 * Migrations 051 (billing accounts) + 052 (subscriptions keyed by id, attached
 * to an account), run against a database seeded in the PRE-051 shape.
 *
 * The suite owns a throwaway database of its own (`<test db>_mig`), so it can
 * apply 001–050 by hand, seed, then apply 051/052 twice to prove they are
 * idempotent — without touching the shared test DB other suites migrate.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "051");
const under = files.filter((f) => f.startsWith("051_") || f.startsWith("052_"));

const baseUrl = new URL(config.databaseUrl);
const testDbName = `${baseUrl.pathname.slice(1)}_mig`;
if (!testDbName.startsWith("context_test")) {
  throw new Error(`refusing to run the migration suite against ${testDbName}`);
}
const migUrl = new URL(config.databaseUrl);
migUrl.pathname = `/${testDbName}`;

let db: pg.Client;

async function adminQuery(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: config.databaseUrl });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function applyFiles(list: string[]): Promise<void> {
  for (const f of list) {
    await db.query("BEGIN");
    await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await db.query("COMMIT");
  }
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

async function seed(): Promise<void> {
  const users = ["u_alice", "u_bob", "u_carol", "u_dave", "u_gone"];
  for (const id of users) {
    await db.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $1 || '@x.test', true)`,
      [id],
    );
  }
  const orgs = ["o_a1", "o_a2", "o_b1"];
  for (const id of orgs) {
    await db.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $1, $1, now())`,
      [id],
    );
  }
  const members: Array<[string, string, string, Date]> = [
    // alice owns two vaults; o_a1 holds 3 people.
    ["o_a1", "u_alice", "owner", day(1)],
    ["o_a1", "u_carol", "member", day(2)],
    ["o_a1", "u_dave", "member", day(3)],
    ["o_a2", "u_alice", "owner", day(4)],
    // bob owns one vault; carol was added as a LATER co-owner.
    ["o_b1", "u_bob", "owner", day(5)],
    ["o_b1", "u_carol", "owner", day(6)],
  ];
  for (const [org, user, role, at] of members) {
    await db.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1 || ':' || $2, $1, $2, $3, $4)`,
      [org, user, role, at],
    );
  }
  // Old shape: keyed by organization_id.
  await db.query(
    `INSERT INTO subscriptions (organization_id, provider_subscription_id, plan, status)
     VALUES ('o_a1', 'sub_live', 'pro', 'active')`,
  );
  // Tombstone: vault deleted, owner recorded.
  await db.query(
    `INSERT INTO subscriptions (organization_id, provider_subscription_id, plan, status,
       deleted_at, owner_user_id)
     VALUES ('o_dead', 'sub_tomb', 'pro', 'canceled', now(), 'u_bob')`,
  );
  // Orphan: vault deleted and its owner no longer exists.
  await db.query(
    `INSERT INTO subscriptions (organization_id, provider_subscription_id, plan, status,
       deleted_at, owner_user_id)
     VALUES ('o_orphan', NULL, 'pro', 'canceled', now(), 'u_vanished')`,
  );
}

beforeAll(async () => {
  await adminQuery(`DROP DATABASE IF EXISTS ${testDbName}`);
  await adminQuery(`CREATE DATABASE ${testDbName}`);
  db = new pg.Client({ connectionString: migUrl.toString() });
  await db.connect();
  await applyFiles(before);
  await seed();
  await applyFiles(under);
  await applyFiles(under); // second run must change nothing
});

afterAll(async () => {
  await db?.end();
  await adminQuery(`DROP DATABASE IF EXISTS ${testDbName}`);
});

const acct = (userId: string) =>
  db
    .query<{ id: string }>(`SELECT 'ba_' || md5($1) AS id`, [userId])
    .then((r) => r.rows[0]!.id);

describe("migration 051: billing accounts", () => {
  it("creates one account per owner and none for plain members", async () => {
    const { rows } = await db.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM billing_accounts ORDER BY owner_user_id`,
    );
    expect(rows.map((r) => r.owner_user_id)).toEqual(["u_alice", "u_bob", "u_carol"]);
  });

  it("attaches each vault to its earliest owner's account", async () => {
    const { rows } = await db.query<{ organization_id: string; billing_account_id: string }>(
      `SELECT organization_id, billing_account_id FROM billing_account_orgs ORDER BY organization_id`,
    );
    expect(rows).toEqual([
      { organization_id: "o_a1", billing_account_id: await acct("u_alice") },
      { organization_id: "o_a2", billing_account_id: await acct("u_alice") },
      { organization_id: "o_b1", billing_account_id: await acct("u_bob") },
    ]);
  });

  it("grandfathers people and vault counts above the free defaults", async () => {
    const { rows } = await db.query(
      `SELECT owner_user_id, free_people_limit, free_synced_vaults
         FROM billing_accounts ORDER BY owner_user_id`,
    );
    expect(rows).toEqual([
      { owner_user_id: "u_alice", free_people_limit: 3, free_synced_vaults: 2 },
      { owner_user_id: "u_bob", free_people_limit: null, free_synced_vaults: null },
      { owner_user_id: "u_carol", free_people_limit: null, free_synced_vaults: null },
    ]);
  });
});

describe("migration 052: subscriptions keyed by id", () => {
  it("moves the primary key to id and keeps organization_id unique + nullable", async () => {
    const { rows: pk } = await db.query<{ attname: string }>(
      `SELECT a.attname FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'subscriptions'::regclass AND c.contype = 'p'`,
    );
    expect(pk.map((r) => r.attname)).toEqual(["id"]);
    const { rows: col } = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'subscriptions' AND column_name = 'organization_id'`,
    );
    expect(col[0]!.is_nullable).toBe("YES");
    await expect(
      db.query(
        `INSERT INTO subscriptions (id, organization_id, plan, status) VALUES ('x', 'o_a1', 'pro', 'active')`,
      ),
    ).rejects.toThrow(/subscriptions_organization_id_key/);
  });

  it("backfills id and attaches live rows, tombstones and leaves orphans NULL", async () => {
    const { rows } = await db.query(
      `SELECT id, organization_id, billing_account_id FROM subscriptions ORDER BY organization_id`,
    );
    expect(rows).toEqual([
      { id: "sub_live", organization_id: "o_a1", billing_account_id: await acct("u_alice") },
      { id: "sub_tomb", organization_id: "o_dead", billing_account_id: await acct("u_bob") },
      { id: "legacy:o_orphan", organization_id: "o_orphan", billing_account_id: null },
    ]);
  });

  it("fills id for writers that do not name it (the old ON CONFLICT path)", async () => {
    await db.query(
      `INSERT INTO subscriptions (organization_id, provider_subscription_id, plan, status)
       VALUES ('o_a2', 'sub_new', 'pro', 'active')
       ON CONFLICT (organization_id) DO UPDATE SET status = EXCLUDED.status`,
    );
    const { rows } = await db.query(`SELECT id FROM subscriptions WHERE organization_id = 'o_a2'`);
    expect(rows[0]!.id).toBe("sub_new");
  });
});
