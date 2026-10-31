// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate, compact, countUpdates, loadDocDiff, loadDocState } from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { openDocBytes, sealDocBytes, type DocCrypto } from "../src/crypto/doc-crypto.js";
import { backfillVault, encryptionStatus } from "../src/crypto/backfill.js";
import {
  encryptionProgress,
  nullOutHooks,
  nullOutVault,
  plaintextStatus,
} from "../src/crypto/null-out.js";
import { indexDoc, searchNoteIndex } from "../src/index/indexer.js";
import { openBlobTextRow, sealSearchRow } from "../src/index/sealed-index.js";
import { resolveText, storeNoteText, VERSION_CONTENT, VERSION_CONTENT_ENC, VERSION_TEXT_JOIN } from "../src/versions/texts.js";
import { sha256Hex } from "../src/versions/capture.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedBlobText, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

const FAST = { throttleMs: 0 };
/** Tests call the worker several times within the hourly recheck window. */
const RUN = { throttleMs: 0, force: true };
/** Unique per test: rows of earlier tests' vaults outlive `resetDb` (note_index has no FK). */
let SECRET = "zanzibarsecretword";

function edit(doc: Y.Doc, text: string): Uint8Array {
  let u: Uint8Array | null = null;
  const h = (x: Uint8Array) => (u = x);
  doc.on("update", h);
  doc.getText("content").insert(doc.getText("content").length, text);
  doc.off("update", h);
  return u!;
}

function textOf(state: Uint8Array | Buffer | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, new Uint8Array(state));
  const t = d.getText("content").toString();
  d.destroy();
  return t;
}

/** An unkeyed vault with plaintext in every table the null-out covers. */
async function plaintextVault(notes = 2) {
  const orgId = await seedOrg("Legacy", `legacy-${Date.now()}-${Math.random()}`);
  const vaultId = await seedVault(orgId);
  const docIds: string[] = [];
  const live: Y.Doc[] = [];
  for (let i = 0; i < notes; i++) {
    const docId = await seedNote(vaultId, null, `note-${i}.md`);
    const doc = new Y.Doc();
    for (let j = 0; j < 3; j++) await appendUpdate(docId, edit(doc, `note ${i} line ${j} ${SECRET}\n`), pool, 1000);
    await compact(docId, pool);
    for (let j = 3; j < 5; j++) await appendUpdate(docId, edit(doc, `note ${i} line ${j} budget\n`), pool, 1000);
    await indexDoc(docId, pool);
    const text = `version ${i} ${SECRET}`;
    await storeNoteText(pool, { vaultId, docId, sha: sha256Hex(text), content: text });
    // A pre-038 inline version (no note_texts row of its own).
    const inline = `inline version ${i} ${SECRET}`;
    await pool.query(
      "INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause) VALUES ($1, $2, $3, $4, 'idle')",
      [docId, vaultId, inline, sha256Hex(inline)],
    );
    docIds.push(docId);
    live.push(doc);
  }
  // A pre-038 checkpoint with an inline text.
  const cpId = `cp-${Math.random().toString(36).slice(2)}`;
  await pool.query("INSERT INTO vault_checkpoints (id, vault_id, kind) VALUES ($1, $2, 'auto')", [cpId, vaultId]);
  const cpText = `checkpoint text ${SECRET}`;
  await pool.query(
    "INSERT INTO vault_checkpoint_docs (checkpoint_id, doc_id, sha256, content) VALUES ($1, $2, $3, $4)",
    [cpId, docIds[0], sha256Hex(cpText), cpText],
  );
  const blobId = await seedBlob(vaultId, orgId, "report.pdf");
  await seedBlobText(blobId, vaultId, null, `attachment text ${SECRET}`);
  return { orgId, vaultId, docIds, live, blobId };
}

async function keyVault(vaultId: string, hold = true): Promise<DocCrypto> {
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(key, vaultId),
  ]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  if (hold) vaultKeyCache.acquire(vaultId, key, 1);
  return { vaultId, key, generation: 1 };
}

