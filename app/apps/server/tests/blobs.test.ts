import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp } from "./helpers/auth.js";
import {
  seedMember,
  seedNote,
  seedOrg,
  seedVault,
  seedVaultGrant,
  seedUserVaultGrant,
} from "./helpers/seed.js";

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
  opts: { mime?: string; relPath?: string; fileName?: string; sha256?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": opts.mime ?? "application/octet-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.relPath) headers["x-rel-path"] = opts.relPath;
  if (opts.fileName) headers["x-file-name"] = opts.fileName;
  if (opts.sha256) headers["x-sha256"] = opts.sha256;
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

// One pool for the whole file; closed once, after every describe in it.
afterAll(async () => {
  await pool.end();
});

describe("attachment blob store (spec 02 §2/§5A)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("upload → list → download round-trips byte-identical", async () => {
    const owner = await signUp("owner@blob.com");
    const org = await seedOrg("Acme", "acme-blob1");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");

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
    await seedVaultGrant(org, "edit");
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
    // The vault stays PRIVATE — that is what gives the member an empty readable
    // set. The owner is a vault-wide reader by an explicit per-user grant,
    // which is what "vault-wide" means now that the role alone is not.
    await seedUserVaultGrant(org, owner.userId, "edit");
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

// ── write validation (PR 2a) ──────────────────────────────────────────────
//
// Until now the upload route stored whatever it was handed: a `rel_path` of
// `../../etc/passwd` went straight into the column, and a `Content-Type` of
// `text/html` was kept verbatim and handed back on download. These are the
// checks that close that, and they all run BEFORE the body is read.
describe("attachment upload validation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function vaultWithOwner(tag: string) {
    const owner = await signUp(`owner@${tag}.com`);
    const org = await seedOrg("Acme", tag);
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    return { owner, org, vault };
  }

  it("refuses any rel_path that is not a real path under attachments/", async () => {
    const { owner, vault } = await vaultWithOwner("relpath");
    const bytes = new Uint8Array([1, 2, 3]);

    for (const relPath of [
      "../x.png", // traversal
      "/etc/passwd", // absolute → first segment is not attachments/
      "notes/x.png", // outside attachments/
      "attachments/../x.png", // traversal after a legal first segment
      "attachments", // the directory itself, no file
      "C:\\x.png", // Windows drive (a scheme) + backslashes
      "http://evil/x.png", // scheme
      "attachments//x.png", // empty segment
    ]) {
      const res = await uploadBlob(owner.token, vault, bytes, { relPath });
      expect([relPath, res.status]).toEqual([relPath, 400]);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_rel_path");
    }

    // A nested path under attachments/ is fine — this is not a flat namespace.
    const ok = await uploadBlob(owner.token, vault, bytes, {
      relPath: "attachments/sub/dir/x.png",
      mime: "image/png",
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { relPath: string }).relPath).toBe("attachments/sub/dir/x.png");
  });

  it("refuses an upload with no rel_path at all", async () => {
    const { owner, vault } = await vaultWithOwner("norelpath");
    const res = await uploadBlob(owner.token, vault, new Uint8Array([1]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_rel_path");
  });

  it("refuses a MIME type that is not on the allow-list (415)", async () => {
    const { owner, vault } = await vaultWithOwner("mime");
    const res = await uploadBlob(owner.token, vault, new Uint8Array([1, 2]), {
      relPath: "attachments/x.exe",
      mime: "application/x-msdownload",
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { code: string }).code).toBe("unsupported_media_type");

    // Legacy clients upload unknown types as octet-stream; that must keep working.
    const legacy = await uploadBlob(owner.token, vault, new Uint8Array([3, 4]), {
      relPath: "attachments/x.bin",
    });
    expect(legacy.status).toBe(201);
  });

  it("BLOB_MIME_ENFORCE=warn stores the unlisted type instead of refusing it", async () => {
    const { owner, vault } = await vaultWithOwner("mimewarn");
    vi.resetModules();
    const prev = process.env.BLOB_MIME_ENFORCE;
    process.env.BLOB_MIME_ENFORCE = "warn";
    try {
      const { createApp: freshApp } = await import("../src/http/app.js");
      const { testAppDeps: freshDeps } = await import("./helpers/app.js");
      const { pool: freshPool } = await import("../src/db/pool.js");
      const warnApp = freshApp(freshDeps());
      const res = await warnApp.fetch(
        new Request(`http://local/api/vaults/${vault}/blobs`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.token}`,
            "content-type": "application/x-msdownload",
            "x-rel-path": "attachments/x.exe",
          },
          body: new Uint8Array([1, 2]),
        }),
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as { mime: string }).mime).toBe("application/x-msdownload");
      await freshPool.end();
    } finally {
      if (prev === undefined) delete process.env.BLOB_MIME_ENFORCE;
      else process.env.BLOB_MIME_ENFORCE = prev;
      vi.resetModules();
    }
  });

  it("refuses bytes that contradict the declared type, and never sniffs text", async () => {
    const { owner, vault } = await vaultWithOwner("magic");
    // A real PNG signature + IHDR header, so `file-type` identifies it.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89,
    ]);

    const lying = await uploadBlob(owner.token, vault, png, {
      relPath: "attachments/not-really.pdf",
      mime: "application/pdf",
    });
    expect(lying.status).toBe(400);
    expect(((await lying.json()) as { code: string }).code).toBe("content_type_mismatch");

    // The same bytes, honestly declared.
    expect(
      (await uploadBlob(owner.token, vault, png, { relPath: "attachments/real.png", mime: "image/png" }))
        .status,
    ).toBe(201);

    // Text has no signature to check, so arbitrary bytes are accepted as CSV —
    // sniffing text would reject legitimate files on a guess.
    expect(
      (
        await uploadBlob(owner.token, vault, new Uint8Array([0xff, 0xfe, 0x41]), {
          relPath: "attachments/t.csv",
          mime: "text/csv",
        })
      ).status,
    ).toBe(201);
  });

  it("verifies x-sha256, and answers a known hash without reading a byte", async () => {
    const { owner, vault } = await vaultWithOwner("sha");
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const sha = createHash("sha256").update(bytes).digest("hex");

    const first = await uploadBlob(owner.token, vault, bytes, {
      relPath: "attachments/a.bin",
      sha256: sha,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };

    // A claimed hash the vault already holds short-circuits: the body here is
    // deliberately NOT that content, and it is never looked at.
    const dedupe = await uploadBlob(owner.token, vault, new Uint8Array([0]), {
      relPath: "attachments/b.bin",
      sha256: sha,
    });
    expect(dedupe.status).toBe(200);
    const hit = (await dedupe.json()) as { id: string; deduped: boolean };
    expect(hit).toMatchObject({ id: created.id, deduped: true });

    // A claimed hash for content we do NOT have is checked against the bytes.
    const wrong = await uploadBlob(owner.token, vault, new Uint8Array([1, 2, 3]), {
      relPath: "attachments/c.bin",
      sha256: "b".repeat(64),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe("sha_mismatch");
  });

  it("HEAD /api/blobs/:id answers the download headers with no body", async () => {
    const { owner, vault } = await vaultWithOwner("head");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const created = (await (
      await uploadBlob(owner.token, vault, bytes, { relPath: "attachments/h.bin" })
    ).json()) as { id: string };

    const res = await app.fetch(
      new Request(`http://local/api/blobs/${created.id}`, {
        method: "HEAD",
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("");

    // Same gates as GET.
    const stranger = await signUp("stranger@head.com");
    const denied = await app.fetch(
      new Request(`http://local/api/blobs/${created.id}`, {
        method: "HEAD",
        headers: { authorization: `Bearer ${stranger.token}` },
      }),
    );
    expect(denied.status).toBe(403);
  });
});
