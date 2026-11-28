import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { flushBlobRefsAnnouncements, replaceBlobRefs, setBlobRefsNotifier } from "../src/blobs/refs.js";
import { BLOB_REFS_VERSION, processAttachmentCleanup } from "../src/blobs/attachment-cleanup.js";
import { purgeExpiredTrash } from "../src/trash/service.js";
import { purgeNoteIndex } from "../src/index/indexer.js";

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
  // What every delete route does at once, before the purge (the references
  // are gone by the time the purge runs).
  await purgeNoteIndex([id]);
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
    await pool.query("UPDATE vaults SET blob_refs_version = $2 WHERE id = $1", [vaultId, BLOB_REFS_VERSION]);
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

  it("waits while another note was edited after its last index (an embed moved into it)", async () => {
    await seedBlob(vaultId, orgId, "attachments/moved.png");
    const a = await noteWith("A.md", "![x](/attachments/moved.png)");
    const b = await noteWith("B.md", "nothing yet");
    // B's CRDT now holds the pasted embed; its re-index has not run.
    await pool.query("UPDATE note_index SET updated_at = now() - interval '1 minute' WHERE doc_id = $1", [b]);
    await pool.query("INSERT INTO doc_updates (doc_id, seq, update) VALUES ($1, 1, '\\x00'::bytea)", [b]);

    await deleteAndPurge(a);
    expect(await processAttachmentCleanup()).toBe(0);
    expect(await blobAt("attachments/moved.png")).toBe(1);

    // The re-index lands with the embed: the image is used, and stays.
    await pool.query("UPDATE note_index SET updated_at = now() WHERE doc_id = $1", [b]);
    await replaceBlobRefs(b, vaultId, "![x](/attachments/moved.png)");
    expect(await processAttachmentCleanup()).toBe(0);
    expect(await blobAt("attachments/moved.png")).toBe(1);
  });

  it("keeps a picture another note embeds in any form a note can show it", async () => {
    // Each kept picture is embedded by A the plain way and by B in a form the
    // extractor once missed; deleting A took it from B for everyone.
    const forms: Array<[string, string]> = [
      ["attachments/My Pic.png", "![](<attachments/My Pic.png>)"],
      ["attachments/Titled Pic.png", '![a](<attachments/Titled Pic.png> "title")'],
      ["attachments/dot.png", "![](./attachments/dot.png)"],
      ["attachments/pic(1).png", "![](attachments/pic(1).png)"],
      ["attachments/ref.png", "![a][r]\n\n[r]: attachments/ref.png"],
      ["attachments/ref angle.png", "![a][r]\n\n[r]: <attachments/ref angle.png>"],
      ["attachments/html space.png", '<img src="attachments/html space.png">'],
    ];
    for (const [rel] of forms) await seedBlob(vaultId, orgId, rel);
    await seedBlob(vaultId, orgId, "attachments/only-a.png");
    const a = await noteWith(
      "A.md",
      forms.map(([rel]) => `![](${rel.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})`).join("\n") + "\n![](attachments/only-a.png)",
    );
    await noteWith("B.md", forms.map(([, md]) => md).join("\n\n"));

    await deleteAndPurge(a);
    expect(await processAttachmentCleanup()).toBe(1);
    expect(await blobAt("attachments/only-a.png")).toBe(0);
    for (const [rel] of forms) expect([rel, await blobAt(rel)]).toEqual([rel, 1]);
  });

  it("tells the vault once when a note starts embedding a drop the server already holds", async () => {
    const heard: string[] = [];
    setBlobRefsNotifier((v) => heard.push(v));
    try {
      await seedBlob(vaultId, orgId, "attachments/there.png");
      const id = await seedNote(vaultId, null, "Shared.md");
      // An edit that embeds nothing held, then the same embed again: silent.
      await replaceBlobRefs(id, vaultId, "![](attachments/not-uploaded.png)", pool, { announce: true });
      flushBlobRefsAnnouncements();
      expect(heard).toEqual([]);
      // Now it embeds the held drop: one frame, however many edits follow.
      await replaceBlobRefs(id, vaultId, "![](attachments/not-uploaded.png) ![](attachments/there.png)", pool, { announce: true });
      await replaceBlobRefs(id, vaultId, "![](attachments/there.png) more text", pool, { announce: true });
      flushBlobRefsAnnouncements();
      expect(heard).toEqual([vaultId]);
      // Same references, new text: nothing new to say.
      await replaceBlobRefs(id, vaultId, "![](attachments/there.png) and more text", pool, { announce: true });
      flushBlobRefsAnnouncements();
      expect(heard).toEqual([vaultId]);
      // The embed taken out: members who saw it through this note must hear.
      await replaceBlobRefs(id, vaultId, "no pictures now", pool, { announce: true });
      flushBlobRefsAnnouncements();
      expect(heard).toEqual([vaultId, vaultId]);
      // A wiki embed by bare name of a mixed-case drop counts the same.
      await seedBlob(vaultId, orgId, "attachments/Mixed Case.PNG");
      await replaceBlobRefs(id, vaultId, "![[Mixed Case.PNG]]", pool, { announce: true });
      flushBlobRefsAnnouncements();
      expect(heard).toEqual([vaultId, vaultId, vaultId]);
    } finally {
      setBlobRefsNotifier(null);
    }
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