async function versionTexts(vaultId: string, c: DocCrypto): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT v.doc_id, v.sha256, ${VERSION_CONTENT} AS content, ${VERSION_CONTENT_ENC} AS content_enc
       FROM note_versions v ${VERSION_TEXT_JOIN} WHERE v.vault_id = $1 ORDER BY v.id`,
    [vaultId],
  );
  return rows.map((r) => resolveText(r, { vaultId, docId: r.doc_id, sha: r.sha256 }, c) ?? "");
}

async function reads(vaultId: string, docIds: string[], blobId: string, c: DocCrypto) {
  const states: string[] = [];
  const diffs: string[] = [];
  for (const d of docIds) {
    states.push(textOf(await loadDocState(d, pool, c)));
    diffs.push(textOf((await loadDocDiff(d, null, pool, c))!.update));
  }
  const search = await searchNoteIndex({
    vaultId,
    query: `${SECRET} budget`,
    k: 20,
    readableDocIds: docIds,
    vaultWideReader: true,
    crypto: c,
  } as Parameters<typeof searchNoteIndex>[0]);
  const { rows: t } = await pool.query(
    "SELECT doc_id, sha256, content, content_enc FROM note_texts WHERE vault_id = $1 ORDER BY doc_id, sha256",
    [vaultId],
  );
  const texts = t.map((r) => resolveText(r, { vaultId, docId: r.doc_id, sha: r.sha256 }, c));
  const { rows: b } = await pool.query("SELECT content, search_enc FROM blob_text WHERE blob_id = $1", [blobId]);
  const blob = b[0].search_enc ? openBlobTextRow(c, blobId, b[0].search_enc).body : b[0].content;
  const { rows: cp } = await pool.query(
    `SELECT d.doc_id, d.sha256, COALESCE(d.content, t.content) AS content,
            CASE WHEN d.content IS NULL THEN t.content_enc END AS content_enc
       FROM vault_checkpoint_docs d JOIN vault_checkpoints k ON k.id = d.checkpoint_id
       LEFT JOIN note_texts t ON t.doc_id = d.doc_id AND t.sha256 = d.sha256
      WHERE k.vault_id = $1`,
    [vaultId],
  );
  return {
    checkpoints: cp.map((r) => resolveText(r, { vaultId, docId: r.doc_id, sha: r.sha256 }, c)),
    states,
    diffs,
    search: search.map((h: { docId?: string; id?: string }) => h.docId ?? h.id).sort(),
    texts,
    versions: await versionTexts(vaultId, c),
    blob,
  };
}

/** Every row of every public table, as text (bytea as hex): a dump grep without pg_dump. */
async function dumpHits(needle: string): Promise<string[]> {
  const hex = Buffer.from(needle, "utf8").toString("hex");
  const { rows: tables } = await pool.query<{ t: string }>(
    "SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  const hits: string[] = [];
  for (const { t } of tables) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${t} x WHERE strpos(x::text, $1) > 0 OR strpos(x::text, $2) > 0`,
      [needle, hex],
    );
    if (Number(rows[0].n) > 0) hits.push(`${t}:${rows[0].n}`);
  }
  return hits;
}

