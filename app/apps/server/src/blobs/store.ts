/**
 * The attachment storage adapter.
 *
 * One interface over "where an attachment's bytes live". Today there is exactly
 * one implementation that stores anything real (Postgres BYTEA, unchanged from
 * what shipped) plus an in-memory double for tests; an S3/R2 provider is the
 * reason the seam exists.
 *
 * Two rules the rest of the server depends on:
 *
 *  1. **Reads dispatch on the ROW, never on the env var.** A blob written while
 *     `BLOB_STORAGE=s3` must still be readable after an operator flips back to
 *     `postgres`, so `blobs.storage_provider` — recorded at write time — is what
 *     picks the store ({@link resolveStoreForRow}). A row whose provider this
 *     build cannot serve is a 503 `storage_unavailable`, never a 404: a 404
 *     tells the desktop's attachment diff the blob is gone and it re-uploads
 *     the whole thing.
 *  2. **The store owns bytes, the routes own the row.** `put` writes an
 *     object for a `blobs` row the caller has already created; it never invents
 *     rows, ACL or dedupe policy.
 */
import type { Readable } from "node:stream";
import type { BlobProvider } from "./config.js";
import { BLOB_STORAGE, s3Config } from "./config.js";
import type { FormatCategory } from "./formats.js";

/** Typed failures every provider raises, so routes can map them to statuses. */
export type BlobStoreErrorCode =
  /** No object at this key. Routes answer 404. */
  | "not_found"
  /** The provider exists but cannot do this (e.g. postgres presign). Routes answer 501/503. */
  | "not_supported"
  /** The row names a provider this build has no working config for. Routes answer 503. */
  | "storage_unavailable";

export class BlobStoreError extends Error {
  constructor(
    readonly code: BlobStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BlobStoreError";
  }
}

/**
 * A minimal `pg` executor, so a `put` can be enlisted in a caller's
 * transaction. Providers that are not a database ignore it.
 */
export interface Queryable {
  query<R extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<import("pg").QueryResult<R>>;
}

export interface PutInput {
  /** Provider-addressable object key (see {@link resolveStoreForRow} for what it means per provider). */
  key: string;
  /** `blobs.id` of the row these bytes belong to. */
  blobId: string;
  vaultId: string;
  body: Readable;
  size: number;
  mime: string;
  sha256: string;
  filename: string | null;
  /** Vault-relative path, for a provider that can carry it as object metadata. */
  relPath?: string | null;
}

export interface PutResult {
  key: string;
  size: number;
}

export interface GetOptions {
  /** Byte range the caller asked for. Providers that cannot serve one ignore it. */
  range?: { start: number; end?: number };
  /**
   * `Content-Type` the response must carry.
   *
   * Passed in from the ROW, never read off the stored object. An uploader
   * controls what it PUTs to a presigned URL, including the object's own
   * `Content-Type` metadata, so letting the bucket choose the download's type
   * would hand an attacker `text/html` on a URL a browser will happily open.
   * The route decides it from `blobs.mime` (and its own inline/attachment
   * policy) and the provider pins it — for S3 via `response-content-type`,
   * which overrides the object's metadata in the presigned GET itself.
   */
  mime?: string;
  /** Filename for `Content-Disposition`. Same rule: from the row, not the object. */
  filename?: string | null;
  /** Defaults to `attachment`; only passive, allow-listed media is ever `inline`. */
  disposition?: "inline" | "attachment";
}

export type GetResult =
  | {
      kind: "stream";
      body: Readable;
      /** Bytes in `body` (the range's length when a range was served). */
      size: number;
      /** Full object size, for `Content-Range`. */
      totalSize: number;
      /** False ⇒ the route must answer `Accept-Ranges: none`. */
      acceptRanges: boolean;
      /** Set only when a range was actually honoured. */
      range?: { start: number; end: number };
    }
  | { kind: "redirect"; url: string; expiresAt: number };

export interface HeadResult {
  size: number;
}

