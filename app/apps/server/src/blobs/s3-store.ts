/**
 * S3-compatible object storage — AWS S3, Cloudflare R2, MinIO, or anything else
 * that speaks the same API.
 *
 * What this provider buys over Postgres is that the server stops touching the
 * bytes at all: `intent` hands the client a presigned URL, the client PUTs
 * straight to the bucket, and `complete` verifies what landed with a HEAD and a
 * 64 KB peek. A 500 MB video therefore costs this process a few hundred bytes
 * of JSON instead of ~1.8 GB of heap.
 *
 * Three portability rules are load-bearing, all learned from R2:
 *
 *  1. **Checksums are off by default in the client.** SDK ≥ 3.729 adds a CRC32
 *     trailer to every request and validates one on every response; R2 and
 *     older MinIO reject the request outright. `WHEN_REQUIRED` on both sides
 *     restores the pre-3.729 behaviour, which every implementation understands.
 *  2. **Never sign `x-amz-checksum-sha256` into a presign against a custom
 *     endpoint.** R2 implements `Content-MD5` and full-object CRC64NVME and
 *     nothing else, so a signed sha256 header fails 100% of uploads.
 *     `S3_CHECKSUM_MODE=auto` is what keeps that from ever happening (see
 *     `config.ts resolveChecksumMode`).
 *  3. **Presigned POST does not exist on R2**, so the size bound cannot ride on
 *     a policy's `content-length-range`. Instead `content-length` is a SIGNED
 *     header on the PUT (a client that sends a different length gets a 403 from
 *     the bucket) AND `complete` re-checks the object's real size, deleting it
 *     on a mismatch. Belt and braces, because the belt is the one the bucket
 *     enforces and we cannot audit it.
 *
 * Integrity, stated plainly: with a direct upload the server never sees the
 * bytes, so the client's sha256 is taken as the content address rather than
 * verified. What IS verified is the size and the magic bytes. That is not a
 * weakening — the uploader is an authenticated member who could upload any
 * bytes it liked under any hash it liked through the proxied path too. The
 * hash's job here is dedupe and addressing, not authentication.
 */
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobProvider, S3Config } from "./config.js";
import { MAX_BLOB_BYTES_DIRECT, S3_MAX_PARTS } from "./config.js";
import { CATEGORY_MAX_BYTES, type FormatCategory } from "./formats.js";
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
} from "./store.js";

