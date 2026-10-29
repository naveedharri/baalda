// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate, compact, loadDocState } from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";

const SECRET = "the-quarterly-plan-is-a-secret";

function updateWith(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return u;
}

function textOf(state: Uint8Array | null): string {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const t = doc.getText("content").toString();
  doc.destroy();
  return t;
}

async function keyedDoc() {
  const orgId = await seedOrg("Sealed", `sealed-${Date.now()}`);
  const vaultId = await seedVault(orgId);
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(key, vaultId),
  ]);
  const docId = await seedNote(vaultId, null, "secret.md");
  const crypto: DocCrypto = { vaultId, key, generation: 1 };
  return { vaultId, docId, key, crypto };
}

async function storedBytes(docId: string): Promise<Buffer> {
  const u = await pool.query<{ b: Buffer | null; e: Buffer | null }>(
    "SELECT update AS b, update_enc AS e FROM doc_updates WHERE doc_id = $1",
    [docId],
  );
  const s = await pool.query<{ b: Buffer | null; e: Buffer | null }>(
    "SELECT snapshot AS b, snapshot_enc AS e FROM doc_snapshots WHERE doc_id = $1",
    [docId],
  );
  return Buffer.concat([...u.rows, ...s.rows].flatMap((r) => [r.b, r.e].filter((x): x is Buffer => !!x)));
}

describe("sealed Yjs log (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("keyed: append + load round-trips and the rows hold no plaintext", async () => {
    const { docId, crypto } = await keyedDoc();
    await appendUpdate(docId, updateWith(SECRET), pool, 1000, crypto);
    expect(textOf(await loadDocState(docId, pool, crypto))).toBe(SECRET);
    const raw = await storedBytes(docId);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.includes(Buffer.from(SECRET))).toBe(false);
    const { rows } = await pool.query("SELECT update FROM doc_updates WHERE doc_id = $1", [docId]);
    expect(rows.every((r) => r.update === null)).toBe(true);
  });

  it("keyed: load without the key is key_required; a plaintext write is refused", async () => {
    const { docId, crypto } = await keyedDoc();
    await appendUpdate(docId, updateWith(SECRET), pool, 1000, crypto);
    await expect(loadDocState(docId, pool)).rejects.toBeInstanceOf(KeyRequiredError);
    await expect(appendUpdate(docId, updateWith("x"), pool, 1000)).rejects.toBeInstanceOf(KeyRequiredError);
    const wrong = { ...crypto, key: randomBytes(32) };
    await expect(loadDocState(docId, pool, wrong)).rejects.toThrow();
  });

  it("keyed: compaction seals the snapshot and keeps the content", async () => {
    const { docId, crypto } = await keyedDoc();
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    for (const part of [SECRET, " and more", " text"]) doc.getText("content").insert(doc.getText("content").length, part);
    for (const u of updates) await appendUpdate(docId, u, pool, 2, crypto);
    const snap = await pool.query("SELECT snapshot, snapshot_enc FROM doc_snapshots WHERE doc_id = $1", [docId]);
    expect(snap.rows[0].snapshot).toBeNull();
    expect(snap.rows[0].snapshot_enc).not.toBeNull();
    expect((await storedBytes(docId)).includes(Buffer.from(SECRET))).toBe(false);
    expect(textOf(await loadDocState(docId, pool, crypto))).toBe(`${SECRET} and more text`);
    doc.destroy();
  });

  it("background compaction defers without a held key and uses the cache when held", async () => {
    const { vaultId, docId, key, crypto } = await keyedDoc();
    await appendUpdate(docId, updateWith(SECRET), pool, 1000, crypto);
    await appendUpdate(docId, updateWith("b"), pool, 1000, crypto);
    await compact(docId, pool);
    const before = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]);
    expect(before.rows[0].n).toBe(2);
    const release = vaultKeyCache.acquire(vaultId, key, 1);
    await compact(docId, pool);
    const after = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]);
    expect(after.rows[0].n).toBe(0);
    expect(textOf(await loadDocState(docId, pool, crypto))).toContain(SECRET);
    release();
  });

  it("unkeyed vault: plaintext columns exactly as before, no key needed", async () => {
    const orgId = await seedOrg("Plain", `plain-${Date.now()}`);
    const vaultId = await seedVault(orgId);
    const docId = await seedNote(vaultId, null, "plain.md");
    const u = updateWith("hello");
    await appendUpdate(docId, u, pool, 1000);
    const { rows } = await pool.query("SELECT update, update_enc FROM doc_updates WHERE doc_id = $1", [docId]);
    expect(rows[0].update_enc).toBeNull();
    expect(Buffer.from(rows[0].update).equals(Buffer.from(u))).toBe(true);
    expect(textOf(await loadDocState(docId, pool))).toBe("hello");
  });
});
