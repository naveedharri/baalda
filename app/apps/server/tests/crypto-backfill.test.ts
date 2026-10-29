// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate, compact, loadDocState } from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import {
  backfillHooks,
  backfillTick,
  backfillVault,
  catchUpIndex,
  encryptionStatus,
  kickVaultBackfill,
} from "../src/crypto/backfill.js";
import { indexDoc, searchNoteIndex } from "../src/index/indexer.js";
import { openBlobTextRow, openSearchRow, sealSearchRow } from "../src/index/sealed-index.js";
import { resolveText, storeNoteText } from "../src/versions/texts.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedBlobText, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

const FAST = { throttleMs: 0 };

function edit(doc: Y.Doc, text: string): Uint8Array {
  let u: Uint8Array | null = null;
  const h = (x: Uint8Array) => (u = x);
  doc.on("update", h);
  doc.getText("content").insert(doc.getText("content").length, text);
  doc.off("update", h);
  return u!;
}

function textOf(state: Uint8Array | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  const t = d.getText("content").toString();
  d.destroy();
  return t;
}

/** An UNKEYED vault with plaintext history in every sealable table. */
async function plaintextVault(notes = 3) {
  const orgId = await seedOrg("Legacy", `legacy-${Date.now()}-${Math.random()}`);
  const vaultId = await seedVault(orgId);
  const docIds: string[] = [];
  for (let i = 0; i < notes; i++) {
    const docId = await seedNote(vaultId, null, `note-${i}.md`);
    const doc = new Y.Doc();
    // A compacted snapshot plus a plaintext log on top of it.
    for (let j = 0; j < 3; j++) await appendUpdate(docId, edit(doc, `note ${i} line ${j} quarterly\n`), pool, 1000);
    await compact(docId, pool);
    for (let j = 3; j < 5; j++) await appendUpdate(docId, edit(doc, `note ${i} line ${j} budget\n`), pool, 1000);
    doc.destroy();
    await indexDoc(docId, pool);
    await storeNoteText(pool, { vaultId, docId, sha: `sha-${i}`, content: `version ${i} of the plan` });
    docIds.push(docId);
  }
  const blobId = await seedBlob(vaultId, orgId, "report.pdf");
  await seedBlobText(blobId, vaultId, null, "quarterly budget attachment text");
  return { orgId, vaultId, docIds, blobId };
}

/** Key the vault (as `keys/init` does) and hold the key as a connected member would. */
async function keyVault(vaultId: string, hold = true): Promise<DocCrypto> {
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(key, vaultId),
  ]);
  await pool.query(
    "INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)",
    [vaultId],
  );
  if (hold) vaultKeyCache.acquire(vaultId, key, 1);
  return { vaultId, key, generation: 1 };
}

async function plaintextSnapshot(vaultId: string) {
  const q = (sql: string) => pool.query(sql, [vaultId]).then((r) => r.rows);
  const docs = `(SELECT id FROM notes WHERE vault_id = $1)`;
  return {
    updates: await q(`SELECT id, update FROM doc_updates WHERE doc_id IN ${docs} ORDER BY id`),
    snaps: await q(`SELECT doc_id, snapshot FROM doc_snapshots WHERE doc_id IN ${docs} ORDER BY doc_id`),
    index: await q(`SELECT doc_id, content, vector, search_tokens FROM note_index WHERE vault_id = $1 ORDER BY doc_id`),
    blobText: await q(`SELECT blob_id, content, vector, search_tokens FROM blob_text WHERE vault_id = $1`),
    texts: await q(`SELECT doc_id, sha256, content FROM note_texts WHERE vault_id = $1 ORDER BY doc_id`),
  };
}

async function reads(vaultId: string, docIds: string[], c: DocCrypto) {
  const states = [];
  for (const d of docIds) states.push(Buffer.from((await loadDocState(d, pool, c))!).toString("base64"));
  const search = await searchNoteIndex({
    vaultId,
    query: "quarterly budget",
    k: 20,
    readableDocIds: docIds,
    vaultWideReader: true,
    crypto: c,
  } as Parameters<typeof searchNoteIndex>[0]);
  const { rows } = await pool.query(
    `SELECT doc_id, sha256, content, content_enc FROM note_texts WHERE vault_id = $1 ORDER BY doc_id`,
    [vaultId],
  );
  const texts = rows.map((r) => resolveText(r, { vaultId, docId: r.doc_id, sha: r.sha256 }, c));
  return { states, search, texts };
}

