import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedBlob,
  seedBlobText,
  seedFile,
  seedFolder,
  seedMember,
  seedOrg,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * `DELETE /api/files/:id` — the delete a synced binary never had.
 *
 * Attachment identity is the content hash, so a file removed on one device and
 * left on the server is simply content the server has and the device does not:
 * the next pass downloads it back. Nothing could stop that until the row (and
 * its bytes) could be unmade, which is what this route is.
 */
const app = createApp(testAppDeps());

let owner: TestUser;
let reader: TestUser;
let orgId = "";
let vaultId = "";
let folderId = "";

const del = (user: TestUser, id: string) =>
  app.fetch(
    new Request(`http://local/api/files/${id}`, { method: "DELETE", headers: authHeaders(user) }),
  );

const fileRows = async (id: string) =>
  (await pool.query("SELECT 1 FROM files WHERE id = $1", [id])).rows.length;
const blobRows = async (docId: string) =>
  (await pool.query("SELECT 1 FROM blobs WHERE doc_id = $1", [docId])).rows.length;

afterAll(async () => {
  await pool.end();
});

describe("DELETE /api/files/:id", () => {
  beforeEach(async () => {
    await resetDb();
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@file.delete.test`);
    reader = await signUp(`reader+${tag}@file.delete.test`);
    orgId = await seedOrg("Delete Co", `file-del-${tag}`);
    await seedMember(orgId, owner.userId, "owner");
    await seedMember(orgId, reader.userId, "member");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
    folderId = await seedFolder(vaultId, null, "Team", "Team", owner.userId);
  });

  it("removes the row and the bytes, and answers 204 again on a repeat", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/guide.pdf");
    const blobId = await seedBlob(vaultId, orgId, "Team/guide.pdf", { docId });
    await seedBlobText(blobId, vaultId, docId, "the guide");

    const res = await del(owner, docId);
    expect(res.status).toBe(204);
    expect(await fileRows(docId)).toBe(0);
    expect(await blobRows(docId)).toBe(0);
    const { rows: text } = await pool.query("SELECT 1 FROM blob_text WHERE blob_id = $1", [blobId]);
    expect(text).toHaveLength(0);

    // The queue draining twice (offline, then online) must not read as failure.
    const again = await del(owner, docId);
    expect(again.status).toBe(204);
    // Nor must an id that never existed.
    expect((await del(owner, randomUUID())).status).toBe(204);
  });

  it("leaves a tombstone, and the id can still be registered again", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/shot.png");
    expect((await del(owner, docId)).status).toBe(204);

    const { rows } = await pool.query<{ path: string }>(
      "SELECT path FROM file_tombstones WHERE id = $1",
      [docId],
    );
    expect(rows).toEqual([{ path: "Team/shot.png" }]);

    // A device that kept the file (and its id) re-registers it — the desktop's
    // recovery when its upload names a row the server no longer has.
    const again = await app.fetch(
      new Request("http://local/api/files", {
        method: "POST",
        headers: { ...authHeaders(owner), "content-type": "application/json" },
        body: JSON.stringify({ vaultId, path: "Team/shot.png", docId }),
      }),
    );
    expect(again.status).toBe(201);
    expect(await fileRows(docId)).toBe(1);
  });

  it("drops the file from the blob listing, so no device re-downloads it", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/deck.pptx");
    await seedBlob(vaultId, orgId, "Team/deck.pptx", { docId });

    const before = await app.fetch(
      new Request(`http://local/api/vaults/${vaultId}/blobs`, { headers: authHeaders(owner) }),
    );
    expect(((await before.json()) as { blobs: unknown[] }).blobs).toHaveLength(1);

    expect((await del(owner, docId)).status).toBe(204);

    const after = await app.fetch(
      new Request(`http://local/api/vaults/${vaultId}/blobs`, { headers: authHeaders(owner) }),
    );
    expect(((await after.json()) as { blobs: unknown[] }).blobs).toEqual([]);
  });

  it("leaves it out of the access tree once deleted", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/notes.docx");
    const listed = async () => {
      const res = await app.fetch(
        new Request(`http://local/api/vaults/${vaultId}/access-tree`, { headers: authHeaders(owner) }),
      );
      const body = (await res.json()) as { files: Array<{ id: string }> };
      return body.files.map((f) => f.id);
    };
    expect(await listed()).toContain(docId);
    expect((await del(owner, docId)).status).toBe(204);
    expect(await listed()).not.toContain(docId);
  });

  it("refuses a read-only member — the same gate that refuses the upload", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/budget.xlsx");
    await seedBlob(vaultId, orgId, "Team/budget.xlsx", { docId });
    // Read-only posture: the org grant caps everyone at view.
    await pool.query("DELETE FROM shares WHERE org_id = $1 AND resource_type = 'vault'", [orgId]);
    await seedVaultGrant(orgId, "view");

    const res = await del(reader, docId);
    expect(res.status).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "no_write_access" });
    expect(await fileRows(docId)).toBe(1);
    expect(await blobRows(docId)).toBe(1);
  });

  it("refuses a non-member outright", async () => {
    const docId = await seedFile(vaultId, folderId, "Team/private.pdf");
    const outsider = await signUp(`outsider+${randomUUID().slice(0, 8)}@file.delete.test`);
    expect((await del(outsider, docId)).status).toBe(403);
    expect(await fileRows(docId)).toBe(1);
  });
});

/**
 * Content dedupe used to be keyed on `(vault_id, sha256)` alone, so two
 * REGISTERED FILES holding identical bytes collapsed into one row. Migration 029
 * splits the slot: unclaimed (`attachments/…`) blobs keep the old one-row rule,
 * a tree file gets a row per doc.
 */
describe("two tree files with identical bytes", () => {
  beforeEach(async () => {
    await resetDb();
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@dup.bytes.test`);
    orgId = await seedOrg("Dup Co", `dup-${tag}`);
    await seedMember(orgId, owner.userId, "owner");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
    folderId = await seedFolder(vaultId, null, "Team", "Team", owner.userId);
  });

  it("each keeps its own row, and deleting one leaves the other downloadable", async () => {
    const sha = "a".repeat(64);
    const first = await seedFile(vaultId, folderId, "Team/one.pdf");
    const second = await seedFile(vaultId, folderId, "Team/two.pdf");
    // Under the old unique index the second insert was impossible; the whole
    // point of 029 is that it now is.
    const blobA = await seedBlob(vaultId, orgId, "Team/one.pdf", { docId: first, sha256: sha });
    const blobB = await seedBlob(vaultId, orgId, "Team/two.pdf", { docId: second, sha256: sha });
    expect(blobA).not.toBe(blobB);

    expect((await del(owner, first)).status).toBe(204);

    // The survivor still has its bytes — before this, `deleteDocBlobs(first)`
    // took the shared row and the second, still-registered file went dark.
    expect(await fileRows(second)).toBe(1);
    expect(await blobRows(second)).toBe(1);
    expect(await blobRows(first)).toBe(0);
  });

  it("still refuses a second UNCLAIMED blob with the same content", async () => {
    const sha = "b".repeat(64);
    await seedBlob(vaultId, orgId, "attachments/x.png", { sha256: sha });
    // `blobs_vault_sha_attachment_idx`: the zero-bytes-moved dedupe that makes a
    // fresh device settle a vault full of attachments cheaply depends on this.
    await expect(
      seedBlob(vaultId, orgId, "attachments/y.png", { sha256: sha }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
