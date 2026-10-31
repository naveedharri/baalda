// SPDX-License-Identifier: Apache-2.0
//
// A keyed vault's user-driven writes index with the REQUEST's verified key
// (load test: 20k notes registered with content stayed unsearchable while no
// member's vault channel was connected).
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { applyDocPushBatch } from "../src/sync/doc-batch.js";
import { flushIndexQueue, scheduleIndex } from "../src/index/indexer.js";
import { openSearchRow } from "../src/index/sealed-index.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";

function stateOf(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return u;
}

async function keyedVault(): Promise<{ vaultId: string; c: DocCrypto }> {
  const orgId = await seedOrg("Keyed", `keyed-${Date.now()}-${Math.random()}`);
  const vaultId = await seedVault(orgId);
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(key, vaultId),
  ]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  return { vaultId, c: { vaultId, key, generation: 1 } };
}

describe("keyed index with the request's key", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("a batch push indexes with the request key, no member connected, and does not queue", async () => {
    const { vaultId, c } = await keyedVault();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedNote(vaultId, null, `n-${i}.md`));
    // The request's key is the caller's buffer: zeroing it after the response
    // must not break the deferred run (the queue holds its own copy).
    const reqKey = { ...c, key: Buffer.from(c.key) };
    const res = await applyDocPushBatch(
      vaultId,
      ids.map((docId, i) => ({ docId, update: stateOf(`pangolin report ${i}\n`), expectEmpty: true })),
      { userId: null, crypto: reqKey },
    );
    expect(res.every((r) => r.outcome === "applied")).toBe(true);
    reqKey.key.fill(0);
    expect(vaultKeyCache.has(vaultId)).toBe(false);
    await flushIndexQueue();
    const { rows } = await pool.query(
      "SELECT doc_id, search_enc FROM note_index WHERE vault_id = $1 ORDER BY doc_id",
      [vaultId],
    );
    expect(rows.length).toBe(5);
    for (const r of rows) expect(openSearchRow(c, r.doc_id, r.search_enc).body).toContain("pangolin report");
    expect((await pool.query("SELECT 1 FROM index_pending WHERE vault_id = $1", [vaultId])).rowCount).toBe(0);
  });

  it("a key from a retired generation falls back to the queue, never drops the note", async () => {
    const { vaultId, c } = await keyedVault();
    const docId = await seedNote(vaultId, null, "rotated.md");
    await applyDocPushBatch(vaultId, [{ docId, update: stateOf("aardvark\n"), expectEmpty: true }], {
      userId: null,
      crypto: c,
    });
    // A rotation lands inside the debounce window.
    await pool.query("UPDATE vaults SET key_generation = 2 WHERE id = $1", [vaultId]);
    await flushIndexQueue();
    expect((await pool.query("SELECT 1 FROM note_index WHERE doc_id = $1", [docId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(1);
  });

  it("a keyed index clears an older deferral of the same note", async () => {
    const { vaultId, c } = await keyedVault();
    const docId = await seedNote(vaultId, null, "older.md");
    // Deferred earlier (no key anywhere).
    scheduleIndex(docId, 0);
    await flushIndexQueue();
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(1);
    await applyDocPushBatch(vaultId, [{ docId, update: stateOf("ibis\n"), expectEmpty: true }], {
      userId: null,
      crypto: c,
    });
    await flushIndexQueue();
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM note_index WHERE doc_id = $1", [docId])).rowCount).toBe(1);
  });

  it("the request path stays deferred: a 100-note batch does not pay for indexing", async () => {
    const { vaultId, c } = await keyedVault();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(await seedNote(vaultId, null, `b-${i}.md`));
    const t0 = performance.now();
    await applyDocPushBatch(
      vaultId,
      ids.map((docId, i) => ({ docId, update: stateOf(`batch body ${i} `.repeat(50)), expectEmpty: true })),
      { userId: null, crypto: c },
    );
    const pushMs = performance.now() - t0;
    expect((await pool.query("SELECT 1 FROM note_index WHERE vault_id = $1", [vaultId])).rowCount).toBe(0);
    const t1 = performance.now();
    await flushIndexQueue();
    const indexMs = performance.now() - t1;
    process.stderr.write(`[measure] 100-note keyed batch: push ${pushMs.toFixed(0)} ms, deferred index ${indexMs.toFixed(0)} ms\n`);
    expect((await pool.query("SELECT 1 FROM note_index WHERE vault_id = $1", [vaultId])).rowCount).toBe(100);
  });
});
