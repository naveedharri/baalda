import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { indexDoc } from "../src/index/indexer.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp } from "./helpers/auth.js";
import { seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

const app = createApp(testAppDeps());

/** Persist Yjs `content` for a doc the way a real client edit would. */
async function writeNoteBody(docId: string, body: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, body);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

function graph(token: string, vaultId: string) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/graph`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function search(token: string, vaultId: string, q: string, k?: number) {
  const url = new URL(`http://local/api/vaults/${vaultId}/search`);
  url.searchParams.set("q", q);
  if (k !== undefined) url.searchParams.set("k", String(k));
  return app.fetch(new Request(url, { headers: { authorization: `Bearer ${token}` } }));
}

describe("note index: graph + search endpoints", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("graph resolves wikilink targets by title/stem, leaves misses null", async () => {
    const owner = await signUp("owner@graph.com");
    const org = await createOrg(owner, "Acme", "acme-graph1");
    const vault = await seedVault(org.id);
    await seedVaultGrant(org.id, "edit");
    const alpha = await seedNote(vault, null, "Alpha.md");
    const beta = await seedNote(vault, null, "Beta.md");

    await writeNoteBody(alpha, "See [[Beta]] and [[Ghost]] here.");
    await indexDoc(alpha);
    await indexDoc(beta);

    const res = await graph(owner.token, vault);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ docId: string; title: string; relPath: string }>;
      links: Array<{ fromDoc: string; toTitle: string; toDocId: string | null }>;
    };

    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.map((n) => n.relPath).sort()).toEqual(["Alpha.md", "Beta.md"]);

    const byTitle = Object.fromEntries(body.links.map((l) => [l.toTitle, l]));
    expect(byTitle["Beta"].fromDoc).toBe(alpha);
    expect(byTitle["Beta"].toDocId).toBe(beta); // resolved by stem
    expect(byTitle["Ghost"].toDocId).toBeNull(); // dangling link
  });

  it("search ranks the semantically-matching note first", async () => {
    const owner = await signUp("owner@search.com");
    const org = await createOrg(owner, "Acme", "acme-search1");
    const vault = await seedVault(org.id);
    await seedVaultGrant(org.id, "edit");
    const dbNote = await seedNote(vault, null, "Databases.md");
    const cooking = await seedNote(vault, null, "Cooking.md");

    await writeNoteBody(dbNote, "postgres indexes vectors and cosine similarity search");
    await writeNoteBody(cooking, "recipes for pasta tomato basil and garlic bread");
    await indexDoc(dbNote);
    await indexDoc(cooking);

    const res = await search(owner.token, vault, "vector cosine search", 5);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: Array<{ docId: string; title: string; relPath: string; score: number }>;
    };
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe(dbNote);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("gates non-members (403) and unknown vaults (404)", async () => {
    const owner = await signUp("owner@graph2.com");
    const org = await createOrg(owner, "Acme", "acme-graph2");
    const vault = await seedVault(org.id);
    await seedVaultGrant(org.id, "edit");

    const stranger = await signUp("stranger@graph2.com");
    expect((await graph(stranger.token, vault)).status).toBe(403);
    expect((await search(stranger.token, vault, "x")).status).toBe(403);
    expect((await graph(owner.token, "no-such-vault")).status).toBe(404);
  });

  it("indexDoc is a no-op for a non-existent note", async () => {
    expect(await indexDoc("no-such-doc")).toBe(false);
  });
});
