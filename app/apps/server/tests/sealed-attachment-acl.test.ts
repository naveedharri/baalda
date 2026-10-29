// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { canReadAttachment, filterReadableBlobs } from "../src/permissions/http-gates.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { sealSearchRow } from "../src/index/sealed-index.js";
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

  it("refuses rather than guesses without the key", async () => {
    const keyed = await vault(org, owner, member, (v) => ({ vaultId: v, key: randomBytes(32), generation: 1 }));
    await expect(filterReadableBlobs(member, keyed.vaultId, [blob("attachments/pic.png")])).rejects.toBeInstanceOf(KeyRequiredError);
    await expect(canReadAttachment(member, keyed.vaultId, "attachments/pic.png")).rejects.toBeInstanceOf(KeyRequiredError);
  });
});
