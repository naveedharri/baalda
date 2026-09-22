import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedOrg, seedVault } from "./helpers/seed.js";
import { MemoryBlobStore } from "../src/blobs/memory-store.js";
import { objectKey } from "../src/blobs/keys.js";
import {
  copyPhase,
  cutoverPhase,
  type MigrateOptions,
} from "../src/scripts/migrate-blobs.js";

/**
 * `pnpm run blobs:migrate` — moving attachments out of Postgres BYTEA.
 *
 * Tested through the two phase functions rather than the CLI, against the
 * memory store: the thing worth pinning is the SAFETY of the split, not the
 * argument parser. Specifically — `--copy` must not change how a single byte is
 * read, a row whose bytes disagree with its recorded hash must be left strictly
 * alone, and `--cutover` must refuse anything it cannot re-verify.
 */
let vaultId = "";
let orgId = "";

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  vaultId: null,
  batch: 50,
  limit: null,
  sleepMs: 0,
  dryRun: false,
  ...over,
});

/** A postgres-provider blob holding `bytes`, optionally with a LYING sha256. */
async function seedBlob(bytes: Buffer, opts: { sha?: string } = {}): Promise<string> {
  const id = randomUUID();
  const sha = opts.sha ?? createHash("sha256").update(bytes).digest("hex");
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data)
     VALUES ($1, $2, $3, $4, $5, 'image/png', $6, 'x.png', 'postgres', 'ready', $7)`,
    [id, vaultId, orgId, sha, bytes.byteLength, `attachments/${id}.png`, bytes],
  );
  return id;
}

const rowOf = async (id: string) =>
  (
    await pool.query<{
      storage_provider: string;
      storage_key: string | null;
      data: Buffer | null;
    }>("SELECT storage_provider, storage_key, data FROM blobs WHERE id = $1", [id])
  ).rows[0];

afterAll(async () => {
  await pool.end();
});

describe("blobs:migrate", () => {
  beforeEach(async () => {
    await resetDb();
    orgId = await seedOrg("Migrate Co", `mig-${randomUUID().slice(0, 8)}`);
    vaultId = await seedVault(orgId);
  });

  it("--copy writes the object and records the key WITHOUT changing the provider", async () => {
    const bytes = Buffer.from("hello attachments");
    const id = await seedBlob(bytes);
    const store = new MemoryBlobStore();

    const summary = await copyPhase(store, opts());
    expect(summary).toMatchObject({ scanned: 1, moved: 1, failed: 0, mismatched: 0 });

    const row = await rowOf(id);
    // The provider is untouched and the bytes are still in the column: reads
    // are unchanged, and the phase is reversible by clearing `storage_key`.
    expect(row.storage_provider).toBe("postgres");
    expect(row.data?.equals(bytes)).toBe(true);
    expect(row.storage_key).toBe(
      objectKey(vaultId, createHash("sha256").update(bytes).digest("hex")),
    );
    expect(store.objects.get(row.storage_key as string)?.equals(bytes)).toBe(true);
  });

  it("--copy is idempotent — a second run has nothing to do", async () => {
    await seedBlob(Buffer.from("abc"));
    const store = new MemoryBlobStore();
    await copyPhase(store, opts());
    expect(await copyPhase(store, opts())).toMatchObject({ scanned: 0, moved: 0 });
  });

  it("--copy leaves a row whose bytes do not hash to its sha256 strictly alone", async () => {
    const id = await seedBlob(Buffer.from("real bytes"), { sha: "0".repeat(64) });
    const store = new MemoryBlobStore();

    const summary = await copyPhase(store, opts());
    expect(summary.mismatched).toBe(1);
    expect(summary.moved).toBe(0);
    // Nothing written under a content-addressed key that does not describe it,
    // and nothing recorded on the row.
    expect(store.objects.size).toBe(0);
    expect((await rowOf(id)).storage_key).toBeNull();
  });

  it("--copy --dry-run touches nothing", async () => {
    const id = await seedBlob(Buffer.from("abc"));
    const store = new MemoryBlobStore();
    const summary = await copyPhase(store, opts({ dryRun: true }));
    expect(summary.moved).toBe(1);
    expect(store.objects.size).toBe(0);
    expect((await rowOf(id)).storage_key).toBeNull();
  });

  it("--copy honours --vault and --limit", async () => {
    const otherVault = await seedVault(orgId, "Other");
    await seedBlob(Buffer.from("a"));
    await seedBlob(Buffer.from("b"));
    const saved = vaultId;
    vaultId = otherVault;
    await seedBlob(Buffer.from("c"));
    vaultId = saved;

    const store = new MemoryBlobStore();
    expect(await copyPhase(store, opts({ vaultId: otherVault }))).toMatchObject({ moved: 1 });
    expect(await copyPhase(store, opts({ limit: 1 }))).toMatchObject({ scanned: 1, moved: 1 });
  });

  it("--cutover flips verified rows and releases their bytes", async () => {
    const bytes = Buffer.from("hello attachments");
    const id = await seedBlob(bytes);
    const store = new MemoryBlobStore();
    await copyPhase(store, opts());

    const summary = await cutoverPhase(store, opts());
    expect(summary).toMatchObject({ scanned: 1, moved: 1, failed: 0 });

    const row = await rowOf(id);
    expect(row.storage_provider).toBe("s3");
    expect(row.data).toBeNull();
    expect(row.storage_key).not.toBeNull();
    // And it is idempotent: the row no longer matches the candidate query.
    expect(await cutoverPhase(store, opts())).toMatchObject({ scanned: 0 });
  });

  it("--cutover refuses a row whose object has gone missing", async () => {
    const id = await seedBlob(Buffer.from("abc"));
    const store = new MemoryBlobStore();
    await copyPhase(store, opts());
    store.objects.clear(); // a lifecycle rule, a wrong bucket, a hand-run cleanup

    const summary = await cutoverPhase(store, opts());
    expect(summary).toMatchObject({ scanned: 1, moved: 0, skipped: 1 });
    // The database copy — the only copy left — is still there.
    expect((await rowOf(id)).data).not.toBeNull();
  });

  it("--cutover refuses a row whose object is the wrong size", async () => {
    const id = await seedBlob(Buffer.from("abcdef"));
    const store = new MemoryBlobStore();
    await copyPhase(store, opts());
    const key = (await rowOf(id)).storage_key as string;
    store.objects.set(key, Buffer.from("ab"));

    expect(await cutoverPhase(store, opts())).toMatchObject({ moved: 0, skipped: 1 });
    expect((await rowOf(id)).storage_provider).toBe("postgres");
  });
});
