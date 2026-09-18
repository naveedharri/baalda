import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// migrations live at apps/server/migrations (sibling of src/)
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export async function runMigrations(
  connectionString: string = config.databaseUrl,
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // ONE migrator at a time, across processes. Railway runs this as a
    // pre-deploy step and a rolling deploy (or a retried one) can start two at
    // once: both read `_migrations`, both see the same file as unapplied, and
    // both run its DDL — the second failing halfway through a migration whose
    // first half already committed in the other transaction, leaving the schema
    // in a state no file describes.
    //
    // Session-scoped (`pg_advisory_lock`, not `_xact_`) because the run is many
    // transactions, and WAITING rather than trying: the loser's job is to apply
    // the same migrations, so queueing and then finding them all done is exactly
    // right. Released by `client.end()` in the `finally` even if a migration
    // throws.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", ["baalda-migrations"]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM _migrations",
    );
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

// Run directly: `tsx src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) {
        console.log("Migrations: nothing to apply (up to date).");
      } else {
        console.log(`Migrations applied:\n  ${applied.join("\n  ")}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
