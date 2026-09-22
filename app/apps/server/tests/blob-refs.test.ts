import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { indexDoc, purgeNoteIndex } from "../src/index/indexer.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import {
  assetRefsFromMarkdown,
  docsReferencing,
  rebuildBlobRefs,
} from "../src/blobs/refs.js";

/**
 * `blob_refs` — which notes reference which attachments (migration 027).
 *
 * The table exists because "is this attachment still used?" had no answer a
 * deletion could be based on. These tests pin the three things everything
 * downstream trusts: WHAT counts as a reference, that it is derived on every
 * index and purged with the note, and that it matches paths the way the rest of
 * the system compares them — case-insensitively.
 */
let vaultId = "";

/** Write `text` as a doc's Yjs state so `indexDoc` can read it back. */
async function seedDocText(docId: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

const refsOf = async (docId: string) =>
  (
    await pool.query<{ rel_path: string }>(
      "SELECT rel_path FROM blob_refs WHERE doc_id = $1 ORDER BY rel_path",
      [docId],
    )
  ).rows.map((r) => r.rel_path);

afterAll(async () => {
  await pool.end();
});

describe("asset reference extraction", () => {
  it("takes image embeds AND plain links under attachments/", () => {
    const md = [
      "![a picture](attachments/a1b2.png)",
      "[the spreadsheet](attachments/deadbeef.xlsx)",
      "[a note](Projects/Plan.md)",
      "![remote](https://example.com/x.png)",
      "[escape](attachments/../../etc/passwd)",
      "![no folder](a1b2.png)",
    ].join("\n\n");
    expect(assetRefsFromMarkdown(md).sort()).toEqual([
      "attachments/a1b2.png",
      "attachments/deadbeef.xlsx",
    ]);
  });

  it("lowercases, dedupes, and keeps both forms of a percent-encoded path", () => {
    const md = "![A](Attachments/Photo.PNG) ![again](attachments/photo.png) [f](attachments/a%20b.pdf)";
    const refs = assetRefsFromMarkdown(md);
    expect(refs).toContain("attachments/photo.png");
    expect(refs.filter((r) => r === "attachments/photo.png")).toHaveLength(1);
    // Both, because a blob's rel_path is whatever the uploader sent and the
    // note's link is whatever the editor wrote — a superset is the safe side.
    expect(refs).toContain("attachments/a%20b.pdf");
    expect(refs).toContain("attachments/a b.pdf");
  });
});

describe("blob_refs maintenance", () => {
  beforeEach(async () => {
    await resetDb();
    const org = await seedOrg("Refs Co", `refs-${randomUUID().slice(0, 8)}`);
    vaultId = await seedVault(org);
  });

  it("derives a note's references when it is indexed, and replaces them on re-index", async () => {
    const docId = await seedNote(vaultId, null, "Note.md");
    await seedDocText(docId, "![p](attachments/one.png)\n\n[x](attachments/two.pdf)");
    expect(await indexDoc(docId)).toBe(true);
    expect(await refsOf(docId)).toEqual(["attachments/one.png", "attachments/two.pdf"]);

    // The note drops one embed and gains another. A replace, not an append —
    // otherwise an attachment stays "referenced" by a note that no longer
    // mentions it, forever.
    await pool.query("DELETE FROM doc_updates WHERE doc_id = $1", [docId]);
    await seedDocText(docId, "![p](attachments/one.png)\n\n![q](attachments/three.gif)");
    await indexDoc(docId);
    expect(await refsOf(docId)).toEqual(["attachments/one.png", "attachments/three.gif"]);
  });

  it("matches case-insensitively, whichever side the capitals are on", async () => {
    const docId = await seedNote(vaultId, null, "Note.md");
    await seedDocText(docId, "![p](Attachments/Photo.PNG)");
    await indexDoc(docId);
    // Stored normalised…
    expect(await refsOf(docId)).toEqual(["attachments/photo.png"]);
    // …and looked up the same way, so a blob whose rel_path kept its capitals
    // still resolves to the note that embeds it.
    expect(await docsReferencing(vaultId, "ATTACHMENTS/Photo.png")).toEqual([docId]);
  });

  it("purges a note's references when the note is purged", async () => {
    const docId = await seedNote(vaultId, null, "Note.md");
    await seedDocText(docId, "![p](attachments/one.png)");
    await indexDoc(docId);
    expect(await refsOf(docId)).toHaveLength(1);

    await purgeNoteIndex([docId]);
    expect(await refsOf(docId)).toEqual([]);
  });

  it("rebuilds a whole vault's references from note_index", async () => {
    const a = await seedNote(vaultId, null, "A.md");
    const b = await seedNote(vaultId, null, "B.md");
    await seedDocText(a, "![p](attachments/a.png)");
    await seedDocText(b, "[x](attachments/b.pdf)");
    await indexDoc(a);
    await indexDoc(b);

    // Simulate a vault indexed by a build that never knew about the table.
    await pool.query("DELETE FROM blob_refs WHERE vault_id = $1", [vaultId]);
    expect(await rebuildBlobRefs(vaultId)).toBe(2);
    expect(await refsOf(a)).toEqual(["attachments/a.png"]);
    expect(await refsOf(b)).toEqual(["attachments/b.pdf"]);
  });
});
