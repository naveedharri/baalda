import { pool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

const TABLES = [
  "note_versions",
  "vault_checkpoint_docs",
  "vault_checkpoints",
  "billing_events",
  "subscriptions",
  "mcp_tokens",
  "shares",
  "notes",
  "files",
  "folders",
  "vaults",
  // Trusted by `loadDocDiff`'s fast path, and `RESTART IDENTITY` below rewinds
  // `doc_updates`' ids — so a row left behind by an earlier test can have a
  // watermark that accidentally matches the next test's fresh log, and a stale
  // vector then reads as valid. It has to be reset with the log it describes.
  "doc_state_vectors",
  "doc_updates",
  "doc_snapshots",
  "blobs",
  "invitation",
  "member",
  "organization",
  "session",
  "account",
  "verification",
  '"user"',
];

export async function resetDb(): Promise<void> {
  await ensureMigrated();
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export { pool };
