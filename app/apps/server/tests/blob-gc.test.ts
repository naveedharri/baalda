import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import {
  drainBlobDeletionsOnce,
  sweepOrphansOnce,
  sweepPendingOnce,
} from "../src/blobs/gc.js";
import { BLOB_PENDING_TTL_MINUTES } from "../src/blobs/config.js";
import { MemoryBlobStore } from "../src/blobs/memory-store.js";
import { resetBlobStores, setBlobStoreOverride } from "../src/blobs/store.js";

/**
 * The pending sweep exists because `intent` made abandoned uploads possible:
 * a `pending` row holds its content's (vault, sha256) DEDUPE SLOT, so leaving
 * one behind makes the next upload of that content adopt an upload that never
 * finished. These tests pin the three things that decide a row's fate — age,
 * status, and nothing else.
 */
let vaultId = "";
let orgId = "";

/** A blob row aged by `minutesAgo` (both timestamps, since the sweep sorts on
 *  `updated_at` and the partial index is on `created_at`). */
async function seedBlob(status: "pending" | "ready", minutesAgo: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data, created_at, updated_at)
     VALUES ($1, $2, $7, $3, 3, 'image/png', $4, 'x.png', 'postgres', $5,
             CASE WHEN $5 = 'ready' THEN decode('000102','hex') ELSE NULL END,
             now() - ($6 || ' minutes')::interval,
             now() - ($6 || ' minutes')::interval)`,
    [id, vaultId, randomUUID().replace(/-/g, "") + "a".repeat(32), `attachments/${id}.png`, status,
      String(minutesAgo), orgId || null],
  );
  return id;
}

/** A `ready` blob on a named provider — the shape the deletion trigger cares
 *  about (an s3 row leaves an object behind; a postgres row does not). */
async function seedStoredBlob(
  provider: "postgres" | "s3",
  storageKey: string | null,
  minutesAgo = 1,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, storage_key, status, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 3, 'image/png', $5, 'x.png', $6, $7, 'ready',
             CASE WHEN $6 = 'postgres' THEN decode('000102','hex') ELSE NULL END,
             now() - ($8 || ' minutes')::interval,
             now() - ($8 || ' minutes')::interval)`,
    [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "d".repeat(32),
      `attachments/${id}.png`, provider, storageKey, String(minutesAgo)],
  );
  return id;
}

const exists = async (id: string) =>
  (await pool.query("SELECT 1 FROM blobs WHERE id = $1", [id])).rows.length === 1;

afterAll(async () => {
  await pool.end();
});

describe("pending blob sweep", () => {
  beforeEach(async () => {
    await resetDb();
    const org = await seedOrg("GC Co", `gc-${randomUUID().slice(0, 8)}`);
    orgId = org;
    vaultId = await seedVault(org);
  });

  it("removes a pending row past the TTL, keeps a fresh one, never touches ready", async () => {
    const stale = await seedBlob("pending", BLOB_PENDING_TTL_MINUTES + 5);
    const fresh = await seedBlob("pending", 1);
    const published = await seedBlob("ready", BLOB_PENDING_TTL_MINUTES * 10);

    expect(await sweepPendingOnce()).toBe(1);

    expect(await exists(stale)).toBe(false);
    // An upload that started five minutes ago is an upload in progress.
    expect(await exists(fresh)).toBe(true);
    // A published attachment is never garbage, however old.
    expect(await exists(published)).toBe(true);
  });

  it("frees the dedupe slot so the same content can be uploaded again", async () => {
    const stale = await seedBlob("pending", BLOB_PENDING_TTL_MINUTES + 5);
    const { rows } = await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM blobs WHERE id = $1",
      [stale],
    );
    await sweepPendingOnce();
    // `blobs_vault_sha_idx` refuses a second row for the same (vault, sha);
    // this insert is the proof the slot is actually free again.
    await expect(
      pool.query(
        `INSERT INTO blobs (id, vault_id, sha256, size, mime, rel_path, filename,
                            storage_provider, status)
         VALUES ($1, $2, $3, 1, 'image/png', 'attachments/retry.png', 'retry.png',
                 'postgres', 'pending')`,
        [randomUUID(), vaultId, rows[0].sha256],
      ),
    ).resolves.toBeTruthy();
  });

  it("is a no-op when there is nothing to sweep", async () => {
    await seedBlob("ready", 1);
    expect(await sweepPendingOnce()).toBe(0);
  });
});

