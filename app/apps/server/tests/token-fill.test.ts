// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { embed } from "../src/index/embedder.js";
import { searchNoteIndex } from "../src/index/indexer.js";
import { SEARCH_TOKENS_MAX, searchTokenSet } from "../src/index/search-tokens.js";
import { fillSearchTokensPass, writeTokens } from "../src/index/token-fill.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedFile, seedOrg, seedVault } from "./helpers/seed.js";

const BODIES = [
  "Quarterly revenue plan for the northern region",
  "Hiring plan: two engineers and one designer",
  "Recipe: lemon cake with poppy seeds, café style",
  "Revenue forecast and churn analysis q3",
];
const QUERIES = ["revenue plan", "lemon", "cafe", "q3 churn", "", "zzz"];

/** A note row as written before migration 068: content and vector, no token set. */
async function note(vault: string, title: string, content: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO notes (id, vault_id, title, rel_path, doc_id) VALUES ($1, $2, $3, $4, $1)`, [
    id,
    vault,
    title,
    `${title}-${id.slice(0, 6)}.md`,
  ]);
  await pool.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content, vector) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, vault, title, content, JSON.stringify(embed(`${title}\n${content}`))],
  );
  return id;
}

const tokensOf = async (table: "note_index" | "blob_text", key: string, id: string) =>
  (await pool.query(`SELECT search_tokens FROM ${table} WHERE ${key} = $1`, [id])).rows[0].search_tokens as string | null;

describe("search_tokens fill for unkeyed vaults", () => {
  let org: string;
  let vault: string;
  let ids: string[];
  let fileBlob: string;
  let fileDoc: string;

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg("Fill", `fill-${randomUUID().slice(0, 8)}`);
    vault = await seedVault(org);
    ids = [];
    for (const [i, b] of BODIES.entries()) ids.push(await note(vault, `Note ${i}`, b));
    fileDoc = await seedFile(vault, null, "docs/q3.pdf");
    fileBlob = await seedBlob(vault, org, "docs/q3.pdf", { docId: fileDoc });
    const text = "Board pack: q3 revenue and hiring";
    await pool.query(
      `INSERT INTO blob_text (blob_id, vault_id, doc_id, chars, content, vector, source) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'client')`,
      [fileBlob, vault, fileDoc, text.length, text, JSON.stringify(embed(text))],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  const searchAll = () =>
    Promise.all(
      QUERIES.flatMap((query) =>
        (["app", "sql"] as const).map((keywordMode) =>
          searchNoteIndex({ vaultId: vault, query, k: 10, readableDocIds: [...ids, fileDoc], vaultWideReader: true, keywordMode }),
        ),
      ),
    );

  it("fills exactly the indexer's token sets and search answers the same", async () => {
    const before = await searchAll();
    expect(await fillSearchTokensPass("note_index", pool, { pauseMs: 0 })).toEqual({ scanned: 4, filled: 4 });
    expect(await fillSearchTokensPass("blob_text", pool, { pauseMs: 0 })).toEqual({ scanned: 1, filled: 1 });
    for (const [i, id] of ids.entries()) {
      expect(await tokensOf("note_index", "doc_id", id)).toBe(searchTokenSet(`Note ${i} ${BODIES[i]}`));
    }
    expect(await tokensOf("blob_text", "blob_id", fileBlob)).toBe(searchTokenSet("Board pack: q3 revenue and hiring"));
    expect(await searchAll()).toEqual(before);
    // Nothing left to do: a second pass reads nothing.
    expect(await fillSearchTokensPass("note_index", pool, { pauseMs: 0 })).toEqual({ scanned: 0, filled: 0 });
  });

  it("leaves over-bound, unsafe-lowercase, sealed and keyed-vault rows alone", async () => {
    const huge = await note(vault, "Huge", Array.from({ length: 12_000 }, (_, i) => `w${i.toString(36)}x`).join(" "));
    const unsafe = await note(vault, "Unsafe", "İstanbul notes");
    const sealed = await note(vault, "Sealed", "sealed body");
    await pool.query("UPDATE note_index SET search_enc = $2 WHERE doc_id = $1", [sealed, randomBytes(32)]);
    const otherVault = await seedVault(org, "Keyed");
    const keyedRow = await note(otherVault, "Keyed", "stale plaintext of a keyed vault");
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      otherVault,
      makeVkCheck(randomBytes(32), otherVault),
    ]);
    // Past the plaintext bound: the indexer writes NULL for it too.
    const hugeText = (await pool.query("SELECT title || ' ' || content AS t FROM note_index WHERE doc_id = $1", [huge])).rows[0].t;
    expect(hugeText.length).toBeGreaterThan(SEARCH_TOKENS_MAX);
    expect(searchTokenSet(hugeText)).toBeNull();

    await fillSearchTokensPass("note_index", pool, { pauseMs: 0 });
    for (const id of [huge, unsafe, sealed, keyedRow]) expect(await tokensOf("note_index", "doc_id", id)).toBeNull();
    for (const id of ids) expect(await tokensOf("note_index", "doc_id", id)).not.toBeNull();
  });

  it("a row re-indexed between the read and the write keeps the newer answer", async () => {
    const { rows } = await pool.query<{ stamp: string }>("SELECT updated_at::text AS stamp FROM note_index WHERE doc_id = $1", [ids[0]]);
    await pool.query("UPDATE note_index SET content = 'rewritten', updated_at = now() + interval '1 second' WHERE doc_id = $1", [ids[0]]);
    expect(await writeTokens("note_index", [{ id: ids[0], stamp: rows[0].stamp, tokens: "stale tokens" }])).toBe(0);
    expect(await tokensOf("note_index", "doc_id", ids[0])).toBeNull();
  });
});
