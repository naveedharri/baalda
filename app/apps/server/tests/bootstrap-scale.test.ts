import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, createOrg, type TestUser } from "./helpers/auth.js";
import { seedVault, seedVaultGrant } from "./helpers/seed.js";
import { createBootstrapSession, loadBootstrapPage } from "../src/yjs/bootstrap.js";
import { decodeBootstrapPage } from "../src/sync/bulk-protocol.js";
import { config } from "../src/config.js";

/**
 * 5,000 synthetic notes — the size the whole engine exists for.
 *
 * Two numbers matter, and neither is wall clock:
 *
 *  · **queries per page is CONSTANT.** The old path was one `loadDocDiff` per
 *    doc (probe + snapshot read + full log read + merge + diff) at width 6. If
 *    this loader ever goes per-doc again the assertion below catches it at 5,000
 *    docs rather than in production at 50,000.
 *  · **every doc arrives exactly once.** The session materialises the doc list
 *    so a page cannot see a different set than its predecessor did; this is the
 *    test that says so at a size where an off-by-one in the cursor would show.
 */

const DOCS = 5000;

describe("bootstrap at 5,000 docs", () => {
  let owner: TestUser;
  let vault: string;

  beforeAll(async () => {
    await resetDb();
    owner = await signUp("owner@scale.test");
    const org = (await createOrg(owner, "Scale Co", "scale-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");

    // Notes first, in one multi-row insert per 500 — seeding is not what is
    // being measured, so it must not dominate the run.
    const ids = Array.from({ length: DOCS }, () => randomUUID());
    for (let i = 0; i < DOCS; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const values = chunk
        .map((_, k) => `($${k * 3 + 1}, $${chunk.length * 3 + 1}, $${k * 3 + 2}, $${k * 3 + 3}, $${k * 3 + 1})`)
        .join(",");
      const params: unknown[] = [];
      chunk.forEach((id, k) => {
        const path = `Notes/n${String(i + k).padStart(5, "0")}.md`;
        params.push(id, path, path);
        void k;
      });
      params.push(vault);
      await pool.query(
        `INSERT INTO notes (id, vault_id, rel_path, title, doc_id) VALUES ${values}`,
        params,
      );
    }
    // A realistic size distribution: most notes are small, a long tail is not.
    for (let i = 0; i < DOCS; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows: Array<[string, Buffer]> = chunk.map((id, k) => {
        const n = i + k;
        const doc = new Y.Doc();
        doc.getText("content").insert(0, "x".repeat(n % 50 === 0 ? 20_000 : 400));
        const update = Buffer.from(Y.encodeStateAsUpdate(doc));
        doc.destroy();
        return [id, update];
      });
      await pool.query(
        `INSERT INTO doc_updates (doc_id, update)
         SELECT * FROM unnest($1::text[], $2::bytea[])`,
        [rows.map((r) => r[0]), rows.map((r) => r[1])],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool.end();
  });

  it("drains 5,000 docs exactly once, with a constant query count per page", async () => {
    const t0 = Date.now();
    const session = await createBootstrapSession({ vaultId: vault, userId: owner.userId });
    const sessionMs = Date.now() - t0;
    expect(session.docs).toBe(DOCS);
    expect(session.emptyDocs).toEqual([]);

    const seen = new Set<string>();
    const perPageQueries: number[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    let gzipBytes = 0;
    const t1 = Date.now();
    while (cursor !== null) {
      let queries = 0;
      const page = await loadBootstrapPage({
        sessionId: session.sessionId,
        vaultId: vault,
        userId: owner.userId,
        cursor,
        onQuery: () => queries++,
      });
      perPageQueries.push(queries);
      gzipBytes += page.body.length;
      for (const d of decodeBootstrapPage(gunzipSync(page.body))) {
        expect(seen.has(d.docId)).toBe(false); // exactly once
        seen.add(d.docId);
      }
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(500); // a cursor that stopped advancing
    }
    const drainMs = Date.now() - t1;

    expect(seen.size).toBe(DOCS);
    // 5 statements a page — session check, keyset read, snapshots, updates,
    // paths — no matter how many docs the page carried.
    expect(new Set(perPageQueries)).toEqual(new Set([5]));
    expect(pages).toBeLessThanOrEqual(Math.ceil(DOCS / config.bootstrapMaxPageDocs) + 4);

    console.log(
      `[scale] ${DOCS} docs · session ${sessionMs}ms · drain ${drainMs}ms · ${pages} pages · ` +
        `${(session.bytes / 1e6).toFixed(1)}MB raw → ${(gzipBytes / 1e6).toFixed(1)}MB gzip · ` +
        `${perPageQueries.length * 5} queries total`,
    );
  }, 300_000);
});
