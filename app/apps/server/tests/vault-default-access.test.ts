import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote } from "./helpers/seed.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { vaultRootWritable } from "../src/permissions/http-gates.js";

/**
 * The access a vault has the moment it is created.
 *
 * A vault is created on Only what's shared (2026-11-23): sealed for the team
 * (owners and admins included) and for anyone who joins later, while its
 * creator gets Can edit everything as their own level so they can use it.
 *
 * The tests below pin both halves of that: the default is applied at creation,
 * and it is applied ONLY at creation, so an owner who later chooses Private
 * cannot have that choice quietly undone.
 *
 * Note these go through `POST /api/vaults` rather than the `seedVault` helper.
 * The helper inserts the row directly, which is exactly what the other suites
 * want (a grant-less vault to test the resolver against) and exactly what would
 * make this file test nothing.
 */

const app = createApp(testAppDeps());

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function createVault(user: TestUser, organizationId: string, name: string) {
  const res = await req(user, "POST", "/api/vaults", { name, organizationId });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function orgGrants(organizationId: string) {
  return pool.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND principal_type = 'org' AND principal_id = $1`,
    [organizationId],
  );
}

describe("a new vault's default access", () => {
  let owner: TestUser;
  let org: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@default-access.test");
    org = (await createOrg(owner, "Acme", "acme-default-access")).id;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("seals the first vault for the team and gives its creator Can edit everything", async () => {
    await createVault(owner, org, "Notes");
    const { rows } = await orgGrants(org);
    expect(rows.map((r) => r.permission)).toEqual(["denied"]);
    const own = await pool.query<{ permission: string }>(
      `SELECT permission FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1
          AND principal_type = 'user' AND principal_id = $2`,
      [org, owner.userId],
    );
    expect(own.rows.map((r) => r.permission)).toEqual(["edit"]);
  });

  it("starts people who join later on Only what's shared", async () => {
    await createVault(owner, org, "Notes");
    const { rows } = await pool.query<{ join_default: string }>(
      "SELECT join_default FROM organization_access_settings WHERE organization_id = $1",
      [org],
    );
    expect(rows[0]?.join_default).toBe("private");
  });

  it("lets the creator read and add notes, and shows a later member or admin nothing", async () => {
    const vault = await createVault(owner, org, "Notes");
    const note = await seedNote(vault.id, null, "owners-note.md", owner.userId);
    expect(await effectivePermission(owner.userId, note)).toBe("edit");
    expect(await vaultRootWritable(owner.userId, org)).toBe(true);

    const joiner = await signUp("joiner@default-access.test");
    await seedMember(org, joiner.userId, "member");
    const admin = await signUp("admin@default-access.test");
    await seedMember(org, admin.userId, "admin");
    for (const who of [joiner, admin]) {
      expect(await effectivePermission(who.userId, note)).toBe("none");
      // Members don't keep what they write either: nothing to add at the root.
      expect(await vaultRootWritable(who.userId, org)).toBe(false);
    }
  });

  it("does not re-grant when a second collection is added", async () => {
    // The grant is keyed on the ORG, so re-running it on every collection
    // would resurrect one the owner had revoked. Going Private must stick.
    await createVault(owner, org, "Notes");
    await pool.query(
      `DELETE FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1 AND principal_type = 'org'`,
      [org],
    );

    await createVault(owner, org, "Second");

    const { rows } = await orgGrants(org);
    expect(rows).toHaveLength(0);
  });

  it("keeps a later member locked out of a vault the owner set to Private", async () => {
    const vault = await createVault(owner, org, "Notes");
    const note = await seedNote(vault.id, null, "secret.md", owner.userId);
    // Access panel → Private revokes exactly this row…
    await pool.query(
      `DELETE FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1 AND principal_type = 'org'`,
      [org],
    );
    // …and New-member access is its own setting, set to Private explicitly.
    const res = await req(owner, "PUT", `/api/orgs/${org}/access-default`, { mode: "private" });
    expect(res.status).toBe(200);

    const joiner = await signUp("late@default-access.test");
    await seedMember(org, joiner.userId, "member");

    expect(await effectivePermission(joiner.userId, note)).toBe("none");
  });
});
