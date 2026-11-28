// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { canReadAttachment, filterReadableBlobs } from "../src/permissions/http-gates.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { sealSearchRow } from "../src/index/sealed-index.js";
import { sealedReferencedPaths } from "../src/permissions/sealed-refs.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const LONG = `attachments/${"x".repeat(600)}.png`;
// [owner of the note, title, body]
const NOTES: Array<["member" | "owner", string, string]> = [
  ["member", "One", "![](attachments/pic.png) and ![[attachments/Photo 1.jpg]]"],
  ["member", "attachments/in-title.png", "body mentions nothing"],
  ["member", "Three", `long link ${LONG} and bare readme.txt and 100%_off/file.pdf`],
  ["owner", "Secret", "![](attachments/owner-only.png)"],
];
const PATHS = [
  "attachments/pic.png",
  "attachments/Photo 1.jpg",
  "attachments/photo 1.jpg",
  "attachments/in-title.png",
  "attachments/owner-only.png",
  "attachments/missing.png",
  LONG,
  "readme.txt",
  "100%_off/file.pdf",
  "100xyoff/file.pdf",
];
const blob = (rel_path: string) => ({ id: `blob:${rel_path}`, rel_path });

async function vault(org: string, owner: string, member: string, crypto: (v: string) => DocCrypto | undefined) {
  const v = await seedVault(org);
  const c = crypto(v);
  if (c) {
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [v, makeVkCheck(c.key, v)]);
  }
  for (const [who, title, body] of NOTES) {
    const docId = await seedNote(v, null, `${title.replace(/\//g, "_")}.md`, who === "owner" ? owner : member);
    if (c) {
      // Sealed row, with STALE plaintext that must be ignored (it names a path
      // the current body does not).
      await pool.query(
        "INSERT INTO note_index (doc_id, vault_id, title, content, search_enc) VALUES ($1, $2, $3, $4, $5)",
        [docId, v, title, "stale: attachments/missing.png", sealSearchRow(c, docId, { body, vector: [], tokens: null })],
      );
    } else {
      await pool.query("INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)", [docId, v, title, body]);
    }
  }
  return { vaultId: v, crypto: c };
}

describe("attachment rule on keyed vaults (W3)", () => {
  let org: string;
  let owner: string;
  let member: string;
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    org = await seedOrg("Acl Co", `acl-${Date.now()}`);
    owner = await seedUser("owner@acl.test");
    member = await seedUser("member@acl.test");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("gives a scoped member exactly the same answers keyed as unkeyed", async () => {
    const plain = await vault(org, owner, member, () => undefined);
    const key = randomBytes(32);
    const keyed = await vault(org, owner, member, (v) => ({ vaultId: v, key, generation: 1 }));

    const listPlain = await filterReadableBlobs(member, plain.vaultId, PATHS.map(blob));
    const listKeyed = await filterReadableBlobs(member, keyed.vaultId, PATHS.map(blob), undefined, keyed.crypto);
    expect(listKeyed.map((b) => b.rel_path)).toEqual(listPlain.map((b) => b.rel_path));
    // Sanity: the corpus exercises both outcomes.
    expect(listPlain.map((b) => b.rel_path)).toEqual([
      "attachments/pic.png",
      "attachments/Photo 1.jpg",
      LONG,
      "readme.txt",
      "100%_off/file.pdf",
    ]);

    for (const p of PATHS) {
      const a = await canReadAttachment(member, plain.vaultId, p);
      const b = await canReadAttachment(member, keyed.vaultId, p, null, undefined, keyed.crypto);
      expect([p, b]).toEqual([p, a]);
    }
  });

  it("cuts each sealed note an excerpt on first read, then answers from excerpts alone, the same way", async () => {
    const plain = await vault(org, owner, member, () => undefined);
    const key = randomBytes(32);
    const keyed = await vault(org, owner, member, (v) => ({ vaultId: v, key, generation: 1 }));
    const want = (await filterReadableBlobs(member, plain.vaultId, PATHS.map(blob))).map((b) => b.rel_path);
    // First list: no excerpts yet, bodies are read and excerpts stored.
    expect((await filterReadableBlobs(member, keyed.vaultId, PATHS.map(blob), undefined, keyed.crypto)).map((b) => b.rel_path)).toEqual(want);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM note_index WHERE vault_id = $1 AND ref_enc IS NOT NULL", [keyed.vaultId]);
    // Every note the member reads; the owner's own note is never opened for them.
    expect(rows[0].n).toBe(NOTES.filter(([who]) => who === "member").length);
    // Second list: the same answers.
    expect((await filterReadableBlobs(member, keyed.vaultId, PATHS.map(blob), undefined, keyed.crypto)).map((b) => b.rel_path)).toEqual(want);

    // Paths under a head that fit the window never open a body any more.
    const ids = (await pool.query("SELECT doc_id FROM note_index WHERE vault_id = $1", [keyed.vaultId])).rows.map((r) => r.doc_id);
    const seen: string[] = [];
    const spy = { query: (sql: string, params?: unknown[]) => (seen.push(sql), pool.query(sql, params)) } as never;
    const short = ["attachments/pic.png", "attachments/Photo 1.jpg", "attachments/missing.png"];
    // The owner's note had no excerpt (the member never read it): this cuts it.
    await sealedReferencedPaths(keyed.vaultId, ids, short, keyed.crypto, spy);
    expect(seen.some((s) => /SELECT doc_id, search_enc/.test(s))).toBe(true);
    seen.length = 0;
    expect([...(await sealedReferencedPaths(keyed.vaultId, ids, short, keyed.crypto, spy))].sort()).toEqual(["attachments/Photo 1.jpg", "attachments/pic.png"]);
    expect(seen.some((s) => /SELECT doc_id, search_enc/.test(s))).toBe(false);
  });

  it("drops a note's excerpt when its sealed body is rewritten without one", async () => {
    const key = randomBytes(32);
    const keyed = await vault(org, owner, member, (v) => ({ vaultId: v, key, generation: 1 }));
    await filterReadableBlobs(member, keyed.vaultId, PATHS.map(blob), undefined, keyed.crypto);
    const one = (await pool.query("SELECT doc_id FROM note_index WHERE vault_id = $1 AND title = 'One'", [keyed.vaultId])).rows[0].doc_id;
    // The body no longer names the picture: the old excerpt must not answer.
    await pool.query("UPDATE note_index SET search_enc = $2 WHERE doc_id = $1", [
      one,
      sealSearchRow(keyed.crypto!, one, { body: "nothing here now", vector: [], tokens: null }),
    ]);
    const gone = await pool.query("SELECT ref_enc FROM note_index WHERE doc_id = $1", [one]);
    expect(gone.rows[0].ref_enc).toBeNull();
    const list = (await filterReadableBlobs(member, keyed.vaultId, [blob("attachments/pic.png")], undefined, keyed.crypto)).map((b) => b.rel_path);
    expect(list).toEqual([]);
  });

  it("refuses rather than guesses without the key", async () => {
    const keyed = await vault(org, owner, member, (v) => ({ vaultId: v, key: randomBytes(32), generation: 1 }));
    await expect(filterReadableBlobs(member, keyed.vaultId, [blob("attachments/pic.png")])).rejects.toBeInstanceOf(KeyRequiredError);
    await expect(canReadAttachment(member, keyed.vaultId, "attachments/pic.png")).rejects.toBeInstanceOf(KeyRequiredError);
  });
});
