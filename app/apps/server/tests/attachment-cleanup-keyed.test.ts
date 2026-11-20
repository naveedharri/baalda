// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { indexDoc, purgeNoteIndex } from "../src/index/indexer.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { processAttachmentCleanup } from "../src/blobs/attachment-cleanup.js";
import { purgeExpiredTrash } from "../src/trash/service.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

/** The production shape: a keyed vault, references written by the real
 *  indexer's keyed branch, never from `note_index.content` (sealed). */
function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

describe("attachment cleanup in a keyed vault", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vaultKeyCache.clear();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("re-indexes old notes first, then removes only the deleted note's images", async () => {
    const orgId = await seedOrg("K", `keyed-cleanup-${randomUUID().slice(0, 8)}`);
    const vaultId = await seedVault(orgId);
    const key = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(key, vaultId),
    ]);
    const crypto = { vaultId, key, generation: 1 };
    await seedBlob(vaultId, orgId, "attachments/gone.png");
    await seedBlob(vaultId, orgId, "attachments/kept.png");
    const a = await seedNote(vaultId, null, "A.md");
    const b = await seedNote(vaultId, null, "B.md");
    await appendUpdate(a, updateWith("![x](/attachments/gone.png)"), pool, 1000, crypto);
    await appendUpdate(b, updateWith("![[kept.png]]"), pool, 1000, crypto);

    const release = vaultKeyCache.acquire(vaultId, key, 1);
    try {
      expect(await indexDoc(a)).toBe(true);
      expect(await indexDoc(b)).toBe(true);
      // Indexed rows are older than the latest updates by construction here;
      // mark them current so only the version upgrade is in play.
      await pool.query("UPDATE note_index SET updated_at = now() + interval '1 second' WHERE vault_id = $1", [vaultId]);

      await pool.query("UPDATE notes SET deleted_at = now(), purge_after = now() WHERE id = $1", [a]);
      await purgeNoteIndex([a]);
      await purgeExpiredTrash(undefined, pool, [a]);

      // Version 0: every live note is queued for a re-index; nothing is removed yet.
      expect(await processAttachmentCleanup()).toBe(0);
      const pending = await pool.query("SELECT doc_id FROM index_pending WHERE vault_id = $1", [vaultId]);
      expect(pending.rows.map((r) => r.doc_id)).toEqual([b]);
      expect((await pool.query("SELECT 1 FROM blobs WHERE vault_id = $1", [vaultId])).rows).toHaveLength(2);

      // The key-holding drain re-indexes B through the keyed branch.
      expect(await indexDoc(b)).toBe(true);
      await pool.query("DELETE FROM index_pending WHERE doc_id = $1", [b]);
      await pool.query("UPDATE note_index SET updated_at = now() + interval '1 second' WHERE doc_id = $1", [b]);
      expect(await processAttachmentCleanup()).toBe(1);
    } finally {
      release();
    }
    const left = await pool.query("SELECT rel_path FROM blobs WHERE vault_id = $1", [vaultId]);
    expect(left.rows.map((r) => r.rel_path)).toEqual(["attachments/kept.png"]);
  });
});