export interface PresignUploadInput {
  key: string;
  blobId: string;
  vaultId: string;
  size: number;
  mime: string;
  sha256: string;
  /**
   * Absolute origin for a provider whose upload URL points back at THIS server
   * (the Postgres one). Absent ⇒ the provider falls back to `BETTER_AUTH_URL`,
   * which is what every other absolute URL this server hands out is built from.
   */
  origin?: string;
  /**
   * Base64 `Content-MD5` the client will send, when it has one. Only used when
   * `S3_CHECKSUM_MODE` resolves to `md5`; absent ⇒ no checksum header is signed
   * and integrity rests on the size check and the sniff at `complete`.
   */
  md5Base64?: string;
}

export interface PresignedUpload {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  /** Epoch ms. */
  expiresAt: number;
  /** True when the client talks to the object store directly (no server hop). */
  direct: boolean;
}

export interface PresignMultipartInput extends PresignUploadInput {
  /** Bytes per part. The provider clamps it to its own legal range. */
  partBytes?: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface PresignedMultipart {
  /** Opaque id the client echoes back on `complete` and on further part presigns. */
  uploadId: string;
  partBytes: number;
  parts: PresignedPart[];
  /** Epoch ms. */
  expiresAt: number;
  direct: boolean;
}

/** One finished part, as the client reports it. */
export interface CompletedPart {
  partNumber: number;
  /** The `ETag` header the part's PUT returned. Quoting is normalised by the provider. */
  etag: string;
}

export interface BlobStore {
  readonly provider: BlobProvider;

  /**
   * Size at which this provider wants a multipart upload, or null when it has
   * no multipart at all (then the routes always presign a single PUT).
   */
  readonly multipartThresholdBytes: number | null;

  /**
   * Write an object for an existing `blobs` row. `db` lets a database-backed
   * provider join the caller's transaction; others ignore it.
   */
  put(input: PutInput, db?: Queryable): Promise<PutResult>;

  /** Read an object. Throws {@link BlobStoreError} `not_found` when there is none. */
  get(key: string, opts?: GetOptions): Promise<GetResult>;

  /** Object size, or null when the object does not exist. */
  head(key: string): Promise<HeadResult | null>;

  /** Remove an object. Deleting one that is not there is a no-op, never an error. */
  delete(key: string): Promise<void>;

  /**
   * A URL the client may upload to directly.
   *
   * The Postgres provider throws `not_supported`: there is no object store to
   * presign against. PR 2b gives it a same-origin `PUT /api/blobs/:id/data?t=`
   * signed with an HS256 upload token, so the `intent → PUT → complete` flow is
   * identical for both providers and the desktop never branches on one.
   */
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;

  /**
   * First `bytes` bytes of an object, for a magic-byte check after a direct
   * upload the server never saw. Null when the object does not exist.
   */
  peek(key: string, bytes: number): Promise<Buffer | null>;

  /**
   * Begin a multipart upload and presign its first parts.
   *
   * Providers without multipart throw `not_supported`; the routes only reach
   * this when {@link multipartThresholdBytes} is non-null, so the throw is a
   * bug-catcher rather than a path a client can drive into.
   */
  presignMultipart(input: PresignMultipartInput): Promise<PresignedMultipart>;

  /** Presign more parts of an upload already in progress. */
  presignParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ parts: PresignedPart[]; expiresAt: number }>;

  /** Assemble the parts into the final object. Returns its size. */
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<PutResult>;

  /**
   * Abandon an upload and discard its parts. Must be safe to call on an upload
   * that is already gone — the sweep calls it speculatively.
   */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /**
   * Abandon EVERY multipart upload outstanding for this key.
   *
   * The pending sweep has a row and a key but no upload id (there is no column
   * for one — an upload id lives in the client's hands for the life of the
   * upload and nowhere else), so this is how abandoned parts stop being billed.
   * A provider without multipart makes it a no-op.
   */
  abortMultipartsForKey(key: string): Promise<void>;

  /** This provider's ceiling for a category — the category cap clamped to what it can hold. */
  maxBytes(category: FormatCategory): number;
}

/** Shape of the `blobs` columns that decide which store serves a row. */
export interface StorageRow {
  id: string;
  storage_provider?: string | null;
  storage_key?: string | null;
}

