import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { mintUploadToken } from "../src/blobs/upload-token.js";

/**
 * The `intent → PUT → complete` flow, end to end on the Postgres provider.
 *
 * The provider matters less than it looks: the point of the flow is that the
 * THREE STEPS and their error codes are identical whichever store is behind
 * them, so these assertions are the contract an S3 deployment also has to meet
 * (the MinIO suite in `blob-s3.test.ts` re-runs the shape against a real
 * bucket). What is Postgres-specific is only that step 2's URL points back at
 * this server.
 */
const app = createApp(testAppDeps());

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Intent {
  blobId?: string;
  deduped?: boolean;
  blob?: { id: string; sha256: string };
  upload?: {
    kind: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
    direct: boolean;
  };
  completeUrl?: string;
  code?: string;
}

async function setup(slug: string) {
  const owner = await signUp(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner.userId, "owner");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "edit");
  return { owner, org, vault };
}

function intent(
  user: TestUser | null,
  vaultId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Bearer ${user.token}`;
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/intent`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** PUT the bytes at the URL intent handed back (same-origin here). */
function putData(url: string, bytes: Buffer, headers: Record<string, string>) {
  return app.fetch(
    new Request(url.replace(/^https?:\/\/[^/]+/, "http://local"), {
      method: "PUT",
      headers,
      body: bytes,
    }),
  );
}

function complete(user: TestUser, id: string, body: Record<string, unknown> = {}) {
  return app.fetch(
    new Request(`http://local/api/blobs/${id}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await pool.end();
});

describe("blob intent → PUT → complete", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("uploads a new attachment in three steps and publishes it", async () => {
    const { owner, vault } = await setup("intent-happy");
    const sha = shaOf(PNG);

    const res = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "attachments/logo.png",
      filename: "logo.png",
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as Intent;
    expect(plan.deduped).toBeUndefined();
    expect(plan.blobId).toBeTruthy();
    expect(plan.upload?.kind).toBe("single");
    expect(plan.upload?.method).toBe("PUT");
    // The Postgres provider is not "direct" — the bytes come through this
    // server — and it says so rather than pretending otherwise.
    expect(plan.upload?.direct).toBe(false);
    expect(plan.upload?.headers["content-length"]).toBe(String(PNG.byteLength));
    expect(plan.completeUrl).toContain(`/api/blobs/${plan.blobId}/complete`);

    // The row exists but is NOT listed: pending means an upload in flight.
    const listed = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs`, {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(((await listed.json()) as { blobs: unknown[] }).blobs).toHaveLength(0);

    const put = await putData(plan.upload!.url, PNG, plan.upload!.headers);
    expect(put.status).toBe(204);

    // Still not listed until `complete` — one meaning per step.
    const midway = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs`, {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(((await midway.json()) as { blobs: unknown[] }).blobs).toHaveLength(0);

    const done = await complete(owner, plan.blobId!);
    expect(done.status).toBe(200);
    const meta = (await done.json()) as { id: string; sha256: string; size: number; mime: string };
    expect(meta.id).toBe(plan.blobId);
    expect(meta.sha256).toBe(sha);
    expect(meta.size).toBe(PNG.byteLength);

    const dl = await app.fetch(
      new Request(`http://local/api/blobs/${meta.id}`, {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("answers a known hash with `deduped` and never moves a byte", async () => {
    const { owner, vault } = await setup("intent-dedupe");
    const sha = shaOf(PNG);

    const first = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "attachments/a.png",
    });
    const plan = (await first.json()) as Intent;
    await putData(plan.upload!.url, PNG, plan.upload!.headers);
    await complete(owner, plan.blobId!);

    // A second device with the same file: one JSON round trip, zero bytes.
    const second = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "attachments/copy.png",
    });
    expect(second.status).toBe(200);
    const hit = (await second.json()) as Intent;
    expect(hit.deduped).toBe(true);
    expect(hit.blob?.id).toBe(plan.blobId);
    // No upload plan at all — there is nothing for the client to send.
    expect(hit.upload).toBeUndefined();
  });

  it("rebinds a deduped blob whose `files` row is gone, and only then", async () => {
    // First-writer-wins is about two LIVE files sharing bytes. A row that has
    // been deleted is not a claimant: leaving the binding there strands the
    // bytes on an id the resolver cannot answer for, and the desktop's rename
    // repair (which drops its own duplicate row and adopts the other) would
    // find the blob pointing at nothing.
    const { owner, vault } = await setup("intent-rebind");
    const sha = shaOf(PNG);
    const register = (id: string, path: string) =>
      app.fetch(
        new Request("http://local/api/files", {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ vaultId: vault, docId: id, path }),
        }),
      );
    const docIdOf = async (blobId: string) =>
      (await pool.query<{ doc_id: string | null }>("SELECT doc_id FROM blobs WHERE id = $1", [
        blobId,
      ])).rows[0]?.doc_id ?? null;

    await register("file-old", "guide (1).pdf");
    const first = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "guide (1).pdf",
      docId: "file-old",
    });
    const plan = (await first.json()) as Intent;
    await putData(plan.upload!.url, PNG, plan.upload!.headers);
    await complete(owner, plan.blobId!);
    expect(await docIdOf(plan.blobId!)).toBe("file-old");

    // A LIVE second file asking for the same bytes gets a ROW OF ITS OWN
    // (migration 029). It used to dedupe onto the incumbent, which meant it
    // never appeared in `GET /vaults/:id/blobs` — so a new device could not
    // materialize it — and deleting the incumbent took its bytes with it.
    await register("file-twin", "twin.pdf");
    const twin = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "twin.pdf",
      docId: "file-twin",
    });
    const twinPlan = (await twin.json()) as Intent;
    expect(twinPlan.deduped).toBeFalsy();
    expect(twinPlan.blobId).not.toBe(plan.blobId);
    await putData(twinPlan.upload!.url, PNG, twinPlan.upload!.headers);
    await complete(owner, twinPlan.blobId!);
    // Each file owns its own row, and the incumbent is untouched.
    expect(await docIdOf(plan.blobId!)).toBe("file-old");
    expect(await docIdOf(twinPlan.blobId!)).toBe("file-twin");

    // Now the row itself is gone (the desktop dropped its duplicate, or a
    // teammate deleted the file). The next dedupe hit adopts the live id.
    await pool.query("DELETE FROM files WHERE id = $1", ["file-old"]);
    await register("file-new", "guide.pdf");
    const again = await intent(owner, vault, {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "guide.pdf",
      docId: "file-new",
    });
    expect(((await again.json()) as Intent).deduped).toBe(true);
    expect(await docIdOf(plan.blobId!)).toBe("file-new");
    // …and the twin, whose file is still very much alive, keeps its own.
    expect(await docIdOf(twinPlan.blobId!)).toBe("file-twin");
  });

  it("re-issues the SAME blob id for a pending upload, with a fresh presign", async () => {
    const { owner, vault } = await setup("intent-retry");
    const sha = shaOf(PNG);
    const body = {
      sha256: sha,
      size: PNG.byteLength,
      mime: "image/png",
      relPath: "attachments/a.png",
    };

    const a = (await (await intent(owner, vault, body)).json()) as Intent;
    const b = (await (await intent(owner, vault, body)).json()) as Intent;
    // A retry must continue the same upload, not start a competing one — the
    // pending row holds this content's dedupe slot.
    expect(b.blobId).toBe(a.blobId);
    expect(b.deduped).toBeUndefined();
    expect(b.upload?.url).toBeTruthy();

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM blobs WHERE vault_id = $1 AND sha256 = $2",
      [vault, sha],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses bytes that do not hash to what intent declared", async () => {
    const { owner, vault } = await setup("intent-sha");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;

    const lying = Buffer.from(PNG);
    lying[15] ^= 0xff;
    const put = await putData(plan.upload!.url, lying, plan.upload!.headers);
    expect(put.status).toBe(400);
    expect((await put.json()).code).toBe("sha_mismatch");

    // The row survives (the client may retry with the right bytes) but the
    // blob is not publishable.
    const done = await complete(owner, plan.blobId!);
    expect(done.status).toBe(409);
    expect((await done.json()).code).toBe("upload_incomplete");
  });

  it("refuses a body of a different length than intent declared", async () => {
    const { owner, vault } = await setup("intent-size");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;

    const short = PNG.subarray(0, 8);
    const put = await putData(plan.upload!.url, short, {
      "content-type": "image/png",
      "content-length": String(short.byteLength),
    });
    expect(put.status).toBe(400);
    expect((await put.json()).code).toBe("size_mismatch");
  });

  it("refuses an expired or tampered upload token", async () => {
    const { owner, vault } = await setup("intent-token");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;

    // Expired: minted with a negative TTL so `exp` is already in the past.
    const expired = await mintUploadToken(
      { blobId: plan.blobId!, vaultId: vault, sha256: shaOf(PNG), size: PNG.byteLength },
      -60,
    );
    const stale = await putData(
      `http://local/api/blobs/${plan.blobId}/data?t=${expired}`,
      PNG,
      plan.upload!.headers,
    );
    expect(stale.status).toBe(401);
    expect((await stale.json()).code).toBe("invalid_upload_token");

    // Tampered signature.
    const url = new URL(plan.upload!.url.replace(/^https?:\/\/[^/]+/, "http://local"));
    const good = url.searchParams.get("t") as string;
    url.searchParams.set("t", good.slice(0, -2) + (good.endsWith("aa") ? "bb" : "aa"));
    const forged = await putData(url.toString(), PNG, plan.upload!.headers);
    expect(forged.status).toBe(401);

    // A valid token for ANOTHER blob is not a token for this one.
    const other = await mintUploadToken(
      { blobId: "some-other-blob", vaultId: vault, sha256: shaOf(PNG), size: PNG.byteLength },
      600,
    );
    const crossed = await putData(
      `http://local/api/blobs/${plan.blobId}/data?t=${other}`,
      PNG,
      plan.upload!.headers,
    );
    expect(crossed.status).toBe(401);
  });

  it("is idempotent on complete, and 409s a blob whose bytes never arrived", async () => {
    const { owner, vault } = await setup("intent-complete");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;

    const early = await complete(owner, plan.blobId!);
    expect(early.status).toBe(409);
    expect((await early.json()).code).toBe("upload_incomplete");

    await putData(plan.upload!.url, PNG, plan.upload!.headers);
    const first = await complete(owner, plan.blobId!);
    expect(first.status).toBe(200);
    const second = await complete(owner, plan.blobId!);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);

    // And the bytes may not be rewritten once published.
    const again = await putData(plan.upload!.url, PNG, plan.upload!.headers);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("already_uploaded");
  });

  it("refuses a complete whose restated hash disagrees with the row", async () => {
    const { owner, vault } = await setup("intent-checksum");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;
    await putData(plan.upload!.url, PNG, plan.upload!.headers);

    const bad = await complete(owner, plan.blobId!, { sha256: "c".repeat(64) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("checksum_mismatch");
    // The row is gone with the bytes: a pending row that failed verification
    // must not keep holding this content's dedupe slot.
    const { rows } = await pool.query("SELECT id FROM blobs WHERE id = $1", [plan.blobId]);
    expect(rows).toHaveLength(0);
  });

  it("runs every gate before a byte moves", async () => {
    const { owner, vault } = await setup("intent-gates");
    const sha = shaOf(PNG);

    expect((await intent(null, vault, { sha256: sha, size: 1 })).status).toBe(401);

    const outsider = await signUp("outsider@intent-gates.com");
    expect((await intent(outsider, vault, { sha256: sha, size: 1 })).status).toBe(403);

    const bad = async (body: Record<string, unknown>) =>
      (await (await intent(owner, vault, body)).json()) as Intent;

    expect((await bad({ sha256: "nope", size: 10 })).code).toBe("invalid_sha256");
    expect((await bad({ sha256: sha, size: 0 })).code).toBe("invalid_size");
    expect((await bad({ sha256: sha, size: 10, relPath: "../etc/passwd" })).code).toBe(
      "invalid_rel_path",
    );
    // Outside `attachments/` is refused too: the desktop writes a
    // server-supplied rel_path through `ensure_attachment_rel`.
    expect((await bad({ sha256: sha, size: 10, relPath: "Notes/x.png" })).code).toBe(
      "invalid_rel_path",
    );
    expect(
      (await bad({
        sha256: sha,
        size: 10,
        relPath: "attachments/a.exe",
        mime: "application/x-msdownload",
      })).code,
    ).toBe("unsupported_media_type");
    // Per-category cap, clamped to the provider's own ceiling (25 MB here).
    expect(
      (await bad({
        sha256: sha,
        size: 400 * 1024 * 1024,
        relPath: "attachments/a.mp4",
        mime: "video/mp4",
      })).code,
    ).toBe("attachment_too_large");
  });
});

describe("GET /api/blobs/:id/url", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("answers the same callers the download does, and nobody else", async () => {
    const { owner, org, vault } = await setup("bloburl");
    const plan = (await (
      await intent(owner, vault, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/a.png",
      })
    ).json()) as Intent;
    await putData(plan.upload!.url, PNG, plan.upload!.headers);
    await complete(owner, plan.blobId!);

    const url = (token: string | null, id: string) =>
      app.fetch(
        new Request(`http://local/api/blobs/${id}/url`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );

    expect((await url(null, plan.blobId!)).status).toBe(401);

    const outsider = await signUp("outsider@bloburl.com");
    expect((await url(outsider.token, plan.blobId!)).status).toBe(403);

    expect((await url(owner.token, "00000000-0000-0000-0000-000000000000")).status).toBe(404);

    const member = await signUp("member@bloburl.com");
    await seedMember(org, member.userId, "member");
    const ok = await url(member.token, plan.blobId!);
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { url: string; expiresAt: number | null };
    // The Postgres provider has nothing to presign: a same-origin URL to the
    // download route, which the caller's own bearer authorizes.
    expect(payload.url).toContain(`/api/blobs/${plan.blobId}`);
    expect(payload.expiresAt).toBeNull();
  });
});
