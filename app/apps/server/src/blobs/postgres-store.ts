/**
 * Postgres BYTEA provider — the zero-configuration default, and exactly the
 * behaviour that shipped before the adapter existed.
 *
 * There is no object namespace here: an attachment's bytes are the `data`
 * column of its own `blobs` row, so the key IS the row id (see
 * `store.ts storageKeyForRow`) and `blobs.storage_key` stays NULL for these
 * rows. `put` therefore writes bytes into a row the caller already created,
 * and `delete` nulls the column rather than removing the row — the row is
 * metadata the routes own.
 *
 * HEAP HONESTY. `put` consumes its `Readable` into a single Buffer and encodes
 * that to base64 before handing it to `pg`. It cannot do better: node-postgres
 * has no binary parameter protocol and no way to stream a parameter in, so the
 * whole value is resident, twice, at the moment of the write. `get` is the same
 * shape in reverse — pg renders BYTEA as a hex string of twice the blob's size
 * before decoding it to a Buffer, so a "stream" from this provider is a Buffer
 * wearing a stream's clothes. {@link MAX_BLOB_BYTES} and the `ByteBudget` are
 * what actually bound this provider's memory; the adapter does not change that,
 * it just gives a provider that CAN stream somewhere to live.
 */
import { Readable } from "node:stream";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { MAX_BLOB_BYTES, UPLOAD_TOKEN_TTL_SECONDS } from "./config.js";
import type { BlobProvider } from "./config.js";
import { CATEGORY_MAX_BYTES, type FormatCategory } from "./formats.js";
import { mintUploadToken } from "./upload-token.js";
import {
  BlobStoreError,
  type BlobStore,
  type CompletedPart,
  type GetOptions,
  type GetResult,
  type HeadResult,
  type PresignMultipartInput,
  type PresignUploadInput,
  type PresignedMultipart,
  type PresignedPart,
  type PresignedUpload,
  type PutInput,
  type PutResult,
  type Queryable,
} from "./store.js";

/** Absolute origin for the same-origin upload URL, the way every other
 *  absolute URL this server hands out is built. */
function publicOrigin(): string {
  try {
    return new URL(config.betterAuthUrl).origin;
  } catch {
    return "";
  }
}

/** Collect a stream into one Buffer, without a needless copy of a single chunk. */
async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks);
}

export class PostgresBlobStore implements BlobStore {
  readonly provider: BlobProvider = "postgres";

  /** No multipart: there is no object store to assemble parts in, and the
   *  25 MB transport bound is far below any threshold worth splitting. */
  readonly multipartThresholdBytes = null;

  async put(input: PutInput, db: Queryable = pool): Promise<PutResult> {
    const buf = await collect(input.body);
    // base64 + server-side `decode`, not a raw Buffer parameter. Handed a
    // Buffer, node-postgres renders it as a `\x…` HEX string — 2 bytes of JS
    // string per payload byte — and then serializes that into the outgoing
    // buffer, ~4N on top of the body. base64 is 1.33 bytes per payload byte, so
    // this cuts the dominant allocation on the upload path by a third. Bytes
    // stored are identical.
    const { rowCount } = await db.query(
      `UPDATE blobs
          SET data = decode($2::text, 'base64'),
              size = $3,
              updated_at = now()
        WHERE id = $1`,
      [input.key, buf.toString("base64"), buf.byteLength],
    );
    if (!rowCount) {
      throw new BlobStoreError("not_found", `no blobs row for key ${input.key}`);
    }
    return { key: input.key, size: buf.byteLength };
  }