describe("plaintext null-out + converting compaction (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("VAULT_PLAINTEXT_RETENTION_DAYS", "0");
    await resetDb();
    vaultKeyCache.clear();
    nullOutHooks.beforeWrite = () => {};
    SECRET = `zanzibar${randomBytes(6).toString("hex")}secret`;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("compacts a converting doc: same content, bounded log, no new plaintext, no churn", async () => {
    const { vaultId, docIds, live } = await plaintextVault(1);
    const c = await keyVault(vaultId);
    const [docId] = docIds;
    // Before the backfill (plaintext rows without sealed copies) and after.
    for (let i = 0; i < 12; i++) await appendUpdate(docId, edit(live[0], `keyed edit ${i}\n`), pool, 4, c);
    expect(await countUpdates(docId)).toBeLessThanOrEqual(5);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    for (let i = 12; i < 40; i++) await appendUpdate(docId, edit(live[0], `keyed edit ${i}\n`), pool, 4, c);
    expect(await countUpdates(docId)).toBeLessThanOrEqual(5);
    expect(textOf(await loadDocState(docId, pool, c))).toBe(live[0].getText("content").toString());

    // Exactly one plaintext row: the pre-keying text, dual and byte-equal.
    const { rows } = await pool.query(
      "SELECT id, update, update_enc FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL",
      [docId],
    );
    expect(rows).toHaveLength(1);
    expect(openDocBytes(c, "doc_updates.update", docId, rows[0].update_enc, null)!.equals(rows[0].update)).toBe(true);
    const legacy = textOf(rows[0].update);
    expect(legacy).toContain("note 0 line 4 budget");
    expect(legacy).not.toContain("keyed edit");
    const { rows: snap } = await pool.query("SELECT snapshot FROM doc_snapshots WHERE doc_id = $1", [docId]);
    expect(snap[0].snapshot).toBeNull();
    // A further compaction keeps that row in place (same id).
    await appendUpdate(docId, edit(live[0], "one more\n"), pool, 1000, c);
    await compact(docId, pool, c);
    const { rows: again } = await pool.query("SELECT id FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL", [docId]);
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(textOf(await loadDocState(docId, pool, c))).toBe(live[0].getText("content").toString());
  });

  it("a dual row whose sealed copy differs blocks compaction entirely (fail closed)", async () => {
    const { vaultId, docIds, live } = await plaintextVault(1);
    const c = await keyVault(vaultId);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    const [docId] = docIds;
    const { rows } = await pool.query("SELECT id FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL ORDER BY id LIMIT 1", [docId]);
    await pool.query("UPDATE doc_updates SET update_enc = $2 WHERE id = $1", [
      rows[0].id,
      sealDocBytes(c, "doc_updates.update", docId, Buffer.from("other")),
    ]);
    const before = await pool.query("SELECT id, update, update_enc FROM doc_updates WHERE doc_id = $1 ORDER BY id", [docId]);
    await appendUpdate(docId, edit(live[0], "x\n"), pool, 1000, c);
    await compact(docId, pool, c);
    const after = await pool.query("SELECT id, update, update_enc FROM doc_updates WHERE doc_id = $1 AND id <= $2 ORDER BY id", [
      docId,
      before.rows.at(-1).id,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it("waits for the retention delay, then clears only verified plaintext; reads stay identical", async () => {
    const { vaultId, docIds, blobId } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    expect((await encryptionStatus(vaultId)).total).toBe(0);
    const before = await reads(vaultId, docIds, blobId, c);
    expect(before.versions.some((v) => v.startsWith("inline version"))).toBe(true);
    expect(before.checkpoints).toEqual([`checkpoint text ${SECRET}`]);

    vi.stubEnv("VAULT_PLAINTEXT_RETENTION_DAYS", "30");
    expect(await nullOutVault(vaultId, RUN)).toBe("waiting");
    expect((await plaintextStatus(vaultId)).total).toBeGreaterThan(0);
    expect(await encryptionProgress(vaultId)).toMatchObject({ fullyEncrypted: false });
    // Exactly at the boundary later: still waiting one ms before, runs after.
    const { rows: s } = await pool.query("SELECT cursors->>'completedAt' AS at FROM vault_crypto_state WHERE vault_id = $1", [vaultId]);
    const done = Date.parse(s[0].at);
    const day = 24 * 60 * 60_000;
    expect(await nullOutVault(vaultId, { ...RUN, now: () => done + 30 * day - 1 })).toBe("waiting");
    expect(await nullOutVault(vaultId, { ...RUN, now: () => done + 30 * day })).toBe("sealed");

    expect((await plaintextStatus(vaultId)).total).toBe(0);
    expect(await encryptionProgress(vaultId)).toEqual({ fullyEncrypted: true, plaintextRemaining: 0 });
    expect(await reads(vaultId, docIds, blobId, c)).toEqual(before);
    // The body text is nowhere in the database any more, in text or bytea form.
    expect(await dumpHits(SECRET)).toEqual([]);
  });

  it("a mismatch never nulls; a stale search row stays; a concurrent change is not clobbered", async () => {
    const { vaultId, docIds, blobId } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    const [d0, d1] = docIds;
    // A sealed log row that opens to different bytes than its plaintext.
    const { rows: u } = await pool.query("SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id LIMIT 1", [d0]);
    await pool.query("UPDATE doc_updates SET update_enc = $2 WHERE id = $1", [
      u[0].id,
      sealDocBytes(c, "doc_updates.update", d0, Buffer.from("not the same")),
    ]);
    // A search row re-indexed under the key while its old plaintext stayed.
    await pool.query("UPDATE note_index SET search_enc = $2 WHERE doc_id = $1", [
      d1,
      sealSearchRow(c, d1, { body: "newer body", vector: [], tokens: null }),
    ]);
    // A row that changes between the compare and the clearing write.
    const { rows: t } = await pool.query("SELECT doc_id, sha256 FROM note_texts WHERE vault_id = $1 AND content <> '' ORDER BY doc_id, sha256 LIMIT 1", [vaultId]);
    nullOutHooks.beforeWrite = async (table, key) => {
      if (table === "note_texts" && key === `${t[0].doc_id}:${t[0].sha256}`) {
        await pool.query("UPDATE note_texts SET content = content || ' (edited)' WHERE doc_id = $1 AND sha256 = $2", [t[0].doc_id, t[0].sha256]);
      }
    };
    expect(await nullOutVault(vaultId, RUN)).toBe("remaining");

    const { rows: u2 } = await pool.query("SELECT update FROM doc_updates WHERE id = $1", [u[0].id]);
    expect(Buffer.compare(u2[0].update, u[0].update)).toBe(0);
    const { rows: ni } = await pool.query("SELECT content FROM note_index WHERE doc_id = $1", [d1]);
    expect(ni[0].content).toContain(SECRET);
    const { rows: t2 } = await pool.query("SELECT content FROM note_texts WHERE doc_id = $1 AND sha256 = $2", [t[0].doc_id, t[0].sha256]);
    expect(t2[0].content).toMatch(/\(edited\)$/);
    // Everything else was cleared.
    const status = await plaintextStatus(vaultId);
    expect(status.total).toBe(3);
    expect(await encryptionProgress(vaultId)).toEqual({ fullyEncrypted: false, plaintextRemaining: 3 });
    expect(textOf(await loadDocState(d1, pool, c))).toContain("note 1 line 4 budget");
    void blobId;
  });

  it("clears stale derived search plaintext only under a CURRENT sealed entry", async () => {
    const { vaultId, docIds, live, blobId } = await plaintextVault(2);
    const c = await keyVault(vaultId);
    expect(await backfillVault(vaultId, FAST)).toBe("complete");
    const [d0, d1] = docIds;
    // Both notes edited after keying and re-indexed with the key: the sealed
    // entry is newer, the old plaintext stays beside it (by design).
    for (const [i, d] of docIds.entries()) {
      await appendUpdate(d, edit(live[i], "walrus keyed edit\n"), pool, 1000, c);
      await indexDoc(d, pool, c);
    }
    // d1 is edited again and NOT re-indexed: its sealed entry is no longer current.
    await appendUpdate(d1, edit(live[1], "later edit\n"), pool, 1000, c);
    // The file's text was re-extracted under the key (different extractor output).
    const { sealBlobTextRow } = await import("../src/index/sealed-index.js");
    await pool.query("UPDATE blob_text SET search_enc = $2 WHERE blob_id = $1", [
      blobId,
      sealBlobTextRow(c, blobId, { body: "re-extracted text", vector: [], tokens: null }),
    ]);

    expect(await nullOutVault(vaultId, RUN)).toBe("remaining");
    const { rows } = await pool.query("SELECT doc_id, content FROM note_index WHERE doc_id = ANY($1::text[])", [docIds]);
    const content = Object.fromEntries(rows.map((r) => [r.doc_id, r.content]));
    expect(content[d0]).toBe("");
    expect(content[d1]).toContain(SECRET);
    const { rows: b } = await pool.query("SELECT content, vector, search_tokens FROM blob_text WHERE blob_id = $1", [blobId]);
    expect(b[0]).toEqual({ content: "", vector: null, search_tokens: null });
    expect((await plaintextStatus(vaultId)).byTable.note_index).toBe(1);
    // Search still finds the post-keying text through the sealed entry.
    const hits = await searchNoteIndex({
      vaultId,
      query: "walrus",
      k: 10,
      readableDocIds: docIds,
      vaultWideReader: true,
      crypto: c,
    } as Parameters<typeof searchNoteIndex>[0]);
    expect(hits.length).toBeGreaterThan(0);

    // Re-indexing d1 makes its sealed entry current; the next pass clears it.
    await indexDoc(d1, pool, c);
    expect(await nullOutVault(vaultId, RUN)).toBe("sealed");
    expect(await dumpHits(SECRET)).toEqual([]);
  });

  it("refuses without a held key, and never touches an unkeyed vault", async () => {
    const keyed = await plaintextVault(1);
    await keyVault(keyed.vaultId, false);
    const plain = await plaintextVault(1);
    const snapshot = async (vaultId: string) => plaintextStatus(vaultId);
    const plainBefore = await snapshot(plain.vaultId);
    expect(await nullOutVault(plain.vaultId, RUN)).toBe("not_keyed");
    // The gate's counts run at most once an hour per vault.
    expect(await nullOutVault(keyed.vaultId, { throttleMs: 0 })).toBe("waiting");
    expect(await nullOutVault(keyed.vaultId, { throttleMs: 0 })).toBe("remaining");
    expect(await snapshot(plain.vaultId)).toEqual(plainBefore);
    // Keyed but no key cached: the backfill never completes, the null-out waits.
    expect(await backfillVault(keyed.vaultId, FAST)).toBe("no_key");
    expect(await nullOutVault(keyed.vaultId, RUN)).toBe("waiting");
    expect((await plaintextStatus(keyed.vaultId)).total).toBeGreaterThan(0);
    // A compaction in the unkeyed vault is today's plaintext compaction.
    await compact(plain.docIds[0], pool);
    const { rows } = await pool.query("SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1", [plain.docIds[0]]);
    expect(rows[0].snapshot).not.toBeNull();
    expect(rows[0].snapshot_enc).toBeNull();
  });

  it("a vault keyed from creation is sealed at once", async () => {
    const orgId = await seedOrg("Fresh", `fresh-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    const c = await keyVault(vaultId);
    const docId = await seedNote(vaultId, null, "a.md");
    const doc = new Y.Doc();
    await appendUpdate(docId, edit(doc, "hello\n"), pool, 1000, c);
    expect(await nullOutVault(vaultId, RUN)).toBe("sealed");
    expect(await encryptionProgress(vaultId)).toEqual({ fullyEncrypted: true, plaintextRemaining: 0 });
    doc.destroy();
  });
});
