import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedMember, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Migration 050 fills `files.created_by` from the single uploader its blob
 * rows agree on, so members can delete the files they uploaded before 049
 * started recording a creator.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "050_files_created_by_backfill.sql",
);

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function del(user: TestUser, fileId: string) {
  return app.fetch(
    new Request(`http://local/api/files/${fileId}`, { method: "DELETE", headers: authHeaders(user) }),
  );
}

/** Run the migration exactly as `db/migrate.ts` does: one transaction. */
async function runBackfill() {
  const sql = await readFile(MIGRATION, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const creatorOf = async (id: string) =>
  (await pool.query<{ created_by: string | null }>("SELECT created_by FROM files WHERE id = $1", [id]))
    .rows[0]?.created_by;
const fileExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM files WHERE id = $1", [id])).rowCount === 1;

describe("migration 050: files.created_by backfill", () => {
  let owner: TestUser;
  let a: TestUser;
  let b: TestUser;
  let org: string;
  let vault: string;

  async function seedFile(path: string, by: string | null = null) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO files (id, vault_id, folder_id, path, created_by) VALUES ($1, $2, NULL, $3, $4)",
      [id, vault, path, by],
    );
    return id;
  }

  async function seedBlob(docId: string, by: string | null) {
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                          storage_provider, status, data, doc_id, created_by)
       VALUES ($1, $2, $3, $4, 3, 'application/pdf', 'x.pdf', 'x.pdf', 'postgres', 'ready',
               decode('000102','hex'), $5, $6)`,
      [randomUUID(), vault, org, randomUUID().replace(/-/g, "") + "f".repeat(32), docId, by],
    );
  }

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp(`owner+${randomUUID().slice(0, 6)}@backfill.test`);
    org = (await createOrg(owner, "Backfill", `backfill-${randomUUID().slice(0, 6)}`)).id;
    a = await signUp(`a+${randomUUID().slice(0, 6)}@backfill.test`);
    b = await signUp(`b+${randomUUID().slice(0, 6)}@backfill.test`);
    await seedMember(org, a.userId, "member");
    await seedMember(org, b.userId, "member");
    vault = await seedVault(org);
    // Everyone can edit everything, so only the creator rule can refuse.
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("takes the single agreed uploader and leaves ambiguous or blob-less files NULL", async () => {
    const single = await seedFile("single.pdf");
    await seedBlob(single, a.userId);
    await seedBlob(single, a.userId);
    await seedBlob(single, null); // an unattributed row does not make it ambiguous
    const conflicting = await seedFile("conflicting.pdf");
    await seedBlob(conflicting, a.userId);
    await seedBlob(conflicting, b.userId);
    const noBlob = await seedFile("no-blob.pdf");
    const already = await seedFile("already.pdf", b.userId);
    await seedBlob(already, a.userId);

    await runBackfill();

    expect(await creatorOf(single)).toBe(a.userId);
    expect(await creatorOf(conflicting)).toBeNull();
    expect(await creatorOf(noBlob)).toBeNull();
    expect(await creatorOf(already)).toBe(b.userId);

    // Idempotent: a second run changes nothing.
    await runBackfill();
    expect(await creatorOf(single)).toBe(a.userId);
    expect(await creatorOf(conflicting)).toBeNull();
    expect(await creatorOf(already)).toBe(b.userId);
  });

  it("lets the uploader delete the backfilled file while another member gets delete_not_creator", async () => {
    const single = await seedFile("single.pdf");
    await seedBlob(single, a.userId);
    const noBlob = await seedFile("no-blob.pdf");

    await runBackfill();

    const refused = await del(b, single);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("delete_not_creator");
    expect(await fileExists(single)).toBe(true);

    expect((await del(a, single)).status).toBe(204);
    expect(await fileExists(single)).toBe(false);

    // Still creator-less, so still admin-only.
    const orphan = await del(a, noBlob);
    expect(orphan.status).toBe(403);
    expect(((await orphan.json()) as { code: string }).code).toBe("delete_not_creator");
    expect((await del(owner, noBlob)).status).toBe(204);
  });
});
