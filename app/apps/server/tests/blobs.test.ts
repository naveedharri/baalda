import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

/** Insert a note_index row so an attachment reference is discoverable by the
 *  per-attachment ACL (which scans indexed note content). */
async function indexNote(docId: string, vaultId: string, content: string) {
  await pool.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content, vector, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [docId, vaultId, "t", content, JSON.stringify([])],
  );
}

const app = createApp(testAppDeps());

function uploadBlob(
  token: string | null,
  vaultId: string,
  bytes: Uint8Array,
  opts: { mime?: string; relPath?: string; fileName?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": opts.mime ?? "application/octet-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.relPath) headers["x-rel-path"] = opts.relPath;
  if (opts.fileName) headers["x-file-name"] = opts.fileName;
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs`, {
      method: "POST",
      headers,
      body: bytes,
    }),
  );
}

function listBlobs(token: string, vaultId: string) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function downloadBlob(token: string, id: string) {
  return app.fetch(
    new Request(`http://local/api/blobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe("attachment blob store (spec 02 §2/§5A)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("upload → list → download round-trips byte-identical", async () => {
    const owner = await signUp("owner@blob.com");
    const org = await seedOrg("Acme", "acme-blob1");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);

    // Non-UTF8 binary payload to prove byte fidelity.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x42]);

    const up = await uploadBlob(owner.token, vault, bytes, {
      mime: "image/png",
      relPath: "attachments/logo.png",
      fileName: "logo.png",
    });
    expect(up.status).toBe(201);
    const created = (await up.json()) as {
      id: string;
      sha256: string;
      size: number;
      mime: string;
      relPath: string;
      deduped: boolean;
    };
    expect(created.deduped).toBe(false);
    expect(created.size).toBe(bytes.byteLength);
    expect(created.relPath).toBe("attachments/logo.png");
    expect(created.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const list = await listBlobs(owner.token, vault);
    expect(list.status).toBe(200);
    const { blobs } = (await list.json()) as {
      blobs: Array<{ id: string; sha256: string; size: number; mime: string; relPath: string }>;
    };
    expect(blobs).toHaveLength(1);
    expect(blobs[0].id).toBe(created.id);
    expect(blobs[0].mime).toBe("image/png");

    const dl = await downloadBlob(owner.token, created.id);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    const got = new Uint8Array(await dl.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it("dedupes by sha256 within a vault (returns the existing row)", async () => {
    const owner = await signUp("owner@blob2.com");
    const org = await seedOrg("Acme", "acme-blob2");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const first = await uploadBlob(owner.token, vault, bytes, { relPath: "attachments/a.bin" });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { id: string; deduped: boolean };
    expect(a.deduped).toBe(false);

    // Same content again (different rel path) → dedupe to the same row, 200.
    const second = await uploadBlob(owner.token, vault, bytes, { relPath: "attachments/b.bin" });
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string; deduped: boolean };
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);

    const list = await listBlobs(owner.token, vault);
    const { blobs } = (await list.json()) as { blobs: unknown[] };
    expect(blobs).toHaveLength(1);
  });

  it("rejects a non-member with 403 (upload, list, and download)", async () => {
    const owner = await signUp("owner@blob3.com");
    const org = await seedOrg("Acme", "acme-blob3");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const bytes = new Uint8Array([9, 9, 9]);
    const up = await uploadBlob(owner.token, vault, bytes, { relPath: "attachments/x.bin" });
    const created = (await up.json()) as { id: string };

    const stranger = await signUp("stranger@blob3.com"); // not a member of the org
    expect((await uploadBlob(stranger.token, vault, bytes, { relPath: "attachments/y.bin" })).status).toBe(403);
    expect((await listBlobs(stranger.token, vault)).status).toBe(403);
    expect((await downloadBlob(stranger.token, created.id)).status).toBe(403);
  });

  it("requires auth (401) and 404s an unknown vault / blob", async () => {
    const owner = await signUp("owner@blob4.com");
    const org = await seedOrg("Acme", "acme-blob4");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);

    expect((await uploadBlob(null, vault, new Uint8Array([1]))).status).toBe(401);
    expect((await uploadBlob(owner.token, "no-such-vault", new Uint8Array([1]))).status).toBe(404);
    expect((await downloadBlob(owner.token, "no-such-blob")).status).toBe(404);
  });

  // F13: a scoped member must not be able to list/download attachments of notes
  // they cannot read, while still getting attachments of notes they can.
  it("scopes a member's blob access to attachments of readable notes", async () => {
    const owner = await signUp("owner@blob5.com");
    const org = await seedOrg("Acme", "acme-blob5");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    // Private-by-default vault: a plain member with no shares.
    const member = await signUp("member@blob5.com");
    await seedMember(org, member.userId, "member");

    // Owner's private note references secret.png; member's own note references mine.png.
    const secretNote = await seedNote(vault, null, "Secret.md", owner.userId);
    await indexNote(secretNote, vault, "see ![x](/attachments/secret.png)");
    const myNote = await seedNote(vault, null, "Mine.md", member.userId);
    await indexNote(myNote, vault, "mine ![y](/attachments/mine.png)");

    const secretBlob = (await (
      await uploadBlob(owner.token, vault, new Uint8Array([1, 1]), {
        relPath: "attachments/secret.png",
      })
    ).json()) as { id: string };
    const mineBlob = (await (
      await uploadBlob(owner.token, vault, new Uint8Array([2, 2]), {
        relPath: "attachments/mine.png",
      })
    ).json()) as { id: string };

    // Owner (vault-wide) sees and downloads both.
    const ownerList = (await (await listBlobs(owner.token, vault)).json()) as {
      blobs: unknown[];
    };
    expect(ownerList.blobs).toHaveLength(2);
    expect((await downloadBlob(owner.token, secretBlob.id)).status).toBe(200);

    // Member: only the attachment of their own readable note.
    expect((await downloadBlob(member.token, secretBlob.id)).status).toBe(403);
    expect((await downloadBlob(member.token, mineBlob.id)).status).toBe(200);
    const memberList = (await (await listBlobs(member.token, vault)).json()) as {
      blobs: Array<{ relPath: string | null }>;
    };
    expect(memberList.blobs.map((b) => b.relPath)).toEqual(["attachments/mine.png"]);
  });
});
