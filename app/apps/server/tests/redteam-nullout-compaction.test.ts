// SPDX-License-Identifier: Apache-2.0
//
// Red team (W3 vault keys): the null-out clearing a plaintext CRDT row while a
// converting compaction (`compactConverting`) is mid-flight. Before the fix the
// compaction, having read the plaintext, wrote it back into its new dual log
// row after the null-out cleared it, and the null-out could already have
// recorded the vault `sealed` (it then never runs again: plaintext forever).
// Both now take the doc's EXCLUSIVE advisory lock, so they are mutually
// exclusive per doc. Deterministic via the production seams.
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate, compact, convertingCompactHooks, loadDocState } from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { openDocBytes, type DocCrypto } from "../src/crypto/doc-crypto.js";
import { backfillVault } from "../src/crypto/backfill.js";
import { nullOutHooks, nullOutVault, plaintextStatus } from "../src/crypto/null-out.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const RUN = { throttleMs: 0, force: true };
let SECRET = "";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One note: plaintext snapshot + plaintext log, then keyed, keyed edits, backfilled. */
async function convertingNote() {
  const orgId = await seedOrg("NullOutRace", `rt-${Date.now()}-${Math.random()}`);
  const userId = await seedUser(`rt-${Math.random().toString(36).slice(2)}@rt.test`);
  await seedMember(orgId, userId, "owner");
  const vaultId = await seedVault(orgId);
  const docId = await seedNote(vaultId, null, "race.md", userId);
  const live = new Y.Doc();
  for (let j = 0; j < 3; j++) await appendUpdate(docId, edit(live, `pre ${j} ${SECRET}\n`), pool, 1000);
  await compact(docId, pool);
  for (let j = 3; j < 5; j++) await appendUpdate(docId, edit(live, `pre ${j} ${SECRET}\n`), pool, 1000);
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(key, vaultId)]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  vaultKeyCache.acquire(vaultId, key, 1);
  const c: DocCrypto = { vaultId, key: Buffer.from(key), generation: 1 };
  for (let j = 0; j < 2; j++) await appendUpdate(docId, edit(live, `keyed ${j}\n`), pool, 1000, c);
  expect(await backfillVault(vaultId, { throttleMs: 0 })).toBe("complete");
  return { vaultId, docId, live, c };
}

/** Plaintext CRDT bytes of the doc still stored anywhere. */
async function crdtPlaintext(docId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL)
          + (SELECT count(*)::int FROM doc_snapshots WHERE doc_id = $1 AND snapshot IS NOT NULL) AS n`,
    [docId],
  );
  return rows[0].n;
}

async function sealedRowsOpen(docId: string, c: DocCrypto): Promise<void> {
  const { rows } = await pool.query("SELECT update_enc FROM doc_updates WHERE doc_id = $1 AND update_enc IS NOT NULL", [docId]);
  for (const r of rows) openDocBytes(c, "doc_updates.update", docId, r.update_enc, null);
}

describe("red team: null-out vs converting compaction on one doc", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("VAULT_PLAINTEXT_RETENTION_DAYS", "0");
    await resetDb();
    vaultKeyCache.clear();
    nullOutHooks.beforeWrite = () => {};
    nullOutHooks.whileDocLocked = () => {};
    convertingCompactHooks.beforeWrite = () => {};
    SECRET = `rtsecret${randomBytes(5).toString("hex")}`;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    nullOutHooks.beforeWrite = () => {};
    nullOutHooks.whileDocLocked = () => {};
    convertingCompactHooks.beforeWrite = () => {};
  });
  afterAll(async () => {
    await pool.end();
  });

  it("compaction first: the null-out waits for it, never reports sealed while plaintext is written back", async () => {
    const { vaultId, docId, live, c } = await convertingNote();
    expect(await crdtPlaintext(docId)).toBeGreaterThan(0);
    let nullOut: Promise<string> | null = null;
    let settledWhileCompacting: boolean | null = null;
    convertingCompactHooks.beforeWrite = async () => {
      convertingCompactHooks.beforeWrite = () => {};
      // The compaction has read the plaintext and holds the doc lock.
      let settled = false;
      nullOut = nullOutVault(vaultId, RUN).finally(() => {
        settled = true;
      });
      await sleep(600);
      settledWhileCompacting = settled;
    };
    await compact(docId, pool, c);
    const outcome = await nullOut!;
    // Mutual exclusion: the null-out could not clear this doc's rows mid-compaction.
    expect(settledWhileCompacting).toBe(false);
    // Never `sealed` while plaintext still exists (the old race left the vault
    // marked sealed with a freshly written plaintext dual row, forever).
    const left = await crdtPlaintext(docId);
    if (outcome === "sealed") expect(left).toBe(0);
    expect((await plaintextStatus(vaultId)).total === 0).toBe(outcome === "sealed");
    // A later pass clears the compaction's (verified dual) legacy row.
    expect(await nullOutVault(vaultId, RUN)).toBe("sealed");
    expect(await crdtPlaintext(docId)).toBe(0);
    // Zero data loss: every op is still there and opens under the key.
    const text = textOf(await loadDocState(docId, pool, c));
    expect(text).toBe(live.getText("content").toString());
    expect(text).toContain(`pre 0 ${SECRET}`);
    await sealedRowsOpen(docId, c);
  });

  it("null-out first: a compaction waits while a row is cleared and then never writes that plaintext back", async () => {
    const { vaultId, docId, live, c } = await convertingNote();
    const { rows: before } = await pool.query<{ id: string; update: Buffer }>(
      "SELECT id::text AS id, update FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL ORDER BY id",
      [docId],
    );
    expect(before.length).toBeGreaterThan(0);
    const firstPlain = before[0]!.update;
    let compaction: Promise<void> | null = null;
    let settledWhileClearing: boolean | null = null;
    nullOutHooks.whileDocLocked = async (table) => {
      if (compaction || table !== "doc_updates") return;
      let settled = false;
      compaction = compact(docId, pool, c).finally(() => {
        settled = true;
      });
      await sleep(600);
      settledWhileClearing = settled;
    };
    const outcome = await nullOutVault(vaultId, RUN);
    await compaction!;
    expect(settledWhileClearing).toBe(false);
    if (outcome === "sealed") expect(await crdtPlaintext(docId)).toBe(0);
    // The row cleared first never comes back as plaintext, on its own or folded
    // into a compaction's legacy row.
    const { rows: plain } = await pool.query<{ update: Buffer }>(
      "SELECT update FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL",
      [docId],
    );
    for (const r of plain) {
      expect(r.update.equals(firstPlain)).toBe(false);
      const solo = new Y.Doc();
      Y.applyUpdate(solo, new Uint8Array(r.update));
      const sv = Y.encodeStateVector(solo);
      const withFirst = new Y.Doc();
      Y.applyUpdate(withFirst, new Uint8Array(r.update));
      Y.applyUpdate(withFirst, new Uint8Array(firstPlain));
      // Applying the cleared row adds ops ⇒ this plaintext does not contain it.
      expect(Buffer.from(Y.encodeStateVector(withFirst)).equals(Buffer.from(sv))).toBe(false);
      solo.destroy();
      withFirst.destroy();
    }
    for (let i = 0; i < 3 && (await nullOutVault(vaultId, RUN)) !== "sealed"; i++);
    expect(await crdtPlaintext(docId)).toBe(0);
    expect(textOf(await loadDocState(docId, pool, c))).toBe(live.getText("content").toString());
    await sealedRowsOpen(docId, c);
  });
});
