/**
 * In-memory blob store — a test double, and the second implementation that
 * keeps `BlobStore` honest about what belongs in the interface. Never wired
 * into the server.
 *
 * Unlike the Postgres provider this one has a real object namespace (a Map),
 * so it accepts any key and needs no `blobs` row to exist. That difference is
 * deliberate: it is the shape an S3 provider has, and the conformance suite
 * runs against both so nothing provider-specific leaks into the contract.
 */
import { Readable } from "node:stream";
import type { BlobProvider } from "./config.js";
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

export class MemoryBlobStore implements BlobStore {
  // `postgres` rather than a fake provider name: `storage_provider` is a CHECK
  // constraint in the database, and a store that claimed a value the schema
  // refuses could not stand in for a real one in a route test.
  readonly provider: BlobProvider = "postgres";

  /** No multipart — a Map has no parts to assemble. */
  readonly multipartThresholdBytes = null;

  readonly objects = new Map<string, Buffer>();

  async put(input: PutInput): Promise<PutResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    this.objects.set(input.key, buf);
    return { key: input.key, size: buf.byteLength };
  }

  async get(key: string, opts: GetOptions = {}): Promise<GetResult> {
    const data = this.objects.get(key);
    if (!data) throw new BlobStoreError("not_found", `no object at ${key}`);
    if (opts.range) {
      const start = Math.max(0, opts.range.start);
      const end = Math.min(data.byteLength - 1, opts.range.end ?? data.byteLength - 1);
      const slice = data.subarray(start, end + 1);
      return {
        kind: "stream",
        body: Readable.from(slice),
        size: slice.byteLength,
        totalSize: data.byteLength,
        acceptRanges: true,
        range: { start, end },
      };
    }
    return {
      kind: "stream",
      body: Readable.from(data),
      size: data.byteLength,
      totalSize: data.byteLength,
      acceptRanges: true,
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    const data = this.objects.get(key);
    return data ? { size: data.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    return {
      method: "PUT",
      url: `memory://${input.key}`,
      headers: { "content-type": input.mime },
      expiresAt: Date.now() + 60_000,
      direct: false,
    };
  }

  async peek(key: string, bytes: number): Promise<Buffer | null> {
    const data = this.objects.get(key);
    return data ? data.subarray(0, Math.max(1, Math.trunc(bytes))) : null;
  }

  async presignMultipart(_input: PresignMultipartInput): Promise<PresignedMultipart> {
    throw new BlobStoreError("not_supported", "the memory store has no multipart upload");
  }

  async presignParts(
    _key: string,
    _uploadId: string,
    _partNumbers: number[],
  ): Promise<{ parts: PresignedPart[]; expiresAt: number }> {
    throw new BlobStoreError("not_supported", "the memory store has no multipart upload");
  }

  async completeMultipart(
    _key: string,
    _uploadId: string,
    _parts: CompletedPart[],
  ): Promise<PutResult> {
    throw new BlobStoreError("not_supported", "the memory store has no multipart upload");
  }

  async abortMultipart(_key: string, _uploadId: string): Promise<void> {
    throw new BlobStoreError("not_supported", "the memory store has no multipart upload");
  }

  async abortMultipartsForKey(_key: string): Promise<void> {}

  maxBytes(category: FormatCategory): number {
    return CATEGORY_MAX_BYTES[category];
  }
}
