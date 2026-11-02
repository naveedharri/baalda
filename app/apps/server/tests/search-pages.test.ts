// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { indexDoc, searchNoteIndex } from "../src/index/indexer.js";
import { embed } from "../src/index/embedder.js";
import { keywordMatchCount, searchTokenSet } from "../src/index/search-tokens.js";
import { sealBlobScoreRow, sealBlobTextRow } from "../src/index/sealed-index.js";
import {
  buildSearchPages,
  decodePage,
  encodePage,
  pageMatchCount,
  refreshSearchPages,
  resetSearchPageChecks,
  vocabMasks,
} from "../src/index/search-pages.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

const WORDS = (
  "quarterly revenue plan planning northern region hiring engineers designer recipe lemon cake poppy seeds " +
  "forecast churn analysis roadmap launch pricing customers onboarding retention budget marketing sales " +
  "meeting notes standup retro sprint backlog release staging production server database search index"
).split(" ");

function textFor(i: number): string {
  const words: string[] = [];
  for (let j = 0; j < 12 + (i % 9); j++) words.push(WORDS[(i * 7 + j * 3) % WORDS.length]);
  return words.join(" ");
}

function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

const QUERIES = [
  "revenue plan",
  "plan", // a substring of "planning" too
  "lemon cake",
  "",
  "zzz nothing",
  "q3 xlsx", // file rel_path tokens
  Array.from({ length: 40 }, (_, i) => WORDS[i % WORDS.length] + (i >= WORDS.length ? "x" : "")).join(" "), // > 32 tokens
];