// ── the deletion queue (migration 027) ─────────────────────────────────────

/**
 * The trigger is the only thing standing between "a vault was deleted" and "its
 * objects are billed forever": the row goes through an `ON DELETE CASCADE` and
 * a `DELETE FROM blobs WHERE org_id = $1` that neither know a bucket exists.
 */
describe("blob deletion queue", () => {
  beforeEach(async () => {
    await resetDb();
    resetBlobStores();
    const org = await seedOrg("Queue Co", `q-${randomUUID().slice(0, 8)}`);
    orgId = org;
    vaultId = await seedVault(org);
  });

  afterEach(() => resetBlobStores());

  const queued = async () =>
    (
      await pool.query<{ provider: string; storage_key: string; attempts: number }>(
        "SELECT provider, storage_key, attempts FROM blob_deletions ORDER BY id",
      )
    ).rows;

  it("queues an s3 row under the org-delete cascade, and never a postgres one", async () => {
    await seedStoredBlob("s3", "vaults/v/aaa");
    await seedStoredBlob("postgres", null);

    // Exactly what `http/routes/orgs.ts` runs inside the org-delete transaction.
    await pool.query("DELETE FROM blobs WHERE org_id = $1", [orgId]);

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "s3", storage_key: "vaults/v/aaa" });
  });

  it("queues through the vaults cascade too — nothing runs application code there", async () => {
    await seedStoredBlob("s3", "vaults/v/bbb");
    await pool.query("DELETE FROM vaults WHERE id = $1", [vaultId]);
    expect(await queued()).toHaveLength(1);
  });

  it("drains the queue through the row's own provider", async () => {
    const store = new MemoryBlobStore();
    store.objects.set("vaults/v/ccc", Buffer.from("bytes"));
    setBlobStoreOverride("s3", store);
    await pool.query(
      "INSERT INTO blob_deletions (provider, storage_key) VALUES ('s3', 'vaults/v/ccc')",
    );

    expect(await drainBlobDeletionsOnce()).toBe(1);
    expect(store.objects.has("vaults/v/ccc")).toBe(false);
    // Only a row whose object is gone leaves the queue.
    expect(await queued()).toEqual([]);
  });

  it("backs a failure off instead of losing it, and gives up after ten tries", async () => {
    const store = new MemoryBlobStore();
    store.delete = async () => {
      throw new Error("bucket unreachable");
    };
    setBlobStoreOverride("s3", store);
    await pool.query(
      "INSERT INTO blob_deletions (provider, storage_key) VALUES ('s3', 'vaults/v/ddd')",
    );

    expect(await drainBlobDeletionsOnce()).toBe(0);
    let rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);

    // The backoff is real: an immediate second tick does not touch the row.
    expect(await drainBlobDeletionsOnce()).toBe(0);
    expect((await queued())[0].attempts).toBe(1);

    // At the attempt ceiling the row stays — it is the only record that an
    // object is leaking, and its `last_error` is the only reason.
    await pool.query(
      "UPDATE blob_deletions SET attempts = 9, last_attempt_at = NULL WHERE storage_key = $1",
      ["vaults/v/ddd"],
    );
    await drainBlobDeletionsOnce();
    rows = await queued();
    expect(rows[0].attempts).toBe(10);
    await drainBlobDeletionsOnce();
    expect((await queued())[0].attempts).toBe(10);
  });

  it("leaves a row alone when this build has no configuration for its provider", async () => {
    await pool.query(
      "INSERT INTO blob_deletions (provider, storage_key) VALUES ('s3', 'vaults/v/eee')",
    );
    // No override and no S3_* env: `storage_unavailable`. That is a deployment
    // that has not been given the bucket yet, not a failed attempt, so the
    // row's ten tries must not be spent on it.
    expect(await drainBlobDeletionsOnce()).toBe(0);
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(0);
  });
});

// ── the orphan sweep ───────────────────────────────────────────────────────

/**
 * The only sweep that deletes something a user made. Every test here is about a
 * guard: the ones that stop it are more important than the one case where it
 * actually collects.
 */
