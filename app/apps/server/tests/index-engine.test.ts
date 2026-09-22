import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseWikilinks } from "../src/index/indexer.js";
import {
  EMBED_DIM,
  cosineSimilarity,
  embed,
  l2normalize,
  localEmbedder,
  tokenize,
} from "../src/index/embedder.js";

describe("wikilink parsing", () => {
  it("extracts plain [[targets]]", () => {
    expect(parseWikilinks("see [[Alpha]] and [[Beta]]")).toEqual(["Alpha", "Beta"]);
  });

  it("takes the title before an alias | or heading #", () => {
    expect(parseWikilinks("[[Note|shown as this]]")).toEqual(["Note"]);
    expect(parseWikilinks("[[Note#Section]]")).toEqual(["Note"]);
    expect(parseWikilinks("[[Note#Section|alias]]")).toEqual(["Note"]);
  });

  it("trims whitespace and de-duplicates within a doc", () => {
    expect(parseWikilinks("[[  Spaced  ]] then [[Spaced]]")).toEqual(["Spaced"]);
  });

  it("returns nothing when there are no links", () => {
    expect(parseWikilinks("plain text, no links")).toEqual([]);
  });
});

describe("local embedder (default, offline)", () => {
  it("produces a fixed-dimension vector", () => {
    expect(embed("hello world")).toHaveLength(EMBED_DIM);
    expect(localEmbedder.dim).toBe(EMBED_DIM);
  });

  it("is deterministic — same text → identical vector", () => {
    expect(embed("the quick brown fox")).toEqual(embed("the quick brown fox"));
  });

  it("is case/tokenization-insensitive to the same word set", () => {
    expect(embed("Hello WORLD")).toEqual(embed("hello   world!"));
  });

  it("L2-normalizes non-empty text (unit length)", () => {
    const v = embed("alpha beta gamma alpha");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("returns an all-zero vector for text with no tokens", () => {
    const v = embed("   ---   ");
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("cosine similarity: identical text ≈ 1, disjoint vocab ≈ 0", () => {
    expect(cosineSimilarity(embed("database index vector"), embed("database index vector"))).toBeCloseTo(1, 6);
    const sim = cosineSimilarity(embed("apple banana cherry"), embed("xylophone yacht zeppelin"));
    expect(sim).toBeLessThan(0.2);
  });
});

describe("embedder helpers", () => {
  it("tokenize lowercases and splits on non-word chars", () => {
    expect(tokenize("Hello, World_2!")).toEqual(["hello", "world_2"]);
  });

  it("l2normalize leaves an all-zero vector unchanged", () => {
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("indexer — NUL bytes", () => {
  beforeEach(async () => {
    const { resetDb } = await import("./helpers/db.js");
    await resetDb();
  });
  it("indexes a note whose body contains U+0000 (Postgres text rejects it)", async () => {
    // One such note in production failed its own indexing AND every daily
    // checkpoint of its vault: `invalid byte sequence for encoding "UTF8": 0x00`.
    const { pool } = await import("../src/db/pool.js");
    const { indexDoc } = await import("../src/index/indexer.js");
    const { appendUpdate } = await import("../src/yjs/persistence.js");
    const { seedOrg, seedVault, seedNote } = await import("./helpers/seed.js");
    const Y = await import("yjs");
    const org = await seedOrg("Nul", "nul-org");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "nul.md");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "before\u0000after [[Target]]");
    await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
    doc.destroy();
    await expect(indexDoc(docId)).resolves.toBe(true);
    const { rows } = await pool.query<{ content: string }>(
      "SELECT content FROM note_index WHERE doc_id = $1",
      [docId],
    );
    expect(rows[0].content).toBe("beforeafter [[Target]]");
  });
});

/**
 * The boot backfill is the only self-heal the derived tables have, and the bulk
 * `docs/batch` path leans on it: that path hands its re-index to the 2 s
 * debounce, so a deploy or a crash inside that window drops a scheduled index on
 * the floor. Repairing only docs with NO row left a doc that already HAD one
 * describing its previous body — forever, since nothing re-indexes it until the
 * next edit. Staleness is `note_index.updated_at < notes.updated_at`.
 */
describe("indexer — boot backfill", () => {
  beforeEach(async () => {
    const { resetDb } = await import("./helpers/db.js");
    await resetDb();
  });
  it("re-indexes a stale row, leaves an up-to-date one alone, and fills a missing one", async () => {
    const { pool } = await import("../src/db/pool.js");
    const { backfillIndex, indexDoc } = await import("../src/index/indexer.js");
    const { appendUpdate } = await import("../src/yjs/persistence.js");
    const { seedOrg, seedVault, seedNote } = await import("./helpers/seed.js");
    const Y = await import("yjs");

    const write = async (docId: string, text: string) => {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, text);
      await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    };
    const indexedContent = async (docId: string): Promise<string | undefined> =>
      (
        await pool.query<{ content: string }>(
          "SELECT content FROM note_index WHERE doc_id = $1",
          [docId],
        )
      ).rows[0]?.content;

    const org = await seedOrg("Backfill", "backfill-org");
    const vault = await seedVault(org);
    const stale = await seedNote(vault, null, "stale.md");
    const fresh = await seedNote(vault, null, "fresh.md");
    const missing = await seedNote(vault, null, "missing.md");

    await write(stale, "first body");
    await write(fresh, "unchanged body");
    await write(missing, "never indexed");
    await indexDoc(stale);
    await indexDoc(fresh);

    // The stale one: its body moved on (a batch push whose debounced index was
    // lost to a restart) and the note row was stamped, but note_index was not.
    await write(stale, " — rewritten by an agent");
    await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [stale]);

    expect(await indexedContent(stale)).toBe("first body");
    const freshBefore = (
      await pool.query<{ updated_at: Date }>(
        "SELECT updated_at FROM note_index WHERE doc_id = $1",
        [fresh],
      )
    ).rows[0].updated_at.getTime();

    expect(await backfillIndex()).toBe(2); // the stale one and the missing one

    expect(await indexedContent(stale)).toContain("rewritten by an agent");
    expect(await indexedContent(missing)).toBe("never indexed");
    const freshAfter = (
      await pool.query<{ updated_at: Date }>(
        "SELECT updated_at FROM note_index WHERE doc_id = $1",
        [fresh],
      )
    ).rows[0].updated_at.getTime();
    expect(freshAfter).toBe(freshBefore); // untouched
  });
});

// One close for the whole file: both DB-backed suites above share the pool, and
// a second `end()` throws.
afterAll(async () => {
  const { pool } = await import("../src/db/pool.js");
  await pool.end();
});
