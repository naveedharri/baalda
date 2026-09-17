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
 * Ceiling for ONE attachment on a provider that streams (S3/R2).
 *
 * The Postgres number above is a HEAP bound — that provider holds the whole
 * value in this process twice over. S3 never puts a byte of a direct upload in
 * our heap, so its ceiling is a product decision instead: 500 MB, which is
 * where the peers sit (Logseq 100, Obsidian 200, Notesnook 500). The
 * per-category caps in `formats.ts` are clamped to this, so a video may reach
 * 500 MB while a text file still stops at 10.
 */
export const MAX_BLOB_BYTES_DIRECT = positiveEnvInt("MAX_BLOB_BYTES_DIRECT", 500 * 1024 * 1024);

/**
 * How long a `pending` blob row may sit before the sweep removes it (and its
 * object, and any multipart upload it started).
 *
 * A pending row HOLDS the (vault, sha256) dedupe slot: while it exists, a
 * second client uploading the same content is handed the same blob id rather
 * than starting a competing upload. That is exactly what we want during an
 * upload and exactly what we do not want after an abandoned one, so the TTL is
 * the longest an upload is allowed to plausibly still be running. An hour
 * covers a 500 MB file on a slow line with room to spare.
 */
export const BLOB_PENDING_TTL_MINUTES = positiveEnvInt("BLOB_PENDING_TTL_MINUTES", 60);

/** How the client is asked to prove the bytes it PUTs directly to the bucket. */
export type S3ChecksumMode = "auto" | "sha256" | "md5" | "none";

export interface S3Config {
  bucket: string;
  region: string;
  /** Unset ⇒ real AWS S3. Set ⇒ R2 (`https://<account>.r2.cloudflarestorage.com`), MinIO, … */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and other single-host gateways need path-style addressing. */
  forcePathStyle: boolean;
  presignUploadTtlSeconds: number;
  presignDownloadTtlSeconds: number;
  /** True ⇒ `GET /api/blobs/:id` streams THROUGH this server instead of redirecting. */
  proxyDownloads: boolean;
  /** `auto` already resolved (see {@link resolveChecksumMode}). */
  checksumMode: Exclude<S3ChecksumMode, "auto">;
  multipartThresholdBytes: number;
  multipartPartBytes: number;
}

/** S3 vars that have no sensible default — all of them, or no S3. */
const S3_REQUIRED = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * `auto` is the whole point of this setting: the portable choice is not the
 * same one everywhere.
 *
 * On real AWS (no custom endpoint) `x-amz-checksum-sha256` is supported and is
 * the strongest thing we can sign into a presigned PUT, so `auto` picks it.
 * Against ANY custom endpoint it is the wrong answer — Cloudflare R2 implements
 * only `Content-MD5` (and full-object CRC64NVME), so a signed
 * `x-amz-checksum-sha256` fails every upload — hence `md5`, which every
 * S3-compatible gateway has understood since 2006. `none` is the opt-out for a
 * gateway that dislikes both; the server still verifies size at `complete` and
 * sniffs the head of the object, which is what actually protects the store.
 */
function resolveChecksumMode(raw: string, hasEndpoint: boolean): Exclude<S3ChecksumMode, "auto"> {
  const mode = raw.trim().toLowerCase();
  if (mode === "sha256" || mode === "md5" || mode === "none") return mode;
  return hasEndpoint ? "md5" : "sha256";
}

/**
 * The S3 configuration, or null when this build has none.
 *
 * Read on every call rather than memoised: it is called a handful of times per
 * process (store construction, the startup validation below) and a function is
 * what lets a test point the store at a MinIO container without reloading the
 * module graph.
 */
export function s3Config(): S3Config | null {
  const missing = S3_REQUIRED.filter((name) => !(process.env[name] ?? "").trim());
  if (missing.length > 0) return null;
  const endpoint = (process.env.S3_ENDPOINT ?? "").trim() || undefined;
  return {
    bucket: (process.env.S3_BUCKET as string).trim(),
    // `us-east-1` is the SDK's own default and what R2 wants as `auto`; a
    // gateway that ignores regions ignores this too.
    region: (process.env.S3_REGION ?? "").trim() || "us-east-1",
    endpoint,
    accessKeyId: (process.env.S3_ACCESS_KEY_ID as string).trim(),
    secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY as string).trim(),
    forcePathStyle: envFlag("S3_FORCE_PATH_STYLE", false),
    presignUploadTtlSeconds: positiveEnvInt("S3_PRESIGN_UPLOAD_TTL_SECONDS", 900),
    presignDownloadTtlSeconds: positiveEnvInt("S3_PRESIGN_DOWNLOAD_TTL_SECONDS", 300),
    proxyDownloads: envFlag("S3_PROXY_DOWNLOADS", false),
    checksumMode: resolveChecksumMode(process.env.S3_CHECKSUM_MODE ?? "auto", endpoint !== undefined),
    // AWS's own threshold for switching the CLI to multipart. Below it a single
    // PUT is simpler and cheaper; above it a failure with no resume and no
    // parallelism is a bad deal for the user.
    multipartThresholdBytes: positiveEnvInt("S3_MULTIPART_THRESHOLD_BYTES", 100 * 1024 * 1024),
    // 16 MB × 10 000 parts = 160 GB of headroom, and a part is small enough
    // that re-sending one after a blip costs seconds.
    multipartPartBytes: positiveEnvInt("S3_MULTIPART_PART_BYTES", 16 * 1024 * 1024),
  };
}

/** S3 allows at most this many parts in one multipart upload (a protocol limit). */
export const S3_MAX_PARTS = 10_000;

/**
 * Lifetime of the capability a client gets from `intent`, whichever provider
 * issued it: an S3 presigned PUT and the Postgres provider's signed same-origin
 * PUT expire together.
 *
 * One knob on purpose, and it keeps the `S3_` name even for the Postgres
 * provider, because an operator tuning "how long may an upload URL live" is
 * answering one question and should not have to find two vars to answer it.
 */
export const UPLOAD_TOKEN_TTL_SECONDS = positiveEnvInt("S3_PRESIGN_UPLOAD_TTL_SECONDS", 900);

/**
 * Which provider NEW blobs are written to. Existing rows are always read
 * through the provider recorded on the row (`blobs.storage_provider`), never
 * through this value — flipping it must not orphan what is already stored.
 *
 * Fail-closed, mirroring `config.ts jwtSecret()`: an unrecognised value, or
 * `s3` without a complete bucket configuration, is a FATAL startup error rather
 * than a silent fallback to Postgres. A silent fallback would write bytes into
 * a database an operator believed was only holding metadata — and, worse, would
 * do it one attachment at a time with nothing in the logs to say so.
 */
export const BLOB_STORAGE: BlobProvider = readStorage();

function readStorage(): BlobProvider {
  const raw = (process.env.BLOB_STORAGE ?? "postgres").trim().toLowerCase();
  if (raw === "postgres") return "postgres";
  if (raw === "s3") {
    const missing = S3_REQUIRED.filter((name) => !(process.env[name] ?? "").trim());
    if (missing.length > 0) {
      throw new Error(
        `BLOB_STORAGE=s3 but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset. ` +
          "Set the bucket and credentials (see .env.example → Attachments storage), or unset BLOB_STORAGE " +
          "to keep attachments in Postgres. Refusing to start rather than silently storing bytes in the database.",
      );
    }
    return "s3";
  }
  throw new Error(
    `BLOB_STORAGE must be \`postgres\` or \`s3\` (got \`${raw}\`). There is no other provider.`,
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
