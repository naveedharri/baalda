import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { S3BlobStore } from "../src/blobs/s3-store.js";
import type { S3Config } from "../src/blobs/config.js";
import { objectKey } from "../src/blobs/keys.js";
import { BlobStoreError } from "../src/blobs/store.js";

/**
 * The S3 provider against a REAL S3-compatible bucket.
 *
 * Skipped unless `S3_TEST_ENDPOINT` is set, and deliberately not wired to a
 * Docker fixture: the suite has to pass on a laptop with nothing running, and
 * the value of this file is that it catches the things a mock cannot — a
 * gateway that rejects the SDK's default CRC32 trailer, a presign whose signed
 * `content-length` is not actually enforced, a Range request a gateway ignores.
 *
 * To run it (MinIO, from `deploy/compose/`):
 *
 *   docker compose --profile minio up -d minio
 *   docker compose exec minio mc alias set local http://localhost:9000 <user> <password>
 *   docker compose exec minio mc mb local/baalda-test
 *
 *   S3_TEST_ENDPOINT=http://localhost:9000 \
 *   S3_TEST_BUCKET=baalda-test \
 *   S3_TEST_ACCESS_KEY_ID=... \
 *   S3_TEST_SECRET_ACCESS_KEY=... \
 *   pnpm vitest run tests/blob-s3.test.ts
 *
 * Point the same four vars at Cloudflare R2 (with `S3_TEST_FORCE_PATH_STYLE=false`)
 * to check the other gateway we care about.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const enabled = Boolean(endpoint && process.env.S3_TEST_BUCKET);

function testConfig(overrides: Partial<S3Config> = {}): S3Config {
  return {
    bucket: process.env.S3_TEST_BUCKET as string,
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    endpoint,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin",
    // MinIO has no bucket-per-subdomain DNS; R2 does. Defaults to true here
    // because MinIO is what this file is normally pointed at.
    forcePathStyle: (process.env.S3_TEST_FORCE_PATH_STYLE ?? "true") !== "false",
    presignUploadTtlSeconds: 900,
    presignDownloadTtlSeconds: 300,
    proxyDownloads: false,
    // Never `sha256` against a custom endpoint — R2 has no
    // `x-amz-checksum-sha256` and the upload would fail 100% of the time.
    checksumMode: "none",
    multipartThresholdBytes: 100 * 1024 * 1024,
    multipartPartBytes: 16 * 1024 * 1024,
    ...overrides,
  };
}

const stores: S3BlobStore[] = [];
function store(overrides: Partial<S3Config> = {}): S3BlobStore {
  const s = new S3BlobStore(testConfig(overrides));
  stores.push(s);
  return s;
}

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

afterAll(() => {
  for (const s of stores) s.destroy();
});

describe.skipIf(!enabled)("S3BlobStore against a real bucket", () => {
  it("put → get → head → peek → delete round-trips byte-identically", async () => {
    const s = store({ proxyDownloads: true });
    const key = objectKey("vault-test", SHA + randomUUID().replace(/-/g, ""));

    const put = await s.put({
      key,
      blobId: "b1",
      vaultId: "vault-test",
      body: Readable.from(BYTES),
      size: BYTES.byteLength,
      mime: "image/png",
      sha256: SHA,
      filename: "logo.png",
      relPath: "attachments/logo.png",
    });
    expect(put.size).toBe(BYTES.byteLength);

    const got = await s.get(key, { mime: "image/png" });
    expect(got.kind).toBe("stream");
    if (got.kind !== "stream") throw new Error("unreachable");
    const chunks: Buffer[] = [];
    for await (const chunk of got.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(BYTES)).toBe(true);

    expect(await s.head(key)).toEqual({ size: BYTES.byteLength });
    const head = await s.peek(key, 4);
    expect(head && Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47]);

    await s.delete(key);
    expect(await s.head(key)).toBeNull();
    // Deleting an object that is not there is a no-op, never an error — the
    // sweep calls it speculatively.
    await expect(s.delete(key)).resolves.toBeUndefined();
  });

  it("stores a prefixed key at the prefixed path, and nowhere else", async () => {
    // The whole point of S3_KEY_PREFIX: a staging deployment writing into the
    // same bucket as production must not touch production's key space.
    const s = store({ proxyDownloads: true });
    const sha = randomUUID().replace(/-/g, "").repeat(2);
    const key = objectKey("vault-test", sha, "prefix-test");
    expect(key).toBe(`prefix-test/${objectKey("vault-test", sha, "")}`);

    await s.put({
      key,
      blobId: "b-prefix",
      vaultId: "vault-test",
      body: Readable.from(BYTES),
      size: BYTES.byteLength,
      mime: "application/octet-stream",
      sha256: SHA,
      filename: null,
    });
    expect(await s.head(key)).toEqual({ size: BYTES.byteLength });
    // Same vault, same bytes, no prefix — a different object entirely.
    expect(await s.head(objectKey("vault-test", sha, ""))).toBeNull();
    await s.delete(key);
  });

  it("serves a byte range with the totals a 206 needs", async () => {
    const s = store({ proxyDownloads: true });
    const key = objectKey("vault-test", randomUUID().replace(/-/g, "").repeat(2));
    await s.put({
      key,
      blobId: "b2",
      vaultId: "vault-test",
      body: Readable.from(BYTES),
      size: BYTES.byteLength,
      mime: "application/octet-stream",
      sha256: SHA,
      filename: null,
    });
    const got = await s.get(key, { range: { start: 4, end: 7 } });
    if (got.kind !== "stream") throw new Error("expected a proxied stream");
    expect(got.range).toEqual({ start: 4, end: 7 });
    expect(got.totalSize).toBe(BYTES.byteLength);
    const chunks: Buffer[] = [];
    for await (const chunk of got.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(BYTES.subarray(4, 8))).toBe(true);
    await s.delete(key);
  });

  it("missing objects are not_found / null, never a throw the routes can't type", async () => {
    const s = store({ proxyDownloads: true });
    const key = objectKey("vault-test", "f".repeat(64));
    expect(await s.head(key)).toBeNull();
    expect(await s.peek(key, 16)).toBeNull();
    const err = await s.get(key).catch((e) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect((err as BlobStoreError).code).toBe("not_found");
  });

  it("presigns an upload whose content-length is part of the SIGNATURE", async () => {
    const s = store();
    const key = objectKey("vault-test", randomUUID().replace(/-/g, "").repeat(2));
    const presigned = await s.presignUpload({
      key,
      blobId: "b3",
      vaultId: "vault-test",
      size: BYTES.byteLength,
      mime: "image/png",
      sha256: SHA,
    });
    expect(presigned.direct).toBe(true);
    expect(presigned.headers["content-length"]).toBe(String(BYTES.byteLength));
    // Rule 2: this header is what breaks every R2 upload, and `auto` must never
    // produce it against a custom endpoint.
    expect(presigned.headers["x-amz-checksum-sha256"]).toBeUndefined();
    // Rule 3, and the assertion that matters: `content-length` is SIGNED, so
    // the bucket itself refuses a body of any other length. Presigned POST's
    // `content-length-range` would be the cleaner mechanism, but R2 has no
    // presigned POST — this is the portable one, and it only works if the
    // header is actually in `X-Amz-SignedHeaders`.
    const signedHeaders = new URL(presigned.url).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders.split(";")).toContain("content-length");
    expect(signedHeaders.split(";")).toContain("content-type");

    const ok = await fetch(presigned.url, {
      method: "PUT",
      // `content-length` is a forbidden header for fetch — the runtime sets it
      // from the body, which is exactly the value that was signed.
      headers: { "content-type": presigned.headers["content-type"] },
      body: BYTES,
    });
    expect(ok.status).toBe(200);
    expect(await s.head(key)).toEqual({ size: BYTES.byteLength });

    // A body of a DIFFERENT length is a different content-length, so the
    // signature no longer matches and the bucket rejects it.
    const lying = await fetch(presigned.url, {
      method: "PUT",
      headers: { "content-type": presigned.headers["content-type"] },
      body: Buffer.concat([BYTES, BYTES]),
    });
    expect(lying.ok).toBe(false);

    await s.delete(key);
  });

  it("presigns a download with the type and disposition pinned by the ROW", async () => {
    const s = store();
    const key = objectKey("vault-test", randomUUID().replace(/-/g, "").repeat(2));
    // An object whose OWN metadata says text/html — i.e. what an uploader would
    // choose if they wanted a browser to execute their bytes on our origin.
    await s.put({
      key,
      blobId: "b4",
      vaultId: "vault-test",
      body: Readable.from(BYTES),
      size: BYTES.byteLength,
      mime: "text/html",
      sha256: SHA,
      filename: "evil.html",
    });

    const got = await s.get(key, {
      mime: "application/octet-stream",
      filename: "evil.html",
      disposition: "attachment",
    });
    expect(got.kind).toBe("redirect");
    if (got.kind !== "redirect") throw new Error("unreachable");
    expect(got.expiresAt).toBeGreaterThan(Date.now());

    const res = await fetch(got.url);
    expect(res.status).toBe(200);
    // The row won, not the object.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    await s.delete(key);
  });

  it("runs a presigned multipart upload end to end", async () => {
    // A 6 MB object in two parts: over S3's 5 MB minimum for a non-final part,
    // small enough to move in a test.
    const partBytes = 5 * 1024 * 1024;
    const payload = Buffer.alloc(partBytes + 1024, 0x61);
    const s = store({ multipartThresholdBytes: 1, multipartPartBytes: partBytes });
    const key = objectKey("vault-test", randomUUID().replace(/-/g, "").repeat(2));

    const plan = await s.presignMultipart({
      key,
      blobId: "b5",
      vaultId: "vault-test",
      size: payload.byteLength,
      mime: "video/mp4",
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(plan.parts).toHaveLength(2);

    const completed = [];
    for (const part of plan.parts) {
      const slice = payload.subarray(
        (part.partNumber - 1) * plan.partBytes,
        part.partNumber * plan.partBytes,
      );
      const res = await fetch(part.url, { method: "PUT", body: slice });
      expect(res.status).toBe(200);
      completed.push({ partNumber: part.partNumber, etag: res.headers.get("etag") as string });
    }

    const result = await s.completeMultipart(key, plan.uploadId, completed);
    // Verification keys off the real size, never the ETag: a multipart ETag is
    // a hash of hashes, not of the content.
    expect(result.size).toBe(payload.byteLength);
    await s.delete(key);
  });

  it("abandons an upload by key, which is all the sweep knows", async () => {
    const s = store({ multipartThresholdBytes: 1, multipartPartBytes: 5 * 1024 * 1024 });
    const key = objectKey("vault-test", randomUUID().replace(/-/g, "").repeat(2));
    const plan = await s.presignMultipart({
      key,
      blobId: "b6",
      vaultId: "vault-test",
      size: 6 * 1024 * 1024,
      mime: "video/mp4",
      sha256: SHA,
    });
    expect(plan.uploadId).toBeTruthy();
    // There is no column for an upload id, so the sweep aborts by key.
    await expect(s.abortMultipartsForKey(key)).resolves.toBeUndefined();
    // Idempotent: an upload that is already gone must not fail a cleanup.
    await expect(s.abortMultipart(key, plan.uploadId)).resolves.toBeUndefined();
  });
});

/**
 * The ROUTES with S3 behind them — intent hands out a presigned bucket URL, the
 * client PUTs straight to the bucket, complete verifies and publishes.
 *
 * Needs the server itself configured for S3 (`BLOB_STORAGE=s3` plus `S3_BUCKET`
 * / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`), because `BLOB_STORAGE` is read
 * once at module load — that is the same fail-closed read production does, and
 * faking it would test something the server never runs:
 *
 *   BLOB_STORAGE=s3 S3_ENDPOINT=http://localhost:9000 S3_FORCE_PATH_STYLE=true \
 *   S3_BUCKET=baalda-test S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   S3_CHECKSUM_MODE=none S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=baalda-test \
 *   pnpm vitest run tests/blob-s3.test.ts
 */
