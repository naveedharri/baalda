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