describe("orphan sweep", () => {
  beforeEach(async () => {
    await resetDb();
    const org = await seedOrg("Orphan Co", `o-${randomUUID().slice(0, 8)}`);
    orgId = org;
    vaultId = await seedVault(org);
  });

  /** A vault that has been indexed, with one note referencing `refPath`. */
  async function seedIndexedNote(refPath: string | null): Promise<string> {
    const docId = await seedNote(vaultId, null, "Note.md");
    await pool.query(
      `INSERT INTO note_index (doc_id, vault_id, title, content)
       VALUES ($1, $2, 'Note', $3)`,
      [docId, vaultId, refPath ? `![p](${refPath})` : "no attachments here"],
    );
    if (refPath) {
      await pool.query(
        "INSERT INTO blob_refs (vault_id, rel_path, doc_id) VALUES ($1, $2, $3)",
        [vaultId, refPath.toLowerCase(), docId],
      );
    }
    return docId;
  }

  const sweep = (opts = {}) =>
    sweepOrphansOnce(pool, { enabled: true, orphanDays: 30, maxDeletes: 200, ...opts });

  it("does nothing at all when GC is disabled", async () => {
    await seedIndexedNote(null);
    await seedBlob("ready", 60 * 24 * 60);
    expect(await sweepOrphansOnce(pool, { enabled: false })).toBe(0);
  });

  it("collects an old unreferenced blob and logs it", async () => {
    await seedIndexedNote(null);
    const orphan = await seedBlob("ready", 60 * 24 * 60); // 60 days
    expect(await sweep()).toBe(1);
    expect(await exists(orphan)).toBe(false);
  });

  it("never touches a young one — the note that embeds it may not have synced yet", async () => {
    await seedIndexedNote(null);
    const fresh = await seedBlob("ready", 24 * 60); // 1 day
    expect(await sweep()).toBe(0);
    expect(await exists(fresh)).toBe(true);
  });

  it("never touches a referenced one, whatever its age or capitalisation", async () => {
    const id = randomUUID();
    const relPath = `Attachments/${id}.PNG`;
    await seedIndexedNote(relPath);
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                          storage_provider, status, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 3, 'image/png', $5, 'x.png', 'postgres', 'ready',
               decode('000102','hex'), now() - interval '90 days', now() - interval '90 days')`,
      [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "b".repeat(32), relPath],
    );
    expect(await sweep()).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it("skips a vault with no indexed notes rather than calling everything an orphan", async () => {
    const blob = await seedBlob("ready", 60 * 24 * 60);
    // note_index is empty: "nothing references it" is unknown, not false.
    expect(await sweep()).toBe(0);
    expect(await exists(blob)).toBe(true);
  });

  it("rebuilds missing refs before judging a vault indexed by an older build", async () => {
    const id = randomUUID();
    const relPath = `attachments/${id}.png`;
    // Indexed note that DOES embed the blob, but no blob_refs row — exactly the
    // state every existing vault is in the moment this migration lands.
    const docId = await seedNote(vaultId, null, "Note.md");
    await pool.query(
      `INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, 'Note', $3)`,
      [docId, vaultId, `![p](${relPath})`],
    );
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                          storage_provider, status, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 3, 'image/png', $5, 'x.png', 'postgres', 'ready',
               decode('000102','hex'), now() - interval '90 days', now() - interval '90 days')`,
      [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "c".repeat(32), relPath],
    );

    expect(await sweep()).toBe(0);
    expect(await exists(id)).toBe(true);
    // …and the refs are now built, so the next pass is a cheap one.
    const { rows } = await pool.query("SELECT 1 FROM blob_refs WHERE vault_id = $1", [vaultId]);
    expect(rows).toHaveLength(1);
  });

  it("honours the per-run deletion cap", async () => {
    await seedIndexedNote(null);
    for (let i = 0; i < 5; i++) await seedBlob("ready", 60 * 24 * 60);
    expect(await sweep({ maxDeletes: 2 })).toBe(2);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM blobs");
    expect(rows[0].n).toBe(3);
  });

  it("queues the object of a collected s3 orphan instead of deleting bytes it cannot see", async () => {
    await seedIndexedNote(null);
    await seedStoredBlob("s3", "vaults/v/orphan", 60 * 24 * 60);
    expect(await sweep()).toBe(1);
    const { rows } = await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM blob_deletions",
    );
    expect(rows.map((r) => r.storage_key)).toEqual(["vaults/v/orphan"]);
  });
});