const routesEnabled = enabled && process.env.BLOB_STORAGE === "s3";

describe.skipIf(!routesEnabled)("blob routes on the S3 provider", () => {
  it("intent → direct PUT → complete, then a presigned download URL", async () => {
    const { createApp } = await import("../src/http/app.js");
    const { testAppDeps } = await import("./helpers/app.js");
    const { resetDb } = await import("./helpers/db.js");
    const { signUp } = await import("./helpers/auth.js");
    const { seedMember, seedOrg, seedVault, seedVaultGrant } = await import("./helpers/seed.js");
    const { pool } = await import("../src/db/pool.js");

    await resetDb();
    const app = createApp(testAppDeps());
    const owner = await signUp("owner@s3routes.com");
    const org = await seedOrg("Acme", "acme-s3routes");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");

    const res = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs/intent`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          sha256: SHA,
          size: BYTES.byteLength,
          mime: "image/png",
          relPath: "attachments/logo.png",
          filename: "logo.png",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      blobId: string;
      upload: { kind: string; url: string; headers: Record<string, string>; direct: boolean };
    };
    // The bucket's URL, not ours — the bytes never touch this process.
    expect(plan.upload.direct).toBe(true);
    expect(plan.upload.url).toContain(process.env.S3_TEST_ENDPOINT as string);

    const put = await fetch(plan.upload.url, {
      method: "PUT",
      headers: { "content-type": plan.upload.headers["content-type"] },
      body: BYTES,
    });
    expect(put.status).toBe(200);

    const done = await app.fetch(
      new Request(`http://local/api/blobs/${plan.blobId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(done.status).toBe(200);
    expect((await done.json()).size).toBe(BYTES.byteLength);

    // Download: a JSON URL for the desktop (no redirect for reqwest to forward
    // a bearer across), and a 302 for a browser context.
    const urlRes = await app.fetch(
      new Request(`http://local/api/blobs/${plan.blobId}/url`, {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(urlRes.status).toBe(200);
    const { url, expiresAt } = (await urlRes.json()) as { url: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());
    const fetched = await fetch(url);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(BYTES)).toBe(true);

    const redirect = await app.fetch(
      new Request(`http://local/api/blobs/${plan.blobId}`, {
        headers: { authorization: `Bearer ${owner.token}` },
        redirect: "manual",
      }),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toContain("X-Amz-Signature");

    await pool.end();
  });
});
