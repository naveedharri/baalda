// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { indexDoc, pendingSearchPasses, searchNoteIndex } from "../src/index/indexer.js";
import { backfillVault } from "../src/crypto/backfill.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { aadFor, open, seal } from "../src/crypto/envelope.js";
import { isUncompressedScore, openScoreRow, openSearchRow, sealScoreRow, sealSearchRow } from "../src/index/sealed-index.js";
import { SEARCH_TOKENS_MAX } from "../src/index/search-tokens.js";
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

  it("ranking reads the small score blob; a missing or damaged one falls back to the full row", async () => {
    const keyed = await corpus(true);
    const release = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    for (const id of Object.keys(keyed.ids)) await indexDoc(id);
    release();
    expect(
      (await pool.query("SELECT 1 FROM note_index WHERE vault_id = $1 AND search_score_enc IS NOT NULL", [keyed.vaultId])).rowCount,
    ).toBe(4);
    const search = (query: string) =>
      searchNoteIndex({ vaultId: keyed.vaultId, query, k: 10, readableDocIds: Object.keys(keyed.ids), includeFiles: false, crypto: keyed.crypto });
    const before = await Promise.all(["revenue plan", "lemon", "zzz"].map(search));

    await pool.query("UPDATE note_index SET search_score_enc = $2 WHERE vault_id = $1", [keyed.vaultId, randomBytes(64)]);
    expect(await Promise.all(["revenue plan", "lemon", "zzz"].map(search))).toEqual(before);
    await pool.query("UPDATE note_index SET search_score_enc = NULL WHERE vault_id = $1", [keyed.vaultId]);
    expect(await Promise.all(["revenue plan", "lemon", "zzz"].map(search))).toEqual(before);

    // The backfill gives every sealed row its score blob back.
    await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1) ON CONFLICT DO NOTHING", [keyed.vaultId]);
    const hold = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    expect(await backfillVault(keyed.vaultId, { throttleMs: 0 })).toBe("complete");
    hold();
    expect(
      (await pool.query("SELECT 1 FROM note_index WHERE vault_id = $1 AND search_score_enc IS NOT NULL", [keyed.vaultId])).rowCount,
    ).toBe(4);
    expect(await Promise.all(["revenue plan", "lemon", "zzz"].map(search))).toEqual(before);
  });

  it("an uncompressed score blob still ranks, and the backfill re-seals it compressed", async () => {
    const keyed = await corpus(true);
    const release = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    for (const id of Object.keys(keyed.ids)) await indexDoc(id);
    release();
    const search = (query: string) =>
      searchNoteIndex({ vaultId: keyed.vaultId, query, k: 10, readableDocIds: Object.keys(keyed.ids), includeFiles: false, crypto: keyed.crypto });
    const before = await Promise.all(["revenue plan", "lemon", "zzz"].map(search));

    // The format written before compression: the JSON sealed as is.
    for (const id of Object.keys(keyed.ids)) {
      const { rows } = await pool.query("SELECT search_score_enc FROM note_index WHERE doc_id = $1", [id]);
      const plainJson = Buffer.from(JSON.stringify(openScoreRow(keyed.crypto!, id, rows[0].search_score_enc)), "utf8");
      const old = seal(keyed.key, aadFor("note_index", "search_score_enc", keyed.vaultId, id), plainJson, 1);
      await pool.query("UPDATE note_index SET search_score_enc = $2 WHERE doc_id = $1", [id, old]);
    }
    expect(await Promise.all(["revenue plan", "lemon", "zzz"].map(search))).toEqual(before);

    await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1) ON CONFLICT DO NOTHING", [keyed.vaultId]);
    const hold = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    expect(await backfillVault(keyed.vaultId, { throttleMs: 0 })).toBe("complete");
    hold();
    const { rows } = await pool.query("SELECT doc_id, search_score_enc FROM note_index WHERE vault_id = $1", [keyed.vaultId]);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(isUncompressedScore(open(keyed.key, aadFor("note_index", "search_score_enc", keyed.vaultId, r.doc_id), r.search_score_enc))).toBe(false);
    }
    expect(await Promise.all(["revenue plan", "lemon", "zzz"].map(search))).toEqual(before);
  });

  it("a note past 64 KB of distinct words ranks from its score blob; the backfill gives old rows their token set", async () => {
    const keyed = await corpus(true);
    // ~12k distinct words, well past the plaintext bound.
    const big = `${Array.from({ length: 12_000 }, (_, i) => `w${i.toString(36)}x`).join(" ")} lemon revenue`;
    const bigId = await seedNote(keyed.vaultId, null, "big.md");
    keyed.ids[bigId] = "big.md";
    await appendUpdate(bigId, updateWith(big), pool, 1000, keyed.crypto);
    const release = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    for (const id of Object.keys(keyed.ids)) await indexDoc(id);
    release();
    expect(big.length).toBeGreaterThan(SEARCH_TOKENS_MAX);
    const scoreOf = async () =>
      openScoreRow(keyed.crypto!, bigId, (await pool.query("SELECT search_score_enc FROM note_index WHERE doc_id = $1", [bigId])).rows[0].search_score_enc);
    expect(typeof (await scoreOf()).tokens).toBe("string");
    const queries = ["revenue plan", "lemon", "w1zx", "big", "zzz", ""];
    const search = (query: string) =>
      searchNoteIndex({ vaultId: keyed.vaultId, query, k: 10, readableDocIds: Object.keys(keyed.ids), includeFiles: false, crypto: keyed.crypto });
    const now = await Promise.all(queries.map(search));

    // As written before: no token set in either blob, so search opens the body.
    const { rows } = await pool.query("SELECT search_enc FROM note_index WHERE doc_id = $1", [bigId]);
    const full = openSearchRow(keyed.crypto!, bigId, rows[0].search_enc);
    await pool.query("UPDATE note_index SET search_enc = $2, search_score_enc = $3 WHERE doc_id = $1", [
      bigId,
      sealSearchRow(keyed.crypto!, bigId, { ...full, tokens: null }),
      sealScoreRow(keyed.crypto!, bigId, { vector: full.vector!, tokens: null }),
    ]);
    expect((await scoreOf()).tokens).toBeNull();
    expect(await Promise.all(queries.map(search))).toEqual(now);

    await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1) ON CONFLICT DO NOTHING", [keyed.vaultId]);
    const hold = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    expect(await backfillVault(keyed.vaultId, { throttleMs: 0 })).toBe("complete");
    hold();
    expect(typeof (await scoreOf()).tokens).toBe("string");
    expect(await Promise.all(queries.map(search))).toEqual(now);
    expect(now[2].some((h) => h.docId === bigId)).toBe(true);
  });

  it("concurrent searches of one vault share a pass and get exactly their own results", async () => {
    const keyed = await corpus(true);
    const release = vaultKeyCache.acquire(keyed.vaultId, keyed.key, 1);
    for (const id of Object.keys(keyed.ids)) await indexDoc(id);
    release();
    const readable = Object.keys(keyed.ids);
    const queries = ["revenue plan", "lemon", "", "engineers designer", "zzz", "plan", "cake poppy", "churn"];
    const search = (query: string, k = 10) =>
      searchNoteIndex({ vaultId: keyed.vaultId, query, k, readableDocIds: readable, crypto: keyed.crypto });
    const alone: unknown[] = [];
    for (const q of queries) alone.push(await search(q));

    const spy = vi.spyOn(pool, "query");
    const together = await Promise.all([...queries.map((q) => search(q)), search("revenue", 1)]);
    const reads = spy.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("FROM note_index ni") && sql.includes("LIMIT $5")).length;
    spy.mockRestore();
    expect(together.slice(0, queries.length)).toEqual(alone);
    expect(together[queries.length]).toEqual((alone[0] as unknown[]).length ? await search("revenue", 1) : []);
    // The first search starts alone; the other eight share the next pass.
    expect(reads).toBeLessThanOrEqual(3);
    await new Promise((r) => setImmediate(r)); // the drain loop ends on the next turn
    expect(pendingSearchPasses()).toBe(0);

    // A different readable set never shares a pass, and sees only its own notes.
    const one = readable.slice(0, 1);
    const [narrow, wide] = await Promise.all([
      searchNoteIndex({ vaultId: keyed.vaultId, query: "plan", k: 10, readableDocIds: one, crypto: keyed.crypto }),
      search("plan"),
    ]);
    expect(narrow.every((h) => one.includes(h.docId!))).toBe(true);
    expect(wide).toEqual(await search("plan"));
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
