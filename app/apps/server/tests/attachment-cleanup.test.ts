import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { replaceBlobRefs } from "../src/blobs/refs.js";
import { processAttachmentCleanup } from "../src/blobs/attachment-cleanup.js";
import { purgeExpiredTrash } from "../src/trash/service.js";

/**
 * A deleted note's attachments leave the server once no live note uses them
 * (deleted means deleted). Before this they stayed, and every access change
 * sent them to (or took them from) a member's disk.
 */
let orgId = "";
let vaultId = "";

const blobAt = async (rel: string) =>
  (await pool.query("SELECT 1 FROM blobs WHERE vault_id = $1 AND rel_path = $2", [vaultId, rel])).rows.length;

async function noteWith(path: string, markdown: string): Promise<string> {
  const id = await seedNote(vaultId, null, path);
  await pool.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)`,
    [id, vaultId, path, markdown],
  );
  await replaceBlobRefs(id, vaultId, markdown);
  return id;
}

async function deleteAndPurge(id: string): Promise<void> {
  await pool.query("UPDATE notes SET deleted_at = now(), purge_after = now() WHERE id = $1", [id]);
  await purgeExpiredTrash(undefined, pool, [id]);
}

afterAll(async () => {
  await pool.end();
});

describe("attachments of a purged note", () => {
  beforeEach(async () => {
    await resetDb();
    orgId = await seedOrg("Cleanup Co", `cleanup-${randomUUID().slice(0, 8)}`);
    vaultId = await seedVault(orgId);
    await pool.query("UPDATE vaults SET blob_refs_version = 2 WHERE id = $1", [vaultId]);
  });

  it("removes the ones only it used and keeps the ones another note still uses", async () => {
    await seedBlob(vaultId, orgId, "attachments/only-a.png");
    await seedBlob(vaultId, orgId, "attachments/shared.png");
    await seedBlob(vaultId, orgId, "attachments/wiki.png");
    const a = await noteWith("A.md", "![x](/attachments/only-a.png) ![[attachments/wiki.png]] ![y](/attachments/shared.png)");
    await noteWith("B.md", "Uses ![[shared.png]] too");

    await deleteAndPurge(a);
    expect(await processAttachmentCleanup()).toBe(2);

    expect(await blobAt("attachments/only-a.png")).toBe(0);
    expect(await blobAt("attachments/wiki.png")).toBe(0);
    expect(await blobAt("attachments/shared.png")).toBe(1);
  });

  it("waits while a keyed vault is still re-indexing, then removes", async () => {
    await pool.query("UPDATE vaults SET vk_check = '\\x00'::bytea WHERE id = $1", [vaultId]).catch(async () => {
      await pool.query("UPDATE vaults SET vk_check = 'x' WHERE id = $1", [vaultId]);
    });
    await seedBlob(vaultId, orgId, "attachments/k.png");
    const a = await noteWith("A.md", "![x](/attachments/k.png)");
    const other = await noteWith("Other.md", "no images");
    await pool.query("INSERT INTO index_pending (doc_id, vault_id) VALUES ($1, $2)", [other, vaultId]);

    await deleteAndPurge(a);
    expect(await processAttachmentCleanup()).toBe(0);
    expect(await blobAt("attachments/k.png")).toBe(1);

    await pool.query("DELETE FROM index_pending WHERE doc_id = $1", [other]);
    expect(await processAttachmentCleanup()).toBe(1);
    expect(await blobAt("attachments/k.png")).toBe(0);
  });

  it("rebuilds an unkeyed vault's references from the index before trusting them", async () => {
    await pool.query("UPDATE vaults SET blob_refs_version = 0 WHERE id = $1", [vaultId]);
    await seedBlob(vaultId, orgId, "attachments/kept.png");
    await seedBlob(vaultId, orgId, "attachments/gone.png");
    const a = await noteWith("A.md", "![x](/attachments/gone.png) ![[attachments/kept.png]]");
    const b = await seedNote(vaultId, null, "B.md");
    // B was indexed by the old extractor: wiki embed, no reference recorded.
    await pool.query(
      "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, 'B', '![[attachments/kept.png]]')",
      [b, vaultId],
    );

    await deleteAndPurge(a);
    expect(await processAttachmentCleanup()).toBe(1);
    expect(await blobAt("attachments/gone.png")).toBe(0);
    expect(await blobAt("attachments/kept.png")).toBe(1);
  });
});
