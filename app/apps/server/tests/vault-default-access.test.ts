import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote } from "./helpers/seed.js";
import { effectivePermission } from "../src/permissions/resolver.js";

/**
 * The access a vault has the moment it is created.
 *
 * A vault is created SHARED with its team: someone you invite can read and
 * write its notes as soon as they join. This replaced a private-by-default
 * posture that was right about solo vaults and wrong about invitations — a
 * teammate would accept, sync, and land on an empty sidebar with no way to ask
 * for access.
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

  it("grants the team edit access when the first vault is created", async () => {
    await createVault(owner, org, "Notes");
    const { rows } = await orgGrants(org);
    expect(rows).toHaveLength(1);
    expect(rows[0].permission).toBe("edit");
  });

  it("lets someone who joins later read and write an existing note", async () => {
    // The reported bug: invite a teammate, they see nothing.
    const vault = await createVault(owner, org, "Notes");
    const note = await seedNote(vault.id, null, "owners-note.md", owner.userId);

    const joiner = await signUp("joiner@default-access.test");
    await seedMember(org, joiner.userId, "member");

    expect(await effectivePermission(joiner.userId, note)).toBe("edit");
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
    // Access panel → Private revokes exactly this row.
    await pool.query(
      `DELETE FROM shares
        WHERE resource_type = 'vault' AND resource_id = $1 AND principal_type = 'org'`,
      [org],
    );

    const joiner = await signUp("late@default-access.test");
    await seedMember(org, joiner.userId, "member");

    expect(await effectivePermission(joiner.userId, note)).toBe("none");
  });
});
