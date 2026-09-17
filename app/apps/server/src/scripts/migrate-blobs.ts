// ============================================================================
//  MOVE EXISTING ATTACHMENTS FROM POSTGRES BYTEA INTO S3
//
//  Flipping `BLOB_STORAGE=s3` only changes where NEW blobs go. Everything
//  already uploaded keeps `storage_provider = 'postgres'` and keeps being
//  served from the `data` column — which is correct (a row is always read
//  through the provider recorded ON IT) and is also why a database that grew
//  fat on attachments stays fat.
//
//  This is the one-off that moves them, and it is deliberately NOT automatic
//  and NOT part of a deploy. It is two phases with a human in between:
//
//    pnpm run blobs:migrate -- --copy --dry-run    # what would move
//    pnpm run blobs:migrate -- --copy              # write objects, verify, record the key
//    …confirm downloads still work…                # they still come from BYTEA
//    pnpm run blobs:migrate -- --cutover           # flip the provider, NULL the data
//
//  `--copy` never changes how a byte is READ: it writes the object and records
//  `storage_key`, leaving `storage_provider = 'postgres'`, so the server is
//  still serving the database copy and the whole phase is reversible by
//  clearing `storage_key`. `--cutover` is the switch, and only for rows whose
//  object has been verified to exist at the right size.
//
//  Both phases are idempotent: re-running `--copy` skips rows that already have
//  a key, re-running `--cutover` skips rows already on s3.
//
//  Lives under src/ so tsc emits it into the production image as
//  dist/scripts/migrate-blobs.js (`node dist/scripts/migrate-blobs.js --copy`
//  inside the container — tsx is a dev dependency and isn't shipped).
//
//  NOTE ON DISK: nulling a BYTEA column does not give the space back. Postgres
//  marks the old row version dead and reuses it for future inserts; the file on
//  disk only shrinks after `VACUUM (FULL) blobs` (which takes an ACCESS
//  EXCLUSIVE lock — downtime) or `pg_repack` (online, needs the extension).
//  Neither is run here, on purpose.
// ============================================================================

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type pg from "pg";
import { pool, closePool } from "../db/pool.js";
import { BLOB_STORAGE, s3Config } from "../blobs/config.js";
import { objectKey } from "../blobs/keys.js";
import { createBlobStore, type BlobStore } from "../blobs/store.js";

type Queryable = Pick<pg.Pool, "query">;

export interface MigrateOptions {
  /** Limit to one note collection. */
  vaultId?: string | null;
  /** Rows whose IDs are fetched per page. Their `data` is read ONE ROW AT A
   *  TIME regardless — 50 max-size blobs at once would be over a gigabyte. */
  batch: number;
  /** Stop after this many rows have been processed. */
  limit?: number | null;
  /** Pause between rows, to keep a live database responsive. */
  sleepMs: number;
  /** Report what would happen; touch nothing. */
  dryRun: boolean;
}

export interface MigrateSummary {
  scanned: number;
  /** Objects written (copy) / rows flipped (cutover). */
  moved: number;
  /** Already done, or nothing to do. */
  skipped: number;
  /** Rows whose stored bytes do not hash to their recorded sha256. */
  mismatched: number;
  /** Rows that errored. Non-zero ⇒ the process exits non-zero. */
  failed: number;
  bytes: number;
}