describe("vault crypto backfill (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
    backfillHooks.beforeWrite = () => {};
    backfillHooks.tamper = (_t, s) => s;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("seals every row, reads are identical before/after, plaintext is kept", async () => {
    const { vaultId, docIds, blobId } = await plaintextVault();
    const c = await keyVault(vaultId);
    const before = await reads(vaultId, docIds, c);
    const plainBefore = await plaintextSnapshot(vaultId);
    const status0 = await encryptionStatus(vaultId);
    expect(status0.total).toBeGreaterThan(0);
    expect(status0.remaining.doc_updates).toBe(6);
    expect(status0.remaining.doc_snapshots).toBe(3);

    expect(await backfillVault(vaultId, FAST)).toBe("complete");

    expect((await encryptionStatus(vaultId)).total).toBe(0);
    // No plaintext was nulled, rewritten or deleted.
    expect(await plaintextSnapshot(vaultId)).toEqual(plainBefore);
    // Every row now has a sealed copy, and readers (which prefer it) see the same.
    const after = await reads(vaultId, docIds, c);
    expect(after).toEqual(before);
    const { rows: bt } = await pool.query("SELECT search_enc, content FROM blob_text WHERE blob_id = $1", [blobId]);
    expect(openBlobTextRow(c, blobId, bt[0].search_enc).body).toBe(bt[0].content);
    const { rows: u } = await pool.query(
      "SELECT count(*)::int AS n FROM doc_updates WHERE update_enc IS NULL OR update IS NULL",
    );
    expect(u[0].n).toBe(0);
  });

  it("resumes from persisted cursors after an interruption", async () => {
    const { vaultId, docIds } = await plaintextVault(4);
    const c = await keyVault(vaultId);
    const before = await reads(vaultId, docIds, c);
    expect(await backfillVault(vaultId, { ...FAST, batchSize: 2, maxBatches: 2 })).toBe("budget");
    const { rows } = await pool.query("SELECT cursors FROM vault_crypto_state WHERE vault_id = $1", [vaultId]);
    expect(rows[0].cursors.tables.doc_updates.after).toBeTruthy();
    const mid = await encryptionStatus(vaultId);
    expect(mid.remaining.doc_updates).toBe(8 - 4);
    // Key evicted mid-run: stops, nothing lost, then resumes once a member is back.
    const key = Buffer.from(c.key);
    vaultKeyCache.evict(vaultId);
    expect(await backfillVault(vaultId, FAST)).toBe("no_key");
    vaultKeyCache.acquire(vaultId, key, 1);
    expect(await backfillVault(vaultId, { ...FAST, batchSize: 3 })).toBe("complete");
    expect((await encryptionStatus(vaultId)).total).toBe(0);
    expect(await reads(vaultId, docIds, c)).toEqual(before);
  });

  it("does nothing without a cached key, and never touches an unkeyed vault", async () => {
    const keyed = await plaintextVault(1);
    await keyVault(keyed.vaultId, false);
    const plain = await plaintextVault(1);
    // A key for the UNKEYED vault in the cache must not make it sealable.
    vaultKeyCache.acquire(plain.vaultId, randomBytes(32), 1);
    expect(await backfillVault(keyed.vaultId, FAST)).toBe("no_key");
    expect(await backfillVault(plain.vaultId, FAST)).toBe("not_keyed");
    await backfillTick(FAST);
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM doc_updates WHERE update_enc IS NOT NULL)
            + (SELECT count(*) FROM doc_snapshots WHERE snapshot_enc IS NOT NULL)
            + (SELECT count(*) FROM note_index WHERE search_enc IS NOT NULL AND vault_id = ANY($1))
            + (SELECT count(*) FROM blob_text WHERE search_enc IS NOT NULL)
            + (SELECT count(*) FROM note_texts WHERE content_enc IS NOT NULL) AS n`,
      [[keyed.vaultId, plain.vaultId]],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("flag off: does nothing", async () => {
    const { vaultId } = await plaintextVault(1);
    await keyVault(vaultId);
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect(await backfillVault(vaultId, FAST)).toBe("disabled");
    expect((await encryptionStatus(vaultId)).total).toBeGreaterThan(0);
  });

  it("a seal that does not verify is never written", async () => {
    const { vaultId } = await plaintextVault(1);
    await keyVault(vaultId);
    const total = (await encryptionStatus(vaultId)).total;
    backfillHooks.tamper = (_t, s) => {
      const bad = Buffer.from(s);
      bad[bad.length - 1] ^= 0xff;
      return bad;
    };
    expect(await backfillVault(vaultId, FAST)).toBe("stalled");
    expect((await encryptionStatus(vaultId)).total).toBe(total);
  });

  it("a keyed re-index during the backfill wins over the stale sealed copy", async () => {
    const { vaultId, docIds } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    const target = docIds[0];
    backfillHooks.beforeWrite = async (table, rowKey) => {
      if (table !== "note_index" || rowKey !== target) return;
      backfillHooks.beforeWrite = () => {};
      // Exactly the keyed indexer's write: search_enc only, plaintext untouched.
      await pool.query(
        "UPDATE note_index SET search_enc = $2, updated_at = now() WHERE doc_id = $1",
        [target, sealSearchRow(c, target, { body: "NEWER TEXT", vector: [], tokens: null })],
      );
    };
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    const { rows } = await pool.query("SELECT search_enc, content FROM note_index WHERE doc_id = $1", [target]);
    expect(openSearchRow(c, target, rows[0].search_enc).body).toBe("NEWER TEXT");
    expect(rows[0].content).toContain("note 0 line 0");
  });

  it("a plaintext rewrite during the backfill is skipped, then sealed on the re-pass", async () => {
    const { vaultId, docIds } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    const target = docIds[1];
    let fired = false;
    backfillHooks.beforeWrite = async (table, rowKey) => {
      if (fired) return;
      if (table === "note_index" && rowKey === target) {
        fired = true;
        await pool.query(
          "UPDATE note_index SET content = 'rewritten body', updated_at = now() WHERE doc_id = $1",
          [target],
        );
      }
    };
    // Snapshot replaced under the backfill (a compaction from before keying).
    let snapFired = false;
    const prev = backfillHooks.beforeWrite;
    backfillHooks.beforeWrite = async (table, rowKey) => {
      await prev(table, rowKey);
      if (snapFired || table !== "doc_snapshots" || rowKey !== target) return;
      snapFired = true;
      const merged = Y.encodeStateAsUpdate(
        (() => {
          const d = new Y.Doc();
          d.getText("content").insert(0, "replacement snapshot");
          return d;
        })(),
      );
      await pool.query("UPDATE doc_snapshots SET snapshot = $2, seq = seq + 1 WHERE doc_id = $1", [
        target,
        Buffer.from(merged),
      ]);
    };
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    expect(fired && snapFired).toBe(true);
    const { rows } = await pool.query("SELECT search_enc, content FROM note_index WHERE doc_id = $1", [target]);
    expect(openSearchRow(c, target, rows[0].search_enc).body).toBe("rewritten body");
    const { rows: s } = await pool.query(
      "SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1",
      [target],
    );
    // The sealed copy is of the NEW snapshot, never the stale one.
    expect(textOf(new Uint8Array(s[0].snapshot))).toBe("replacement snapshot");
    const { openDocBytes } = await import("../src/crypto/doc-crypto.js");
    expect(openDocBytes(c, "doc_snapshots.snapshot", target, s[0].snapshot_enc, null)!.equals(s[0].snapshot)).toBe(true);
  });

  it("concurrent appends + compaction during the backfill never lose or revert data", async () => {
    const { vaultId, docIds } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    const target = docIds[0];
    const live = new Y.Doc();
    Y.applyUpdate(live, (await loadDocState(target, pool, c))!);
    const originalIds = (
      await pool.query("SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id", [target])
    ).rows.map((r) => r.id);
    let n = 0;
    backfillHooks.beforeWrite = async (table) => {
      if (n >= 6 || (table !== "doc_updates" && table !== "doc_snapshots")) return;
      n += 1;
      await appendUpdate(target, edit(live, `concurrent ${n}\n`), pool, 2, c);
      await compact(target, pool, c);
      await compact(target, pool);
    };
    expect(await backfillVault(vaultId, { ...FAST, batchSize: 1 })).toBe("complete");
    // After the backfill every plaintext row also has a sealed copy. Further
    // edits + compaction must still not fold them away (that would be a null-out).
    for (let i = 0; i < 4; i++) await appendUpdate(target, edit(live, `after ${i}\n`), pool, 2, c);
    await compact(target, pool, c);
    await compact(target, pool);
    const want = live.getText("content").toString();
    expect(want).toContain("concurrent 6");
    expect(want).toContain("after 3");
    expect(textOf(await loadDocState(target, pool, c))).toBe(want);
    // Every original plaintext row survives, with a sealed copy equal to it.
    const { rows } = await pool.query(
      "SELECT id, update, update_enc FROM doc_updates WHERE id = ANY($1::bigint[]) ORDER BY id",
      [originalIds],
    );
    expect(rows.length).toBe(originalIds.length);
    const { openDocBytes } = await import("../src/crypto/doc-crypto.js");
    for (const r of rows) {
      expect(r.update).not.toBeNull();
      expect(openDocBytes(c, "doc_updates.update", target, r.update_enc, null)!.equals(r.update)).toBe(true);
    }
    const { rows: snap } = await pool.query("SELECT snapshot FROM doc_snapshots WHERE doc_id = $1", [target]);
    expect(snap[0].snapshot).not.toBeNull();
    live.destroy();
  });

  it("indexes notes the keyed indexer skipped while no key was held", async () => {
    const orgId = await seedOrg("Keyless", `keyless-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    const c = await keyVault(vaultId, false);
    const docId = await seedNote(vaultId, null, "written-keyless.md");
    const doc = new Y.Doc();
    await appendUpdate(docId, edit(doc, "zebra migration notes\n"), pool, 1000, c);
    doc.destroy();
    // No key cached: the indexer defers and writes nothing.
    expect(await indexDoc(docId, pool)).toBe(false);
    expect((await pool.query("SELECT 1 FROM note_index WHERE doc_id = $1", [docId])).rowCount).toBe(0);
    // A member connects: the key reaches the cache, the vault is kicked.
    vaultKeyCache.acquire(vaultId, c.key, 1);
    await kickVaultBackfill(vaultId, FAST);
    const { rows } = await pool.query("SELECT content, search_enc FROM note_index WHERE doc_id = $1", [docId]);
    expect(rows.length).toBe(1);
    expect(rows[0].search_enc).not.toBeNull();
    expect(rows[0].content).toBe("");
    expect(openSearchRow(c, docId, rows[0].search_enc).body).toContain("zebra migration");
    const hits = await searchNoteIndex({
      vaultId,
      query: "zebra",
      k: 5,
      readableDocIds: [docId],
      vaultWideReader: true,
      crypto: c,
    } as Parameters<typeof searchNoteIndex>[0]);
    expect(hits.map((h) => h.docId)).toContain(docId);
  });

  it("a deferred index is queued, drained on key arrival, and the row removed", async () => {
    const orgId = await seedOrg("Queue", `queue-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    const c = await keyVault(vaultId, false);
    const docId = await seedNote(vaultId, null, "queued.md");
    const doc = new Y.Doc();
    await appendUpdate(docId, edit(doc, "okapi field notes\n"), pool, 1000, c);
    doc.destroy();
    expect(await indexDoc(docId, pool)).toBe(false);
    const q1 = await pool.query("SELECT vault_id FROM index_pending WHERE doc_id = $1", [docId]);
    expect(q1.rows).toEqual([{ vault_id: vaultId }]);
    vaultKeyCache.acquire(vaultId, c.key, 1);
    expect(await catchUpIndex(vaultId, pool)).toBe(1);
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(0);
    const { rows } = await pool.query("SELECT search_enc FROM note_index WHERE doc_id = $1", [docId]);
    expect(openSearchRow(c, docId, rows[0].search_enc).body).toContain("okapi");
  });

  it("a failed catch-up keeps the pending row", async () => {
    const orgId = await seedOrg("QueueFail", `queuefail-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    const c = await keyVault(vaultId, false);
    const docId = await seedNote(vaultId, null, "fails.md");
    expect(await indexDoc(docId, pool)).toBe(false);
    vaultKeyCache.acquire(vaultId, c.key, 1);
    const failing = {
      query: (sql: string, params?: unknown[]) => {
        if (/INSERT INTO note_index/.test(sql)) return Promise.reject(new Error("boom"));
        return pool.query(sql, params as unknown[]);
      },
    } as unknown as typeof pool;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await catchUpIndex(vaultId, failing)).toBe(0);
    spy.mockRestore();
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(1);
    // Still deferred (no key) during a drain: the row is re-queued, not lost.
    vaultKeyCache.clear();
    expect(await catchUpIndex(vaultId, pool)).toBe(0);
    expect((await pool.query("SELECT 1 FROM index_pending WHERE doc_id = $1", [docId])).rowCount).toBe(1);
  });

  it("an idle sealed vault's key arrival runs no per-note queries", async () => {
    const orgId = await seedOrg("Idle", `idle-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    await keyVault(vaultId);
    for (let i = 0; i < 5; i++) await seedNote(vaultId, null, `idle-${i}.md`);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    await pool.query("DELETE FROM index_pending WHERE vault_id = $1", [vaultId]);
    const seen: string[] = [];
    const counting = {
      query: (sql: string, params?: unknown[]) => {
        seen.push(sql);
        return pool.query(sql, params as unknown[]);
      },
      connect: () => pool.connect(),
    } as unknown as typeof pool;
    await kickVaultBackfill(vaultId, { ...FAST, db: counting });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/EXISTS \(SELECT 1 FROM index_pending/);
    expect(seen.some((s) => /doc_updates/.test(s))).toBe(false);
  });

  it("one runner per vault: a held lock answers 'locked'", async () => {
    const { vaultId } = await plaintextVault(1);
    await keyVault(vaultId);
    const other = await pool.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`crypto-backfill:${vaultId}`]);
      expect(await backfillVault(vaultId, FAST)).toBe("locked");
      await other.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`crypto-backfill:${vaultId}`]);
    } finally {
      other.release();
    }
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
  });
});