/**
 * The address of a row's bytes within its provider.
 *
 * Postgres has no object namespace: the bytes ARE a column of the row, so the
 * row's primary key is its key, and `storage_key` stays NULL (which is why
 * migration 026 requires it only for non-postgres rows — no backfill).
 */
export function storageKeyForRow(row: StorageRow): string {
  const provider = (row.storage_provider ?? "postgres").toLowerCase();
  if (provider === "postgres") return row.id;
  const key = row.storage_key;
  if (!key) {
    throw new BlobStoreError(
      "storage_unavailable",
      `blob ${row.id} is stored on \`${provider}\` but has no storage_key`,
    );
  }
  return key;
}

let postgresStore: BlobStore | undefined;
async function getPostgresStore(): Promise<BlobStore> {
  if (!postgresStore) {
    const { PostgresBlobStore } = await import("./postgres-store.js");
    postgresStore = new PostgresBlobStore();
  }
  return postgresStore;
}

let s3Store: BlobStore | undefined;
/**
 * The S3 provider, or `storage_unavailable` when this build has no bucket
 * configured. Imported lazily so a Postgres-only deployment never loads the AWS
 * SDK (it is several MB of JS, and the module graph is walked at startup).
 */
async function getS3Store(reason: string): Promise<BlobStore> {
  if (!s3Store) {
    const cfg = s3Config();
    if (!cfg) throw new BlobStoreError("storage_unavailable", reason);
    const { S3BlobStore } = await import("./s3-store.js");
    s3Store = new S3BlobStore(cfg);
  }
  return s3Store;
}

/** The store NEW blobs are written to, per {@link BLOB_STORAGE}. */
export function createBlobStore(): Promise<BlobStore> {
  // `config.ts` already failed the process closed on anything but `postgres`;
  // this switch is what makes adding a provider a compile error rather than a
  // silent default.
  switch (BLOB_STORAGE) {
    case "postgres":
      return getPostgresStore();
    case "s3":
      // `config.ts` already refused to start without a complete bucket config,
      // so this can only fail if the environment changed under a running
      // process.
      return getS3Store("BLOB_STORAGE=s3 but no S3 bucket is configured");
    default:
      throw new BlobStoreError(
        "storage_unavailable",
        `BLOB_STORAGE=${BLOB_STORAGE} has no implementation in this build`,
      );
  }
}

/**
 * Test seam: serve a provider's rows from this store instead of the configured
 * one.
 *
 * The alternative is worse. Half of what PR 2c does — the deletion queue, the
 * migration script — is only interesting for a provider with a real object
 * namespace, and the only such provider is S3; testing it by pointing the real
 * S3 client at a live bucket would make `pnpm test` need a network and a
 * credential. This lets the memory store stand in for one. Cleared by
 * {@link resetBlobStores}; never called from `src/`.
 */
const overrides = new Map<string, BlobStore>();
export function setBlobStoreOverride(provider: string, store: BlobStore | null): void {
  if (store) overrides.set(provider.toLowerCase(), store);
  else overrides.delete(provider.toLowerCase());
}

/**
 * The store that can serve THIS row, from the provider recorded on it. An
 * unknown or unconfigured provider raises `storage_unavailable` — see rule 1 in
 * the module docblock for why that must not become a 404.
 */
export function resolveStoreForRow(row: StorageRow): Promise<BlobStore> {
  const provider = (row.storage_provider ?? "postgres").toLowerCase();
  const override = overrides.get(provider);
  if (override) return Promise.resolve(override);
  if (provider === "postgres") return getPostgresStore();
  if (provider === "s3") {
    // Deliberately NOT gated on `BLOB_STORAGE`: an operator who flipped new
    // writes back to Postgres must still be able to READ everything written
    // while S3 was on, so the bucket config alone decides this.
    return getS3Store(
      `blob ${row.id} is stored on S3, which this server has no bucket configuration for`,
    );
  }
  throw new BlobStoreError(
    "storage_unavailable",
    `blob ${row.id} is stored on \`${provider}\`, which this server has no configuration for`,
  );
}

/** Test seam: drop the memoised provider instances and any override. */
export function resetBlobStores(): void {
  postgresStore = undefined;
  s3Store = undefined;
  overrides.clear();
}
