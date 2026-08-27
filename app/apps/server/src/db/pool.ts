import pg from "pg";
import { config } from "../config.js";

// Yjs updates are stored as BYTEA. node-postgres returns BYTEA as Buffer by
// default (type 17 = bytea), which is what we want — no parser override needed.

/**
 * Connection ceiling. Was a hardcoded 10, which a single vault reconnect can
 * saturate on its own: backfill runs `BACKFILL_CONCURRENCY` doc reads at a time
 * per connection, so two clients coming back at once left nothing for the HTTP
 * routes and requests queued behind `pool.connect()` with no timeout.
 * Override per deployment with `PG_POOL_MAX` (keep it under the Postgres
 * `max_connections` budget shared with every other instance).
 */
function poolMax(): number {
  const raw = process.env.PG_POOL_MAX;
  const n = raw ? Number(raw) : NaN;
  // Guards "" and garbage: Number("") is 0, and a max of 0 is a pool that never
  // hands out a connection — i.e. a server that silently serves nothing.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: poolMax(),
  // Hand idle connections back rather than pinning `max` sockets forever.
  idleTimeoutMillis: 30_000,
  // Fail fast instead of hanging a request forever when the pool is exhausted or
  // Postgres is unreachable. Unbounded waiting is how a slow DB turns into a
  // server that accepts connections and answers nothing.
  connectionTimeoutMillis: 5_000,
  // Shows up in pg_stat_activity, so a runaway query is attributable.
  application_name: "baalda-server",
  // Per-connection statement ceiling. Deliberately set here and NOT in the
  // migration path: `runMigrations` opens its own `pg.Client`, so DDL (an index
  // build over a big table) is never subject to this.
  //
  // Sent as a startup option, which a direct Postgres connection (and our
  // deploys) accept. A connection pooler in front of the DB in *transaction*
  // mode can reject startup options — if a deployment ever puts one there, move
  // this to a `pool.on("connect")` `SET statement_timeout` instead.
  options: "-c statement_timeout=15000",
});

export type Pool = pg.Pool;

export async function closePool(): Promise<void> {
  await pool.end();
}
