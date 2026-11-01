// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { indexDoc, searchNoteIndex } from "../src/index/indexer.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";

const CORPUS: Record<string, string> = {
  "alpha.md": "Quarterly revenue plan for the northern region",
  "beta.md": "Hiring plan: two engineers and one designer",
  "gamma.md": "Recipe: lemon cake with poppy seeds",
  "delta.md": "Revenue forecast and churn analysis",
};

function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

async function corpus(keyed: boolean) {
  const orgId = await seedOrg(`S${keyed}`, `search-${keyed}-${Date.now()}`);
  const vaultId = await seedVault(orgId);
  const key = randomBytes(32);
  let crypto: DocCrypto | undefined;
  if (keyed) {
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(key, vaultId),
    ]);
    crypto = { vaultId, key, generation: 1 };
  }
  const ids: Record<string, string> = {};
  for (const [path, text] of Object.entries(CORPUS)) {
    const docId = await seedNote(vaultId, null, path);
    ids[docId] = path;
    await appendUpdate(docId, updateWith(text), pool, 1000, crypto);
  }
  return { vaultId, key, crypto, ids };
}

describe("sealed note_index (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vaultKeyCache.clear();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("keyed indexing defers with no held key, then seals with one; rows hold no plaintext", async () => {
    const k = await corpus(true);
    const docId = Object.keys(k.ids)[0];
    expect(await indexDoc(docId)).toBe(false);
    expect((await pool.query("SELECT 1 FROM note_index WHERE vault_id = $1", [k.vaultId])).rows).toHaveLength(0);

    const release = vaultKeyCache.acquire(k.vaultId, k.key, 1);
    for (const id of Object.keys(k.ids)) expect(await indexDoc(id)).toBe(true);
    release();
    const { rows } = await pool.query(
      "SELECT content, vector, search_tokens, search_enc FROM note_index WHERE vault_id = $1",
      [k.vaultId],
    );
    for (const r of rows) {
      expect(r.content).toBe("");
      expect(r.vector).toBeNull();
      expect(r.search_tokens).toBeNull();
      expect(r.search_enc.includes(Buffer.from("revenue"))).toBe(false);
    }
  });

  it("search ranks a keyed vault exactly like an unkeyed copy of the same notes", async () => {
    const plain = await corpus(false);
    const keyed = await corpus(true);
    for (const id of Object.keys(plain.ids)) await indexDoc(id);
    const release = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    for (const id of Object.keys(keyed.ids)) await indexDoc(id);
    release();

    for (const query of ["revenue plan", "lemon", "engineers designer", "zzz"]) {
      for (const keywordMode of ["app", "sql"] as const) {
        const a = await searchNoteIndex({ vaultId: plain.vaultId, query, k: 10, readableDocIds: Object.keys(plain.ids), includeFiles: false, keywordMode });
        const b = await searchNoteIndex({ vaultId: keyed.vaultId, query, k: 10, readableDocIds: Object.keys(keyed.ids), includeFiles: false, keywordMode, crypto: keyed.crypto });
        // Ties keep doc_id order, and doc ids differ between the two copies.
        const norm = (hits: typeof a) =>
          hits.map((h) => [h.score.toFixed(10), h.relPath]).sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : y[0].localeCompare(x[0])));
        expect(norm(b)).toEqual(norm(a));
      }
    }
    await expect(
      searchNoteIndex({ vaultId: keyed.vaultId, query: "revenue", k: 10, readableDocIds: Object.keys(keyed.ids), includeFiles: false }),
    ).rejects.toBeInstanceOf(KeyRequiredError);
  });

  it("a keyed re-index never nulls an existing plaintext row's columns", async () => {
    const k = await corpus(false);
    const docId = Object.keys(k.ids)[0];
    await indexDoc(docId);
    const before = (await pool.query("SELECT content, search_tokens FROM note_index WHERE doc_id = $1", [docId])).rows[0];
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [k.vaultId, makeVkCheck(k.key, k.vaultId)]);
    const release = vaultKeyCache.acquire(k.vaultId, k.key, 1);
    expect(await indexDoc(docId)).toBe(true);
    release();
    const after = (await pool.query("SELECT content, search_tokens, search_enc FROM note_index WHERE doc_id = $1", [docId])).rows[0];
    expect(after.content).toBe(before.content);
    expect(after.search_tokens).toBe(before.search_tokens);
    expect(after.search_enc).not.toBeNull();
  });
});
