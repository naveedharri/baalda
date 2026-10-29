// SPDX-License-Identifier: Apache-2.0
//
// The keyed index catch-up drains the WHOLE deferred queue while a key is held
// (it used to take 500 per run, every 10 minutes: ~6 h for a 20k import), and
// the daily staleness reconciliation does not re-run on every restart.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { VaultKeyCache, vaultKeyCache } from "../src/crypto/key-cache.js";
import { backfillVault, catchUpIndex } from "../src/crypto/backfill.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";

async function keyedVaultWithQueue(notes: number) {
  const orgId = await seedOrg("Drain", `drain-${Date.now()}-${Math.random()}`);
  const vaultId = await seedVault(orgId);
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(key, vaultId),
  ]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  const ids: string[] = [];
  for (let i = 0; i < notes; i++) ids.push(await seedNote(vaultId, null, `q-${String(i).padStart(4, "0")}.md`));
  await pool.query(
    `INSERT INTO index_pending (doc_id, vault_id, queued_at)
     SELECT id, $1, clock_timestamp() FROM unnest($2::text[]) AS id`,
    [vaultId, ids],
  );
  return { vaultId, key, ids };
}

const pendingCount = async (vaultId: string) =>
  Number((await pool.query("SELECT count(*) AS n FROM index_pending WHERE vault_id = $1", [vaultId])).rows[0].n);

describe("keyed index catch-up drain", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("drains every queued note in batches while the key is held", async () => {
    const { vaultId, key } = await keyedVaultWithQueue(250);
    vaultKeyCache.acquire(vaultId, key, 1);
    expect(await catchUpIndex(vaultId, pool, { batchSize: 100, throttleMs: 0 })).toBe(250);
    expect(await pendingCount(vaultId)).toBe(0);
    const n = await pool.query("SELECT count(*) AS n FROM note_index WHERE vault_id = $1 AND search_enc IS NOT NULL", [
      vaultId,
    ]);
    expect(Number(n.rows[0].n)).toBe(250);
  });

  it("stops at the next batch once the key leaves the cache, keeping the rest queued", async () => {
    const { vaultId, key } = await keyedVaultWithQueue(250);
    const cache = new VaultKeyCache();
    cache.acquire(vaultId, key, 1);
    let gets = 0;
    const evicting = {
      get: (id: string) => {
        gets += 1;
        if (gets === 2) cache.evict(id);
        return cache.get(id);
      },
    } as unknown as VaultKeyCache;
    expect(await catchUpIndex(vaultId, pool, { cache: evicting, batchSize: 100, throttleMs: 0 })).toBe(100);
    expect(await pendingCount(vaultId)).toBe(150);
  });

  it("a note that keeps failing is passed over, not retried forever", async () => {
    const { vaultId, key, ids } = await keyedVaultWithQueue(30);
    vaultKeyCache.acquire(vaultId, key, 1);
    const poison = ids[3];
    const failing = {
      query: (sql: string, params?: unknown[]) => {
        if (/INSERT INTO note_index/.test(sql) && (params as unknown[])?.[0] === poison) {
          return Promise.reject(new Error("boom"));
        }
        return pool.query(sql, params as unknown[]);
      },
    } as unknown as typeof pool;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await catchUpIndex(vaultId, failing, { batchSize: 10, throttleMs: 0 })).toBe(29);
    err.mockRestore();
    warn.mockRestore();
    const left = await pool.query("SELECT doc_id FROM index_pending WHERE vault_id = $1", [vaultId]);
    expect(left.rows.map((r) => r.doc_id)).toEqual([poison]);
  });

  it("the daily reconciliation is persisted: a restart does not re-run it", async () => {
    const { vaultId, key } = await keyedVaultWithQueue(3);
    vaultKeyCache.acquire(vaultId, key, 1);
    const seen: string[] = [];
    const counting = {
      query: (sql: string, params?: unknown[]) => {
        seen.push(sql);
        return pool.query(sql, params as unknown[]);
      },
      connect: () => pool.connect(),
    } as unknown as typeof pool;
    // The ORIGINAL cache instance: a fresh module would start with an empty one
    // and answer no_key before ever reaching the reconciliation.
    const opts = { db: counting, cache: vaultKeyCache, throttleMs: 0, indexThrottleMs: 0 };
    await backfillVault(vaultId, opts);
    expect(seen.filter((s) => /max\(u\.created_at\)/.test(s)).length).toBe(1);
    // A process restart: nothing in memory survives, only the persisted cursors.
    seen.length = 0;
    vi.resetModules();
    const fresh = await import("../src/crypto/backfill.js");
    expect(await fresh.backfillVault(vaultId, opts)).toBe("complete");
    expect(seen.filter((s) => /max\(u\.created_at\)/.test(s)).length).toBe(0);
  });
});