/** S3 errors that mean "there is nothing there", across SDK versions and gateways. */
function isMissing(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.name === "NoSuchUpload" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Object metadata must be ASCII: S3 puts it in `x-amz-meta-*` HTTP headers, and
 * a filename with an umlaut in it would make the SDK throw (or the gateway
 * mangle it). Percent-encoding is lossless and is what the client decodes.
 */
function metaValue(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const encoded = encodeURIComponent(raw);
  // Metadata is size-bounded (2 KB of headers on AWS); a pathological path is
  // dropped rather than failing the upload, since this is descriptive only.
  return encoded.length <= 512 ? encoded : undefined;
}

function extOf(filename: string | null | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

/** RFC 6266 `filename*`, so a non-ASCII name survives the round trip. */
function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string | null | undefined,
): string {
  if (!filename) return disposition;
  // Strip anything that could terminate the header or escape the quotes; the
  // UTF-8 form after it is what a modern browser actually reads.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\;\r\n]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class S3BlobStore implements BlobStore {
  readonly provider: BlobProvider = "s3";
  readonly multipartThresholdBytes: number;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.multipartThresholdBytes = cfg.multipartThresholdBytes;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      // See rule 1 in the module docblock. Both directions, both defaults.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /** Test seam: the SDK keeps sockets open, which would hold a test process up. */
  destroy(): void {
    this.client.destroy();
  }

  async put(input: PutInput): Promise<PutResult> {
    // A single PutObject with a known ContentLength. The SDK streams the body
    // through without buffering it once the length is fixed, which is the whole
    // reason `intent` carries the size: without it the SDK would have to
    // collect the stream to learn what to sign.
    //
    // Nothing here needs `lib-storage`: the only stream that reaches this
    // method is the proxied `PUT /api/blobs/:id/data` body, and that is bounded
    // by MAX_BLOB_BYTES. Anything larger goes direct to the bucket, where the
    // multipart path below is the client's own upload.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.size,
        ContentType: input.mime,
        Metadata: this.objectMetadata(input.sha256, input.filename, input.relPath),
      }),
    );
    return { key: input.key, size: input.size };
  }

  async get(key: string, opts: GetOptions = {}): Promise<GetResult> {
    const disposition = opts.disposition ?? "attachment";
    const responseType = opts.mime || "application/octet-stream";
    const responseDisposition = contentDisposition(disposition, opts.filename);

    if (!this.cfg.proxyDownloads) {
      // The default: hand the caller a short-lived URL and let the bucket serve
      // the bytes. `response-content-type` / `response-content-disposition` are
      // part of the SIGNATURE, so the object's own (uploader-controlled)
      // metadata cannot decide how a browser treats the response, and a client
      // cannot rewrite them either without invalidating the signature.
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: responseType,
        ResponseContentDisposition: responseDisposition,
      });
      const expiresIn = this.cfg.presignDownloadTtlSeconds;
      const url = await getSignedUrl(this.client, command, { expiresIn });
      // A presigned GET does not prove the object exists — S3 only checks that
      // at fetch time. HEAD first, so a missing object is a 404 here rather
      // than a broken link the client has to interpret.
      const head = await this.head(key);
      if (!head) throw new BlobStoreError("not_found", `no object at ${key}`);
      return { kind: "redirect", url, expiresAt: Date.now() + expiresIn * 1000 };
    }

    // `S3_PROXY_DOWNLOADS=1`: stream through this server. Costs egress twice and
    // a socket for the duration, but it is the only shape that works when the
    // bucket is not reachable from the client's network (a MinIO on a private
    // subnet) or when a browser context must not be handed a bucket URL.
    try {
      const range = opts.range
        ? `bytes=${opts.range.start}-${opts.range.end ?? ""}`
        : undefined;
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
      );
      const body = res.Body as Readable | undefined;
      if (!body) throw new BlobStoreError("not_found", `no object at ${key}`);
      const size = Number(res.ContentLength ?? 0);
      // `ContentRange` is `bytes <start>-<end>/<total>`; without one the whole
      // object was served and its length IS the total.
      const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.ContentRange ?? "");
      const totalSize = parsed ? Number(parsed[3]) : size;
      return {
        kind: "stream",
        body,
        size,
        totalSize,
        acceptRanges: true,
        ...(parsed ? { range: { start: Number(parsed[1]), end: Number(parsed[2]) } } : {}),
      };
    } catch (e) {
      if (isMissing(e)) throw new BlobStoreError("not_found", `no object at ${key}`);
      throw e;
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: Number(res.ContentLength ?? 0) };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      // S3 already treats deleting a missing key as success; a gateway that
      // does not must not turn a cleanup into a failed request.
      if (!isMissing(e)) throw e;
    }
  }

  async peek(key: string, bytes: number): Promise<Buffer | null> {
    const want = Math.max(1, Math.trunc(bytes));
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${want - 1}` }),
      );
      const body = res.Body as Readable | undefined;
      if (!body) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        chunks.push(buf);
        total += buf.byteLength;
        // A gateway that ignores Range would otherwise stream the whole 500 MB
        // object into this process to answer a 64 KB question.
        if (total >= want) break;
      }
      // `destroy()` rather than letting it drain: the break above leaves the
      // socket mid-response, and an undrained body holds a connection.
      body.destroy();
      return Buffer.concat(chunks).subarray(0, want);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const headers: Record<string, string> = {
      "content-type": input.mime,
      // Signed below, so the bucket itself refuses a body of any other length.
      "content-length": String(input.size),
    };
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.mime,
      ContentLength: input.size,
      Metadata: this.objectMetadata(input.sha256, null, null),
      ...this.checksumFields(input, headers),
    });
    const expiresIn = this.cfg.presignUploadTtlSeconds;
    const url = await getSignedUrl(this.client, command, {
      expiresIn,
      // Without this the SDK signs only `host`, and the bound on the body's
      // length evaporates (rule 3 in the module docblock).
      signableHeaders: new Set(Object.keys(headers)),
    });
    return {
      method: "PUT",
      url,
      headers,
      expiresAt: Date.now() + expiresIn * 1000,
      direct: true,
    };
  }

  async presignMultipart(input: PresignMultipartInput): Promise<PresignedMultipart> {
    const partBytes = this.partSize(input.size, input.partBytes);
    const partCount = Math.max(1, Math.ceil(input.size / partBytes));
    if (partCount > S3_MAX_PARTS) {
      throw new BlobStoreError(
        "not_supported",
        `${input.size} bytes needs ${partCount} parts of ${partBytes}, over the ${S3_MAX_PARTS} limit`,
      );
    }
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.mime,
        Metadata: this.objectMetadata(input.sha256, null, null),
      }),
    );
    const uploadId = created.UploadId;
    if (!uploadId) {
      throw new BlobStoreError("not_supported", "the bucket returned no multipart upload id");
    }
    const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const { parts, expiresAt } = await this.presignParts(input.key, uploadId, numbers);
    return { uploadId, partBytes, parts, expiresAt, direct: true };
  }

  async presignParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ parts: PresignedPart[]; expiresAt: number }> {
    const expiresIn = this.cfg.presignUploadTtlSeconds;
    // Sequential would be N round trips of signing work; these are pure local
    // crypto, so they cost nothing to do at once.
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
    return { parts, expiresAt: Date.now() + expiresIn * 1000 };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<PutResult> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((p) => ({
            PartNumber: p.partNumber,
            // Some clients strip the quotes the header carries, some don't.
            ETag: p.etag.startsWith('"') ? p.etag : `"${p.etag}"`,
          })),
        },
      }),
    );
    // The completed object's size is NOT derivable from the request (parts may
    // be any size ≥ 5 MB except the last), and a multipart ETag is a hash of
    // hashes rather than the content's — so the caller's verification reads the
    // real thing back.
    const head = await this.head(key);
    if (!head) throw new BlobStoreError("not_found", `multipart completed but ${key} is not there`);
    return { key, size: head.size };
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  async abortMultipartsForKey(key: string): Promise<void> {
    // Uploads are listed by key prefix; the key is exact, so `Prefix: key` can
    // only match this object (keys are `vaults/<vaultId>/<sha256>` — one sha is
    // never a prefix of another, they are all 64 chars).
    const listed = await this.client.send(
      new ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix: key }),
    );
    for (const upload of listed.Uploads ?? []) {
      if (upload.Key === key && upload.UploadId) {
        await this.abortMultipart(key, upload.UploadId);
      }
    }
  }

  maxBytes(category: FormatCategory): number {
    // The category ceiling, clamped to the direct-upload bound. Nothing about
    // this provider's own transport limits a single object (S3 allows 5 TB);
    // the clamp is a product decision about what a vault may hold.
    return Math.min(CATEGORY_MAX_BYTES[category], MAX_BLOB_BYTES_DIRECT);
  }

  /**
   * Part size: the configured one, raised if the object would otherwise need
   * more than {@link S3_MAX_PARTS}, and never below S3's 5 MB minimum for a
   * non-final part.
   */
  private partSize(size: number, requested?: number): number {
    const MIN_PART = 5 * 1024 * 1024;
    const base = Math.max(MIN_PART, Math.trunc(requested || this.cfg.multipartPartBytes));
    const needed = Math.ceil(size / S3_MAX_PARTS);
    return Math.max(base, needed, MIN_PART);
  }

  /**
   * Descriptive metadata on the object. None of it is ever trusted on the way
   * back out — the `blobs` row is the authority for mime, filename and path
   * (see {@link GetOptions.mime}) — but it is what makes a bucket browsable by
   * a human holding nothing but the objects, and what a disaster-recovery
   * rebuild would read.
   */
  private objectMetadata(
    sha256: string,
    filename: string | null | undefined,
    relPath: string | null | undefined,
  ): Record<string, string> {
    const meta: Record<string, string> = { sha256 };
    const ext = extOf(filename) ?? extOf(relPath);
    if (ext) meta.ext = ext;
    const rel = metaValue(relPath);
    if (rel) meta.relpath = rel;
    const name = metaValue(filename);
    if (name) meta.filename = name;
    return meta;
  }

  /**
   * The checksum the presigned PUT will demand, per `S3_CHECKSUM_MODE`.
   * Mutates `headers` so the caller signs whatever it adds.
   */
  private checksumFields(
    input: PresignUploadInput,
    headers: Record<string, string>,
  ): { ChecksumSHA256?: string; ContentMD5?: string } {
    if (this.cfg.checksumMode === "sha256") {
      // Only ever reached on real AWS under `auto`, or when an operator opted
      // in explicitly. See rule 2: against a custom endpoint this header is
      // what breaks every upload.
      const b64 = Buffer.from(input.sha256, "hex").toString("base64");
      headers["x-amz-checksum-sha256"] = b64;
      return { ChecksumSHA256: b64 };
    }
    if (this.cfg.checksumMode === "md5" && input.md5Base64) {
      headers["content-md5"] = input.md5Base64;
      return { ContentMD5: input.md5Base64 };
    }
    // `md5` with no client-supplied digest, or `none`: nothing to sign. Size is
    // still bound by the signed `content-length` and re-checked at `complete`.
    return {};
  }
}