describe("search pages (keyed vaults)", () => {
  let vaultId: string;
  let orgId: string;
  let crypto: DocCrypto;
  let docIds: string[];

  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
    resetSearchPageChecks();
    orgId = await seedOrg("P", `pages-${Date.now()}`);
    vaultId = await seedVault(orgId);
    const key = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(key, vaultId)]);
    crypto = { vaultId, key, generation: 1 };
    docIds = [];
    for (let i = 0; i < 40; i++) {
      const docId = await seedNote(vaultId, null, `n${i}.md`);
      docIds.push(docId);
      await appendUpdate(docId, updateWith(textFor(i)), pool, 1000, crypto);
    }
    const release = vaultKeyCache.acquire(vaultId, key, 1);
    for (const id of docIds) await indexDoc(id);
    release();
    // Two sealed files: one a tree file, one an attachments/ drop.
    for (const [i, rel] of ["docs/q3.xlsx", "attachments/plan.pdf"].entries()) {
      const docId = rel.startsWith("docs/") ? docIds[0] : null;
      const blobId = await seedBlob(vaultId, orgId, rel, { docId });
      const body = `${textFor(100 + i)} planning`;
      const row = { body, vector: embed(body), tokens: searchTokenSet(body) };
      await pool.query(
        `INSERT INTO blob_text (blob_id, vault_id, doc_id, chars, content, source, search_enc, search_score_enc)
         VALUES ($1, $2, $3, $4, '', 'client', $5, $6)`,
        [blobId, vaultId, docId, body.length, sealBlobTextRow(crypto, blobId, row), sealBlobScoreRow(crypto, blobId, { vector: row.vector, tokens: row.tokens })],
      );
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vaultKeyCache.clear();
  });
  afterAll(async () => {
    await pool.end();
  });

  const searchAll = () =>
    Promise.all(
      QUERIES.flatMap((query) =>
        [true, false].map((vaultWideReader) =>
          searchNoteIndex({ vaultId, query, k: 25, readableDocIds: docIds, vaultWideReader, crypto }),
        ),
      ),
    );
  const pageCount = async () => (await pool.query("SELECT count(*)::int AS n FROM search_pages WHERE vault_id = $1", [vaultId])).rows[0].n;

  it("pages give exactly the results of row-by-row scoring, and fall back row by row", async () => {
    const before = await searchAll();
    expect(await buildSearchPages(crypto, "note")).toBe(1);
    expect(await buildSearchPages(crypto, "file")).toBe(1);
    expect(await pageCount()).toBe(2);
    expect(await searchAll()).toEqual(before);

    // A note edited since the page was built is scored from its own row.
    await appendUpdate(docIds[3], updateWith(" lemon cake roadmap"), pool, 1000, crypto);
    const release = vaultKeyCache.acquire(vaultId, crypto.key, 1);
    await indexDoc(docIds[3]);
    release();
    await pool.query("DELETE FROM search_pages WHERE vault_id = $1", [vaultId]);
    const edited = await searchAll();
    await buildSearchPages(crypto, "note");
    await buildSearchPages(crypto, "file");
    await appendUpdate(docIds[5], updateWith(" churn churn"), pool, 1000, crypto);
    const release2 = vaultKeyCache.acquire(vaultId, crypto.key, 1);
    await indexDoc(docIds[5]);
    release2();
    const withStale = await searchAll();
    await pool.query("DELETE FROM search_pages WHERE vault_id = $1", [vaultId]);
    expect(withStale).toEqual(await searchAll());
    expect(edited).not.toEqual(before);

    // A damaged page, or one whose stored rows were swapped, is ignored.
    await buildSearchPages(crypto, "note");
    await buildSearchPages(crypto, "file");
    const truth = await searchAll();
    await pool.query("UPDATE search_pages SET page_enc = $2 WHERE vault_id = $1 AND kind = 'note'", [vaultId, randomBytes(200)]);
    expect(await searchAll()).toEqual(truth);
    await buildSearchPages(crypto, "note");
    await pool.query(
      "UPDATE search_pages SET doc_ids = array_cat(doc_ids[2:], doc_ids[1:1]) WHERE vault_id = $1 AND kind = 'note'",
      [vaultId],
    );
    expect(await searchAll()).toEqual(truth);
  });

  it("a readable set still decides: a paged note the caller cannot read is never scored", async () => {
    await buildSearchPages(crypto, "note");
    const one = docIds.slice(0, 2);
    const hits = await searchNoteIndex({ vaultId, query: "plan revenue", k: 50, readableDocIds: one, includeFiles: false, crypto });
    expect(hits.every((h) => one.includes(h.docId!))).toBe(true);
  });

  it("refresh builds only for big enough vaults and when enough rows changed", async () => {
    expect(await refreshSearchPages(crypto, "note", pool)).toBe("small");
    expect(await refreshSearchPages(crypto, "note", pool)).toBe("waiting");
    expect(await pageCount()).toBe(0);
    expect(await refreshSearchPages(crypto, "note", pool, { force: true })).toBe("built");
    expect(await pageCount()).toBe(1);
  });

  it("page token matching equals keywordMatchCount, past 32 query tokens too", () => {
    const rows = Array.from({ length: 30 }, (_, i) => {
      const tokens = searchTokenSet(textFor(i))!;
      return { id: `d${i}`, stamp: `s${i}`, vector: embed(textFor(i)), tokens };
    });
    const page = decodePage(encodePage(rows), rows.map((r) => r.id), rows.map((r) => r.stamp));
    const scratch = new Uint32Array(4);
    for (const q of QUERIES) {
      const qTokens = Array.from(new Set(q.toLowerCase().match(/[a-z0-9_]+/g) ?? []));
      const m = vocabMasks(page, qTokens);
      rows.forEach((r, i) => {
        expect(pageMatchCount(page, i, m, scratch)).toBe(keywordMatchCount(qTokens, r.tokens));
        expect(Array.from(page.vectors.subarray(i * 256, (i + 1) * 256))).toEqual(r.vector);
      });
    }
    expect(() => decodePage(encodePage(rows), rows.map((r) => r.id).reverse(), rows.map((r) => r.stamp))).toThrow();
  });
});
