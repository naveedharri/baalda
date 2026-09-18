import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import {
  seedFile,
  seedFolder,
  seedLock,
  seedMember,
  seedOrg,
  seedShare,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * `PUT /api/vaults/:vaultId/blobs/:blobId/text` — the extracted-text cache a
 * desktop fills in for the files it holds (migration 028). These pin the whole
 * refusal surface, because this route is the one place a client's claim about a
 * file's contents is accepted at all, and the purge rules, because `blob_text`
 * is a derived cache that has to die with what it describes.
 */

const app = createApp(testAppDeps());

async function uploadBlob(
  token: string,
  vaultId: string,
  bytes: Uint8Array,
  relPath: string,
): Promise<{ id: string; sha256: string }> {
  const res = await app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-rel-path": relPath,
      },
      body: bytes,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; sha256: string };
}

function putText(
  token: string | null,
  vaultId: string,
  blobId: string,
  body: Record<string, unknown>,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/${blobId}/text`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function textRow(blobId: string) {
  const { rows } = await pool.query<{
    chars: number;
    content: string;
    source: string;
    vector: number[] | null;
    doc_id: string | null;
  }>("SELECT chars, content, source, vector, doc_id FROM blob_text WHERE blob_id = $1", [blobId]);
  return rows[0];
}

afterAll(async () => {
  await pool.end();
});

describe("PUT /vaults/:vaultId/blobs/:blobId/text", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let blob: { id: string; sha256: string };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const ok = (extra: Record<string, unknown> = {}) => ({
    chars: 17,
    content: "quarterly revenue",
    source: "client",
    sha256: blob.sha256,
    ...extra,
  });

  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner+${randomUUID()}@text.test`);
    org = await seedOrg("Text Co", `text-${randomUUID().slice(0, 8)}`);
    await seedMember(org, owner.userId, "owner");
    await seedVaultGrant(org, "edit");
    vault = await seedVault(org);
    blob = await uploadBlob(owner.token, vault, bytes, "attachments/q3.xlsx");
  });

  it("stores the text with a vector and answers 204", async () => {
    expect((await putText(owner.token, vault, blob.id, ok())).status).toBe(204);

    const row = await textRow(blob.id);
    expect(row.content).toBe("quarterly revenue");
    expect(row.chars).toBe(17);
    expect(row.source).toBe("client");
    // The same 256-dim embedding notes are ranked with.
    expect(row.vector).toHaveLength(256);
  });

  it("is idempotent — a second PUT rewrites the one row", async () => {
    await putText(owner.token, vault, blob.id, ok({ content: "old" }));
    expect((await putText(owner.token, vault, blob.id, ok({ content: "new" }))).status).toBe(204);

    const { rows } = await pool.query("SELECT blob_id FROM blob_text WHERE blob_id = $1", [blob.id]);
    expect(rows).toHaveLength(1);
    expect((await textRow(blob.id)).content).toBe("new");
  });

  it("401 without a session", async () => {
    expect((await putText(null, vault, blob.id, ok())).status).toBe(401);
  });

  it("403 for a member with no write access (read-only vault)", async () => {
    const reader = await signUp(`reader+${randomUUID()}@text.test`);
    await seedMember(org, reader.userId, "member");
    await pool.query("UPDATE shares SET permission = 'view' WHERE resource_type = 'vault'");
    expect((await putText(reader.token, vault, blob.id, ok())).status).toBe(403);
  });

  it("404 for an unknown blob, and for one in another vault", async () => {
    expect((await putText(owner.token, vault, randomUUID(), ok())).status).toBe(404);
    const other = await seedVault(org, "Other");
    expect((await putText(owner.token, other, blob.id, ok())).status).toBe(404);
  });

  it("404 while the blob is still pending", async () => {
    await pool.query("UPDATE blobs SET status = 'pending' WHERE id = $1", [blob.id]);
    expect((await putText(owner.token, vault, blob.id, ok())).status).toBe(404);
  });

  it("409 sha_mismatch when the text describes different bytes", async () => {
    const res = await putText(
      owner.token,
      vault,
      blob.id,
      ok({ sha256: createHash("sha256").update("something else").digest("hex") }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("sha_mismatch");
    expect(await textRow(blob.id)).toBeUndefined();
  });

  it("413 text_too_large past 1 MB, measured in bytes", async () => {
    // 600k two-byte characters: under the cap by length, over it by bytes.
    const res = await putText(owner.token, vault, blob.id, ok({ content: "\u00e9".repeat(600_000) }));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("text_too_large");
    expect(await textRow(blob.id)).toBeUndefined();
  });

  it("strips NUL, which is what binary-derived text is full of", async () => {
    const res = await putText(owner.token, vault, blob.id, ok({ content: "sheet\u0000one" }));
    expect(res.status).toBe(204);
    expect((await textRow(blob.id)).content).toBe("sheetone");
  });

  it("dies with the blob", async () => {
    await putText(owner.token, vault, blob.id, ok());
    const res = await app.fetch(
      new Request(`http://local/api/blobs/${blob.id}?force=1`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(res.status).toBe(204);
    expect(await textRow(blob.id)).toBeUndefined();
  });

  it("dies with the vault, through the FK cascade", async () => {
    await putText(owner.token, vault, blob.id, ok());
    await pool.query("DELETE FROM vaults WHERE id = $1", [vault]);
    expect(await textRow(blob.id)).toBeUndefined();
  });
});

/**
 * The other half of the contract: a blob that carries a `doc_id` is a
 * registered TREE FILE, so its path comes from the registry and its ACL from
 * the resolver — which is what lets a teammate shared one folder download the
 * spreadsheet inside it.
 */
describe("blobs bound to a files doc", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let folder: string;
  let fileDoc: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner+${randomUUID()}@docid.test`);
    org = await seedOrg("Doc Co", `doc-${randomUUID().slice(0, 8)}`);
    await seedMember(org, owner.userId, "owner");
    await seedVaultGrant(org, "edit");
    vault = await seedVault(org);
    folder = await seedFolder(vault, null, "Team", "Team", owner.userId);
    fileDoc = await seedFile(vault, folder, "Team/q3.xlsx");
  });

  it("the legacy POST takes x-doc-id and stores the REGISTRY's path", async () => {
    const res = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/octet-stream",
          "x-doc-id": fileDoc,
          // A path outside attachments/ would be refused on its own; the
          // registered file is what makes it legal, and the row's own value is
          // what gets stored.
          "x-rel-path": "whatever/ignored.bin",
        },
        body: new Uint8Array([9, 9, 9]),
      }),
    );
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { id: string; relPath: string; docId: string };
    expect(meta.relPath).toBe("Team/q3.xlsx");
    expect(meta.docId).toBe(fileDoc);
  });

  it("intent takes docId, and a later dedupe hit adopts one", async () => {
    // First upload knows nothing about the file: a plain attachment.
    const first = await uploadBlob(owner.token, vault, new Uint8Array([7, 7]), "attachments/x.bin");
    const { rows: before } = await pool.query("SELECT doc_id FROM blobs WHERE id = $1", [first.id]);
    expect(before[0].doc_id).toBeNull();

    // Same bytes, now declared as the tree file: the row adopts the doc.
    const res = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs/intent`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sha256: first.sha256,
          size: 2,
          mime: "application/octet-stream",
          docId: fileDoc,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deduped: boolean; blob: { docId: string } };
    expect(body.deduped).toBe(true);
    expect(body.blob.docId).toBe(fileDoc);
  });

  it("a member can download the file exactly when the folder is shared", async () => {
    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    const member = await signUp(`member+${randomUUID()}@docid.test`);
    await seedMember(org, member.userId, "member");

    const res = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/octet-stream",
          "x-doc-id": fileDoc,
        },
        body: new Uint8Array([4, 5, 6]),
      }),
    );
    const { id } = (await res.json()) as { id: string };

    const get = (u: TestUser) =>
      app.fetch(
        new Request(`http://local/api/blobs/${id}`, {
          headers: { authorization: `Bearer ${u.token}` },
        }),
      );
    expect((await get(member)).status).toBe(403);
    await seedShare(org, "folder", folder, member.userId, "view");
    expect((await get(member)).status).toBe(200);
  });

  it("a LOCKED file refuses to be deleted, however editable its folder", async () => {
    const member = await signUp(`viewer+${randomUUID()}@docid.test`);
    await seedMember(org, member.userId, "member");
    // Edit on the folder — so `canCreateIn` says yes — and a lock on the FILE,
    // which caps it at view for everyone. The lock is invisible to the folder
    // question, so create rights in a folder used to be enough to destroy
    // someone else's bytes.
    await seedShare(org, "folder", folder, member.userId, "edit");
    await seedLock(org, "file", fileDoc, { type: "org" });

    const res = await app.fetch(
      new Request(`http://local/api/files/${fileDoc}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${member.token}` },
      }),
    );
    expect(res.status).toBe(403);
    const { rows } = await pool.query("SELECT 1 FROM files WHERE id = $1", [fileDoc]);
    expect(rows).toHaveLength(1);
  });
});
