/**
 * Attachment storage configuration.
 *
 * Deliberately NOT in `src/config.ts`: the blob limits are sized against this
 * process's heap rather than against the product (see the sizing note on
 * {@link MAX_BLOB_BYTES}), and the storage provider is read by the store
 * factory only. Keeping them here is the same call `http/routes/blobs.ts` made
 * when the numbers lived in that file; this module is where they moved to when
 * the store became an adapter.
 */

/** Storage providers this build knows how to talk to. */
export type BlobProvider = "postgres" | "s3";

/** What to do with an upload whose MIME type is not on the allow-list. */
export type MimeEnforcement = "reject" | "warn";

function positiveEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/**
 * Max attachment upload size.
 *
 * Sizing rationale (this process runs with V8 capped at 512 MB inside a 1 GiB
 * container, see Dockerfile / railway.json): storing an N-byte blob costs
 * several multiples of N on the heap at peak, because node-postgres has no
 * binary parameter protocol — the bytes must be rendered into a text-encodable
 * form and then serialized into the outgoing wire buffer. With the base64
 * encoding `postgres-store.ts` uses that is roughly N (body) + 1.33N (base64) +
 * 1.33N (pg's write buffer) ≈ 3.7N. A 100 MB cap therefore put a SINGLE legal
 * upload at ~370 MB of a 512 MB heap, and two concurrent ones over the
 * container.
 *
 * So: a cap that is generous for real attachments (images, PDFs, short clips)
 * but survivable at ~3.7x, plus a global byte budget so concurrency cannot
 * stack peaks. Both are env-overridable for operators who have sized their
 * container differently.
 */
export const MAX_BLOB_BYTES = positiveEnvInt("MAX_BLOB_BYTES", 25 * 1024 * 1024); // 25 MB

/**
 * Total upload-body bytes admitted concurrently. Must be >= MAX_BLOB_BYTES or a
 * single max-size upload could never be admitted; the budget is what stops N
 * simultaneous uploads from summing past the heap. At the default 50 MB the
 * worst case is ~185 MB of peak heap for uploads.
 */
export const MAX_INFLIGHT_UPLOAD_BYTES = Math.max(
  MAX_BLOB_BYTES,
  positiveEnvInt("MAX_INFLIGHT_UPLOAD_BYTES", 2 * MAX_BLOB_BYTES),
);

/**
 * Which provider NEW blobs are written to. Existing rows are always read
 * through the provider recorded on the row (`blobs.storage_provider`), never
 * through this value — flipping it must not orphan what is already stored.
 *
 * Fail-closed, mirroring `config.ts jwtSecret()`: an unrecognised value (or
 * `s3`, which this build does not implement yet) is a FATAL startup error
 * rather than a silent fallback to Postgres, because a silent fallback would
 * write bytes into a database an operator believed was only holding metadata.
 */
export const BLOB_STORAGE: BlobProvider = readStorage();

function readStorage(): BlobProvider {
  const raw = (process.env.BLOB_STORAGE ?? "postgres").trim().toLowerCase();
  if (raw === "postgres") return "postgres";
  if (raw === "s3") {
    throw new Error(
      "BLOB_STORAGE=s3 is not implemented in this build — attachment storage would silently fall back to Postgres. Unset BLOB_STORAGE (or set it to `postgres`).",
    );
  }
  throw new Error(
    `BLOB_STORAGE must be \`postgres\` (got \`${raw}\`). S3 support is coming; there is no other provider.`,
  );
}

/**
 * `reject` (default) answers 415 for an upload whose declared MIME is not on
 * the allow-list; `warn` logs and stores it anyway. `warn` exists for operators
 * upgrading a server whose users already uploaded types we don't list — it lets
 * them see what would have been refused before turning enforcement on.
 */
export const BLOB_MIME_ENFORCE: MimeEnforcement =
  (process.env.BLOB_MIME_ENFORCE ?? "").trim().toLowerCase() === "warn" ? "warn" : "reject";
