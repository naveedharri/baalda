import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedOrg, seedVault } from "./helpers/seed.js";
import { MemoryBlobStore } from "../src/blobs/memory-store.js";
import { PostgresBlobStore } from "../src/blobs/postgres-store.js";
import { BlobStoreError, type BlobStore } from "../src/blobs/store.js";
import { objectKey } from "../src/blobs/keys.js";

/**
 * ONE conformance suite, run against every provider.
 *
 * The point of the adapter is that the routes cannot tell which store they are
 * talking to, and the only way to keep that true is to assert the contract —
 * not an implementation — against more than one implementation. The Postgres
 * provider has no object namespace (the bytes are a column of the blob's own
 * row), so each provider says how a key comes into existence; everything after
 * that is identical.
 */
interface Provider {
  name: string;
  store: () => BlobStore;
  /** Make `key` writable, and return it. */
  prepare: (key: string) => Promise<string>;
  /** A key that has never existed. */
  missingKey: () => string;
}

let vaultId = "";

const PROVIDERS: Provider[] = [
  {
    name: "memory",
    store: () => new MemoryBlobStore(),
    prepare: async (key) => key,
    missingKey: () => `vaults/none/${randomUUID()}`,
  },
  {
    name: "postgres",
    store: () => new PostgresBlobStore(),
    prepare: async (key) => {
      // The row is the object: `put` writes into a row the routes created.
      await pool.query(
        `INSERT INTO blobs (id, vault_id, sha256, size, mime, rel_path, filename,
                            storage_provider, status)
         VALUES ($1, $2, $3, 0, 'application/octet-stream', $4, 'x.bin', 'postgres', 'pending')`,
        [key, vaultId, randomUUID().replace(/-/g, ""), `attachments/${key}.bin`],
      );
      return key;
    },
    missingKey: () => randomUUID(),
  },
];

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x42, 0x00, 0x01]);

describe.each(PROVIDERS)("BlobStore conformance — $name", (provider) => {
  beforeAll(async () => {
    await resetDb();
    const org = await seedOrg("Store Co", `store-${provider.name}`);
    vaultId = await seedVault(org);
  });
  afterAll(async () => {
    if (provider === PROVIDERS[PROVIDERS.length - 1]) await pool.end();
  });

  it("put → get → head → peek → delete round-trips byte-identically", async () => {
    const store = provider.store();
    const key = await provider.prepare(randomUUID());

    const put = await store.put({
      key,
      blobId: key,
      vaultId,
      body: Readable.from(BYTES),
      size: BYTES.byteLength,
      mime: "application/octet-stream",
      sha256: "0".repeat(64),
      filename: "x.bin",
    });
    expect(put.size).toBe(BYTES.byteLength);

    const got = await store.get(key);
    expect(got.kind).toBe("stream");
    if (got.kind !== "stream") throw new Error("unreachable");
    expect(got.size).toBe(BYTES.byteLength);
    const chunks: Buffer[] = [];
    for await (const chunk of got.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(BYTES)).toBe(true);

    expect(await store.head(key)).toEqual({ size: BYTES.byteLength });
    const head = await store.peek(key, 4);
    expect(head && Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47]);

    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    await expect(store.get(key)).rejects.toThrow(BlobStoreError);
  });

  it("get on a key that was never written throws not_found", async () => {
    const store = provider.store();
    const err = await store.get(provider.missingKey()).catch((e) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect((err as BlobStoreError).code).toBe("not_found");
  });

  it("head and peek answer null for a missing key, and delete is a no-op", async () => {
    const store = provider.store();
    const key = provider.missingKey();
    expect(await store.head(key)).toBeNull();
    expect(await store.peek(key, 8)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("presignUpload is honest about what the provider cannot do", async () => {
    const store = provider.store();
    const input = {
      key: objectKey(vaultId, "a".repeat(64)),
      blobId: randomUUID(),
      vaultId,
      size: 10,
      mime: "image/png",
      sha256: "a".repeat(64),
    };
    if (provider.name === "postgres") {
      // No object store to presign against — PR 2b gives it a signed same-origin
      // PUT instead. It must SAY so, not return something unusable.
      const err = await store.presignUpload(input).catch((e) => e);
      expect(err).toBeInstanceOf(BlobStoreError);
      expect((err as BlobStoreError).code).toBe("not_supported");
    } else {
      expect((await store.presignUpload(input)).method).toBe("PUT");
    }
  });

  it("clamps every category ceiling to what the provider can hold", async () => {
    const store = provider.store();
    // The video category asks for 500 MB; Postgres buffers whole values in the
    // Node heap, so it must not promise more than MAX_BLOB_BYTES (25 MB).
    const video = store.maxBytes("video");
    expect(video).toBeGreaterThan(0);
    if (provider.name === "postgres") expect(video).toBe(25 * 1024 * 1024);
  });
});

describe("objectKey", () => {
  it("is vault-scoped and content-addressed, with no extension", () => {
    expect(objectKey("v1", "abc")).toBe("vaults/v1/abc");
    // Same bytes in two vaults are two objects: deleting one vault can never
    // pull a file out from under another.
    expect(objectKey("v2", "abc")).not.toBe(objectKey("v1", "abc"));
  });
});
