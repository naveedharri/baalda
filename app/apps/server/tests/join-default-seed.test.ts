// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * Migration 033 has already run against the test database, so these tests
 * reproduce the PRE-migration state instead: `resetDb` truncates
 * `organization` (and `organization_access_settings` cascades with it), the
 * fixtures below then write a posture without a settings row, and the
 * migration's own SQL is re-applied from the file — the same pattern
 * `path-folder-consistency.test.ts` uses for migration 022.
 */
const SEED_SQL = readFileSync(
  new URL("../migrations/033_seed_join_default_from_posture.sql", import.meta.url),
  "utf8",
);

/** Everything a vault has before 033 runs: an owner, content, and a posture. */
async function preMigrationVault(posture: "edit" | "view" | "sealed" | "none") {
  const org = await seedOrg("Seeded posture", `seed-${randomUUID()}`);
  const owner = await seedUser(`owner-${randomUUID()}@test.dev`);
  // The owner is exempt from the snapshot trigger, so this writes no settings
  // row — which is exactly the state an organization created before 032 is in.
  await seedMember(org, owner, "owner");
  const vault = await seedVault(org);
  const folder = await seedFolder(vault, null, "Existing", "Existing", owner);
  const doc = await seedNote(vault, folder, "Existing/note.md", owner);
  if (posture === "edit" || posture === "view") await seedVaultGrant(org, posture);
  if (posture === "sealed") await sealVault(org);
  return { org, owner, vault, folder, doc };
}

async function settings(org: string) {
  const { rows } = await pool.query<{ join_default: string; access_revision: string }>(
    "SELECT join_default, access_revision FROM organization_access_settings WHERE organization_id = $1",
    [org],
  );
  return rows[0] ?? null;
}

async function joinAfterMigration(org: string) {
  const user = await seedUser(`joiner-${randomUUID()}@test.dev`);
  await seedMember(org, user, "member");
  return user;
}

describe("migration 033 seeds the join default from the vault posture", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("maps an org-wide edit grant to 'open' and admits a later joiner to pre-existing content", async () => {
    const { org, vault, doc } = await preMigrationVault("edit");
    expect(await settings(org)).toBeNull();

    await pool.query(SEED_SQL);

    // Revision 0 is deliberate: the snapshot path reads `mode` directly, so the
    // pre-existing grant's own revision 0 never has to win a comparison.
    expect(await settings(org)).toEqual({ join_default: "open", access_revision: "0" });

    const joiner = await joinAfterMigration(org);
    expect(await effectivePermission(joiner, doc)).toBe("edit");
    expect(await listReadableDocsInVault(joiner, vault)).toContain(doc);
  });

  it("maps an org-wide view grant to 'readonly' and gives a later joiner read of the same content", async () => {
    const { org, vault, doc } = await preMigrationVault("view");

    await pool.query(SEED_SQL);
    expect((await settings(org))?.join_default).toBe("readonly");

    const joiner = await joinAfterMigration(org);
    expect(await effectivePermission(joiner, doc)).toBe("view");
    expect(await listReadableDocsInVault(joiner, vault)).toContain(doc);
  });

  it("leaves a vault with no org-wide grant private", async () => {
    const { org, vault, doc } = await preMigrationVault("none");

    await pool.query(SEED_SQL);
    expect((await settings(org))?.join_default).toBe("private");

    const joiner = await joinAfterMigration(org);
    expect(await effectivePermission(joiner, doc)).toBe("none");
    expect(await listReadableDocsInVault(joiner, vault)).not.toContain(doc);
  });

  it("leaves a sealed vault private", async () => {
    const { org, vault, doc } = await preMigrationVault("sealed");

    await pool.query(SEED_SQL);
    expect((await settings(org))?.join_default).toBe("private");

    const joiner = await joinAfterMigration(org);
    expect(await effectivePermission(joiner, doc)).toBe("none");
    expect(await listReadableDocsInVault(joiner, vault)).not.toContain(doc);
  });

  it("never overwrites a settings row that already exists", async () => {
    const { org, doc } = await preMigrationVault("edit");
    // 032 ran days ago and somebody has since chosen Private for future joiners
    // (and made ACL changes, so the revision has moved on).
    await pool.query(
      `INSERT INTO organization_access_settings (organization_id, join_default, access_revision)
       VALUES ($1, 'private', 7)`,
      [org],
    );

    await pool.query(SEED_SQL);

    expect(await settings(org)).toEqual({ join_default: "private", access_revision: "7" });
    const joiner = await joinAfterMigration(org);
    expect(await effectivePermission(joiner, doc)).toBe("none");
  });

  it("is idempotent and seeds every organization in one pass", async () => {
    const open = await preMigrationVault("edit");
    const readonly = await preMigrationVault("view");
    const priv = await preMigrationVault("none");

    await pool.query(SEED_SQL);
    await pool.query(SEED_SQL);

    expect((await settings(open.org))?.join_default).toBe("open");
    expect((await settings(readonly.org))?.join_default).toBe("readonly");
    expect((await settings(priv.org))?.join_default).toBe("private");
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM organization_access_settings",
    );
    expect(rows[0].count).toBe("3");
  });

  it("does not seed organizations created after the migration", async () => {
    await pool.query(SEED_SQL);
    const { org, doc } = await preMigrationVault("edit");

    expect(await settings(org)).toBeNull();
    const joiner = await joinAfterMigration(org);
    // 032's default stands for a brand-new vault: the trigger lazily writes the
    // settings row as 'private', and the joiner sees nothing that predates them.
    expect((await settings(org))?.join_default).toBe("private");
    expect(await effectivePermission(joiner, doc)).toBe("none");
  });
});
