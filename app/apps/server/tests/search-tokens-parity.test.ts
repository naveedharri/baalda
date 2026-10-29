import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { embed } from "../src/index/embedder.js";
import { searchNoteIndex } from "../src/index/indexer.js";
import { keywordMatchCount, searchTokenSet } from "../src/index/search-tokens.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedFile, seedMember, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * W3: keyword matching moved from SQL (`position(tok IN lower(text))`) to the
 * app (`search_tokens`, migration 068). Same corpus, both paths, identical
 * ordered results — scores included.
 */

const WORDS = [
  "pipeline", "forecast", "quarterly", "board", "hiring", "roadmap", "invoice", "customer",
  "retention", "launch", "q3", "q4", "okr_2026", "budget", "café", "naïve", "Straße", "ÉCOLE",
  "concatenate", "cat", "catalog", "x1", "snake_case", "CamelCase", "über", "résumé", "日本語",
  "data-driven", "e-mail", "foo.bar", "v2.1", "#tag", "[[Link]]", "100%", "user@example.com",
];

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function text(r: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.2 ? "s" : ""));
    if (r() < 0.1) out.push("\n");
  }
  return out.join(r() < 0.5 ? " " : ", ");
}

const QUERIES = [
  "pipeline forecast",
  "cat",
  "CAT catalog",
  "café ecole",
  "snake_case okr_2026",
  "camelcase",
  "q3 board hiring",
  "mail example",
  "v2 1",
  "über resume",
  "日本語 data driven",
  "nothing matches zzz",
  "s",
];

async function insertCorpus(vault: string, org: string, n: number, seed: number, withTokens: boolean) {
  const r = rand(seed);
  const ids: string[] = [];
  const BATCH = 500;
  for (let start = 0; start < n; start += BATCH) {
    const rows: unknown[] = [];
    const values: string[] = [];
    for (let i = start; i < Math.min(n, start + BATCH); i++) {
      const id = randomUUID();
      ids.push(id);
      const title = text(r, 3);
      const content = text(r, 40 + Math.floor(r() * 200));
      const base = rows.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`);
      rows.push(
        id,
        vault,
        title,
        content,
        JSON.stringify(embed(`${title}\n${content}`)),
        withTokens ? searchTokenSet(`${title} ${content}`) : null,
      );
    }
    const ids2 = ids.slice(start);
    await pool.query(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id)
       SELECT x, $1, NULL, x, x || '.md', x FROM unnest($2::text[]) AS x`,
      [vault, ids2],
    );
    await pool.query(
      `INSERT INTO note_index (doc_id, vault_id, title, content, vector, search_tokens) VALUES ${values.join(",")}`,
      rows,
    );
  }
  // Files: rel_path tokens are matched live, the text through the stored set.
  for (let i = 0; i < 30; i++) {
    const rel = `Files/${text(r, 2).replace(/[\s,]+/g, "_")}-${i}.pdf`;
    const doc = await seedFile(vault, null, rel);
    const blob = await seedBlob(vault, org, rel, { docId: doc });
    const content = text(r, 60);
    await pool.query(
      `INSERT INTO blob_text (blob_id, vault_id, doc_id, chars, content, vector, source, search_tokens)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'client', $7)`,
      [blob, vault, doc, content.length, content, JSON.stringify(embed(content)), withTokens ? searchTokenSet(content) : null],
    );
    ids.push(doc);
  }
  return ids;
}