const emptySummary = (): MigrateSummary => ({
  scanned: 0,
  moved: 0,
  skipped: 0,
  mismatched: 0,
  failed: 0,
  bytes: 0,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CandidateRow {
  id: string;
  vault_id: string | null;
  sha256: string | null;
  mime: string | null;
  rel_path: string | null;
  filename: string | null;
  size: string | number | null;
}

/**
 * Phase 1: write each Postgres-stored blob into the object store and record its
 * key. Nothing about how the row is READ changes.
 *
 * The sha256 is re-computed from the stored bytes and compared to the recorded
 * one before anything is written. A disagreement means the row and its content
 * already disagree — which is precisely the row you must not "migrate", because
 * doing so would write bytes under a content-addressed key that does not
 * describe them. Logged and skipped, never touched.
 */
export async function copyPhase(
  store: BlobStore,
  opts: MigrateOptions,
  db: Queryable = pool,
): Promise<MigrateSummary> {
  const summary = emptySummary();
  let after = "";
  for (;;) {
    if (opts.limit != null && summary.scanned >= opts.limit) break;
    const { rows } = await db.query<CandidateRow>(
      `SELECT id, vault_id, sha256, mime, rel_path, filename, size
         FROM blobs
        WHERE storage_provider = 'postgres'
          AND data IS NOT NULL
          AND storage_key IS NULL
          AND id > $1
          AND ($2::text IS NULL OR vault_id = $2)
        ORDER BY id
        LIMIT $3`,
      [after, opts.vaultId ?? null, opts.batch],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      if (opts.limit != null && summary.scanned >= opts.limit) break;
      summary.scanned++;
      try {
        if (!row.vault_id || !row.sha256) {
          // A legacy row with no vault or no hash has no content-addressed key
          // to live under. It stays in Postgres, which still serves it.
          console.warn(`skip ${row.id}: no vault_id/sha256`);
          summary.skipped++;
          continue;
        }
        // One row's bytes at a time. This is the whole point of paginating ids
        // separately from reading data: the alternative peaks at batch × 25 MB.
        const { rows: dataRows } = await db.query<{ data: Buffer | null }>(
          "SELECT data FROM blobs WHERE id = $1",
          [row.id],
        );
        const data = dataRows[0]?.data ?? null;
        if (!data) {
          console.warn(`skip ${row.id}: data disappeared between pages`);
          summary.skipped++;
          continue;
        }
        const actual = createHash("sha256").update(data).digest("hex");
        if (actual !== row.sha256) {
          console.error(
            `MISMATCH ${row.id} (${row.rel_path ?? "?"}): row says ${row.sha256}, bytes hash to ${actual} — left untouched`,
          );
          summary.mismatched++;
          continue;
        }

        const key = objectKey(row.vault_id, row.sha256);
        if (opts.dryRun) {
          console.log(`would copy ${row.id} (${data.byteLength} bytes) → ${key}`);
          summary.moved++;
          summary.bytes += data.byteLength;
          continue;
        }

        await store.put({
          key,
          blobId: row.id,
          vaultId: row.vault_id,
          body: Readable.from(data),
          size: data.byteLength,
          mime: row.mime ?? "application/octet-stream",
          sha256: row.sha256,
          filename: row.filename,
          relPath: row.rel_path,
        });
        // Confirm the object is really there, at the size we sent. Without this
        // a silently-truncated upload would be "verified" by the cutover below.
        const head = await store.head(key);
        if (!head || head.size !== data.byteLength) {
          throw new Error(
            `object ${key} reads back as ${head ? `${head.size} bytes` : "missing"}, expected ${data.byteLength}`,
          );
        }
        // `storage_key` ONLY. The provider stays `postgres`, so this row is
        // still read from the database and the phase stays reversible.
        await db.query("UPDATE blobs SET storage_key = $2 WHERE id = $1", [row.id, key]);
        summary.moved++;
        summary.bytes += data.byteLength;
        console.log(`copied ${row.id} (${data.byteLength} bytes) → ${key}`);
      } catch (err) {
        summary.failed++;
        console.error(`FAILED ${row.id}:`, err);
      }
      if (opts.sleepMs > 0) await sleep(opts.sleepMs);
    }
    if (rows.length < opts.batch) break;
  }
  return summary;
}

/**
 * Phase 2: flip the verified rows to `s3` and release their bytes.
 *
 * "Verified" is re-checked here rather than trusted from phase 1: the object is
 * HEADed again and its size compared to the row's, because between the two
 * phases a bucket lifecycle rule, a wrong bucket or a hand-run cleanup could
 * have removed it — and this is the step after which the database copy is gone.
 */
export async function cutoverPhase(
  store: BlobStore,
  opts: MigrateOptions,
  db: Queryable = pool,
): Promise<MigrateSummary> {
  const summary = emptySummary();
  let after = "";
  for (;;) {
    if (opts.limit != null && summary.scanned >= opts.limit) break;
    const { rows } = await db.query<CandidateRow & { storage_key: string }>(
      `SELECT id, vault_id, sha256, mime, rel_path, filename, size, storage_key
         FROM blobs
        WHERE storage_provider = 'postgres'
          AND storage_key IS NOT NULL
          AND id > $1
          AND ($2::text IS NULL OR vault_id = $2)
        ORDER BY id
        LIMIT $3`,
      [after, opts.vaultId ?? null, opts.batch],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      if (opts.limit != null && summary.scanned >= opts.limit) break;
      summary.scanned++;
      try {
        const expected = Number(row.size ?? 0);
        const head = await store.head(row.storage_key);
        if (!head) {
          console.error(`skip ${row.id}: no object at ${row.storage_key} — re-run --copy`);
          summary.skipped++;
          continue;
        }
        if (expected > 0 && head.size !== expected) {
          console.error(
            `skip ${row.id}: ${row.storage_key} is ${head.size} bytes, row says ${expected}`,
          );
          summary.skipped++;
          continue;
        }
        if (opts.dryRun) {
          console.log(`would cut over ${row.id} → s3:${row.storage_key}`);
          summary.moved++;
          summary.bytes += head.size;
          continue;
        }
        await db.query(
          "UPDATE blobs SET storage_provider = 's3', data = NULL, updated_at = now() WHERE id = $1",
          [row.id],
        );
        summary.moved++;
        summary.bytes += head.size;
        console.log(`cut over ${row.id} → s3:${row.storage_key}`);
      } catch (err) {
        summary.failed++;
        console.error(`FAILED ${row.id}:`, err);
      }
      if (opts.sleepMs > 0) await sleep(opts.sleepMs);
    }
    if (rows.length < opts.batch) break;
  }
  return summary;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "usage: pnpm run blobs:migrate -- (--copy | --cutover) [options]",
      "",
      "  --copy           write each Postgres-stored blob to the object store and record its key",
      "  --cutover        flip verified rows to s3 and NULL their bytes",
      "",
      "  --dry-run        report what would happen, change nothing",
      "  --vault <id>     limit to one note collection",
      "  --batch <n>      rows per page (default 50)",
      "  --limit <n>      stop after n rows",
      "  --sleep-ms <n>   pause between rows (default 0)",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { phase: "copy" | "cutover"; opts: MigrateOptions } {
  let phase: "copy" | "cutover" | null = null;
  const opts: MigrateOptions = { vaultId: null, batch: 50, limit: null, sleepMs: 0, dryRun: false };
  const num = (raw: string | undefined, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) usage(`${flag} needs a positive number`);
    return Math.trunc(n);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--copy") phase = "copy";
    else if (a === "--cutover") phase = "cutover";
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--vault") opts.vaultId = argv[++i] ?? usage("--vault needs a value");
    else if (a === "--batch") opts.batch = num(argv[++i], "--batch");
    else if (a === "--limit") opts.limit = num(argv[++i], "--limit");
    else if (a === "--sleep-ms") opts.sleepMs = num(argv[++i], "--sleep-ms");
    else usage(`unknown argument ${a}`);
  }
  if (!phase) usage("one of --copy / --cutover is required");
  return { phase, opts };
}

function report(phase: string, s: MigrateSummary): void {
  console.log(
    `\n${phase}: scanned ${s.scanned}, ${phase === "copy" ? "copied" : "cut over"} ${s.moved} ` +
      `(${(s.bytes / (1024 * 1024)).toFixed(1)} MB), skipped ${s.skipped}, ` +
      `hash mismatches ${s.mismatched}, failed ${s.failed}`,
  );
}

async function main(): Promise<void> {
  const { phase, opts } = parseArgs(process.argv.slice(2));
  // Both phases need a working bucket — `--copy` to write to it, `--cutover` to
  // confirm what it wrote is still there. Refuse rather than "succeed" against
  // whatever the environment happens to hold.
  if (BLOB_STORAGE !== "s3" || !s3Config()) {
    console.error(
      "error: this script moves attachments INTO S3, so it needs BLOB_STORAGE=s3 and a complete\n" +
        "       bucket configuration (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).\n" +
        "       Run it with the server's own environment.",
    );
    process.exit(2);
  }
  const store = await createBlobStore();
  const summary = phase === "copy"
    ? await copyPhase(store, opts, pool)
    : await cutoverPhase(store, opts, pool);
  report(phase, summary);
  if (opts.dryRun) console.log("(dry run — nothing was changed)");
  await closePool();
  // A partial success is a failure for a migration: an operator scripting these
  // phases has to be able to stop on the first one that did not go cleanly.
  if (summary.failed > 0 || summary.mismatched > 0) process.exit(1);
}

// Only when run as a program — the phases above are imported by the tests.
if (process.argv[1] && process.argv[1].includes("migrate-blobs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