  async get(key: string, _opts: GetOptions = {}): Promise<GetResult> {
    // Ranges are not served: the whole value has to be detoasted and rendered
    // to reach any byte of it, so a range would cost exactly what the full read
    // costs while pretending otherwise. The route answers `Accept-Ranges: none`.
    const { rows } = await pool.query<{ data: Buffer | null }>(
      "SELECT data FROM blobs WHERE id = $1",
      [key],
    );
    const data = rows[0]?.data;
    if (!data) throw new BlobStoreError("not_found", `no bytes stored for blob ${key}`);
    return {
      kind: "stream",
      body: Readable.from(data),
      size: data.byteLength,
      totalSize: data.byteLength,
      acceptRanges: false,
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    const { rows } = await pool.query<{ size: string | number | null }>(
      "SELECT octet_length(data) AS size FROM blobs WHERE id = $1",
      [key],
    );
    const size = rows[0]?.size;
    if (size === undefined || size === null) return null;
    return { size: Number(size) };
  }

  async delete(key: string): Promise<void> {
    // Nulls the bytes; the row itself is metadata the routes own (and PR 2c's
    // lifecycle work is what removes it). `data` has been nullable since 002.
    //
    // Operator note: nulling a BYTEA does not return disk to the filesystem —
    // the dead tuple needs `VACUUM (FULL)` or `pg_repack` for that.
    await pool.query("UPDATE blobs SET data = NULL, updated_at = now() WHERE id = $1", [key]);
  }

  /**
   * The Postgres half of a presigned URL: a same-origin
   * `PUT /api/blobs/:id/data?t=<HS256 upload token>`.
   *
   * There is no object store to presign against, so this server IS the object
   * store and the token is the signature. The point is that the CLIENT cannot
   * tell the difference — `intent` returns the same `{method, url, headers,
   * expiresAt}` shape for both providers, so `AttachmentSync` has one code path
   * and a self-hoster who never configures a bucket gets the same dedupe-first,
   * zero-byte-for-known-content flow as a managed instance.
   *
   * `direct: false` is the one honest difference, and it is advisory: it tells
   * a client the bytes will pass through the API (so the server's own size cap
   * applies, and a progress bar should expect one hop, not two).
   */
  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const token = await mintUploadToken(
      {
        blobId: input.blobId,
        vaultId: input.vaultId,
        sha256: input.sha256,
        size: input.size,
      },
      UPLOAD_TOKEN_TTL_SECONDS,
    );
    const origin = input.origin ?? publicOrigin();
    return {
      method: "PUT",
      url: `${origin}/api/blobs/${encodeURIComponent(input.blobId)}/data?t=${encodeURIComponent(token)}`,
      headers: {
        "content-type": input.mime,
        "content-length": String(input.size),
      },
      expiresAt: Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000,
      direct: false,
    };
  }

  async presignMultipart(_input: PresignMultipartInput): Promise<PresignedMultipart> {
    throw new BlobStoreError(
      "not_supported",
      "the postgres provider has no multipart upload — its whole ceiling is one MAX_BLOB_BYTES body",
    );
  }

  async presignParts(
    _key: string,
    _uploadId: string,
    _partNumbers: number[],
  ): Promise<{ parts: PresignedPart[]; expiresAt: number }> {
    throw new BlobStoreError("not_supported", "the postgres provider has no multipart upload");
  }

  async completeMultipart(
    _key: string,
    _uploadId: string,
    _parts: CompletedPart[],
  ): Promise<PutResult> {
    throw new BlobStoreError("not_supported", "the postgres provider has no multipart upload");
  }

  async abortMultipart(_key: string, _uploadId: string): Promise<void> {
    throw new BlobStoreError("not_supported", "the postgres provider has no multipart upload");
  }

  /** No-op: nothing to abandon. The sweep calls this on every pending row. */
  async abortMultipartsForKey(_key: string): Promise<void> {}

  async peek(key: string, bytes: number): Promise<Buffer | null> {
    const { rows } = await pool.query<{ head: Buffer | null }>(
      "SELECT substring(data from 1 for $2) AS head FROM blobs WHERE id = $1",
      [key, Math.max(1, Math.trunc(bytes))],
    );
    return rows[0]?.head ?? null;
  }

  maxBytes(category: FormatCategory): number {
    // Every category clamps to the transport bound: this provider buffers the
    // whole value in the Node heap, so a 500 MB video cap would be a promise it
    // cannot keep.
    return Math.min(CATEGORY_MAX_BYTES[category], MAX_BLOB_BYTES);
  }
}