describe("search_tokens parity (migration 068)", () => {
  let org: string;
  let vault: string;
  let ids: string[];

  beforeAll(async () => {
    await resetDb();
    org = await seedOrg("Parity", `parity-${randomUUID().slice(0, 8)}`);
    const u = await seedUser(`p+${randomUUID()}@parity.test`);
    await seedMember(org, u, "owner");
    vault = await seedVault(org);
    ids = await insertCorpus(vault, org, 2000, 42, true);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  it("keywordMatchCount equals Postgres position(lower()) per row", async () => {
    const { rows } = await pool.query<{ t: string; c: string; tok: string }>(
      `SELECT coalesce(title,'') || ' ' || content AS t, search_tokens AS tok FROM note_index WHERE vault_id = $1`,
      [vault],
    );
    for (const q of QUERIES) {
      const { tokenize } = await import("../src/index/embedder.js");
      const qt = Array.from(new Set(tokenize(q)));
      const { rows: sqlRows } = await pool.query<{ t: string; n: number }>(
        `SELECT coalesce(title,'') || ' ' || content AS t,
                (SELECT count(*) FROM unnest($2::text[]) AS x(tok)
                  WHERE position(x.tok IN lower(coalesce(title,'') || ' ' || content)) > 0)::int AS n
           FROM note_index WHERE vault_id = $1`,
        [vault, qt],
      );
      const byText = new Map(sqlRows.map((r) => [r.t, r.n]));
      for (const r of rows) expect(keywordMatchCount(qt, r.tok)).toBe(byText.get(r.t));
    }
  });

  it("app path returns the same ordered hits and scores as the SQL path", async () => {
    for (const q of QUERIES) {
      const base = { vaultId: vault, query: q, k: 50, readableDocIds: ids, vaultWideReader: true };
      const sql = await searchNoteIndex({ ...base, keywordMode: "sql" });
      const app = await searchNoteIndex({ ...base, keywordMode: "app" });
      expect(app).toEqual(sql);
    }
  });

  it("rows without search_tokens fall back to the SQL count", async () => {
    await pool.query("UPDATE note_index SET search_tokens = NULL WHERE doc_id = ANY($1::text[])", [ids.slice(0, 500)]);
    for (const q of QUERIES.slice(0, 4)) {
      const base = { vaultId: vault, query: q, k: 50, readableDocIds: ids, vaultWideReader: true };
      expect(await searchNoteIndex({ ...base, keywordMode: "app" })).toEqual(
        await searchNoteIndex({ ...base, keywordMode: "sql" }),
      );
    }
  });

  it("falls back to SQL for Turkish İ, Kelvin K and an over-cap note, finding the same hits", async () => {
    expect(searchTokenSet("İstanbul office")).toBeNull();
    expect(searchTokenSet("273 \u212Aelvin")).toBeNull();
    expect(searchTokenSet("café Straße 日本語")).not.toBeNull();
    let big = "";
    for (let i = 0; big.length < 70 * 1024; i++) big += `w${i} `;
    expect(searchTokenSet(big)).toBeNull();
    const add = async (title: string, content: string) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id) VALUES ($1, $2, NULL, $1, $1 || '.md', $1)`,
        [id, vault],
      );
      await pool.query(
        `INSERT INTO note_index (doc_id, vault_id, title, content, vector, search_tokens) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, vault, title, content, JSON.stringify(embed(`${title}\n${content}`)), searchTokenSet(`${title} ${content}`)],
      );
      ids.push(id);
      return id;
    };
    const turk = await add("Trip", "Meeting in İstanbul next week");
    const huge = await add("Huge", `${big} needle_at_the_end`);
    for (const q of ["istanbul", "needle_at_the_end", "w9999 pipeline"]) {
      const base = { vaultId: vault, query: q, k: 50, readableDocIds: ids, vaultWideReader: true };
      const sql = await searchNoteIndex({ ...base, keywordMode: "sql" });
      expect(await searchNoteIndex({ ...base, keywordMode: "app" })).toEqual(sql);
    }
    const { rows } = await pool.query<{ doc_id: string; search_tokens: string | null }>(
      "SELECT doc_id, search_tokens FROM note_index WHERE doc_id = ANY($1::text[])",
      [[turk, huge]],
    );
    expect(rows.every((r) => r.search_tokens === null)).toBe(true);
  });

  it.runIf(process.env.SEARCH_BENCH === "1")("benchmark: 20k notes", async () => {
    await resetDb();
    org = await seedOrg("Bench", `bench-${randomUUID().slice(0, 8)}`);
    vault = await seedVault(org);
    ids = await insertCorpus(vault, org, 20_000, 7, true);
    await pool.query("ANALYZE note_index");
    const time = async (mode: "sql" | "app") => {
      const t0 = performance.now();
      for (const q of QUERIES) {
        await searchNoteIndex({ vaultId: vault, query: q, k: 20, readableDocIds: ids, vaultWideReader: true, keywordMode: mode });
      }
      return (performance.now() - t0) / QUERIES.length;
    };
    await time("sql");
    await time("app");
    const sql = await time("sql");
    const app = await time("app");
    console.log(`[search-bench] 20k notes, ms/query: sql=${sql.toFixed(1)} app=${app.toFixed(1)}`);
  }, 600_000);
});
