import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedOrg, seedVault } from "./helpers/seed.js";
import { sweepPendingOnce } from "../src/blobs/gc.js";
import { BLOB_PENDING_TTL_MINUTES } from "../src/blobs/config.js";

/**
 * The pending sweep exists because `intent` made abandoned uploads possible:
 * a `pending` row holds its content's (vault, sha256) DEDUPE SLOT, so leaving
 * one behind makes the next upload of that content adopt an upload that never
 * finished. These tests pin the three things that decide a row's fate — age,
 * status, and nothing else.
 */
let vaultId = "";

/** A blob row aged by `minutesAgo` (both timestamps, since the sweep sorts on
 *  `updated_at` and the partial index is on `created_at`). */
async function seedBlob(status: "pending" | "ready", minutesAgo: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data, created_at, updated_at)
     VALUES ($1, $2, $3, 3, 'image/png', $4, 'x.png', 'postgres', $5,
             CASE WHEN $5 = 'ready' THEN decode('000102','hex') ELSE NULL END,
             now() - ($6 || ' minutes')::interval,
             now() - ($6 || ' minutes')::interval)`,
    [id, vaultId, randomUUID().replace(/-/g, "") + "a".repeat(32), `attachments/${id}.png`, status,
      String(minutesAgo)],
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
