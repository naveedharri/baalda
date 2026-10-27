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
 *
 * Raised 20 → 30 (2026-09-18). During an import a registration batch holds one
 * slot, each pushed doc up to two, a bootstrap page one (×4 by
 * `BOOTSTRAP_CONCURRENCY`), and each vault-channel backfill runs 6 wide — a
 * couple of importers plus a few joining devices reached 20, after which
 * `connectionTimeoutMillis` failed requests at 5 s while Postgres itself was
 * idle.
 */
function poolMax(): number {
  const raw = process.env.PG_POOL_MAX;
  const n = raw ? Number(raw) : NaN;
  // Guards "" and garbage: Number("") is 0, and a max of 0 is a pool that never
  // hands out a connection — i.e. a server that silently serves nothing.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/**
 * Per-connection `work_mem`, the memory one sort or hash node may use before it
 * spills to a temp file. At the Postgres default of 4 MB most of our spills
 * were small sorts/hashes just over the line (a few MB each); 16 MB keeps
 * those in memory. Override per deployment with `PG_WORK_MEM` (a Postgres size
 * such as `8MB`).
 *
 * The budget is per sort/hash NODE, not per connection, and is only held while
 * a query runs; hash nodes get `hash_mem_multiplier` (default 2) × this. With
 * (`PG_POOL_MAX` 30 + the auth pool's 10) = 40 connections and ~3 such nodes
 * each, the theoretical ceiling is 40 × 3 × 16–32 MB ≈ 1.9–3.8 GB, which needs
 * every connection mid-query on a spilling multi-node plan at the same instant.
 * Real concurrency is a handful of active queries, most of them index lookups
 * with no sort node at all, so the realistic extra is ~100 MB. When raising
 * this or `PG_POOL_MAX`, keep `(pool max + 10) × PG_WORK_MEM × 3` well under
 * the Postgres container's memory. Session-level on purpose (not
 * `ALTER DATABASE`): it applies only to this server's connections, never to
 * migrations, psql sessions or other clients, and ships through code.
 */
export function workMem(): string {
  const raw = process.env.PG_WORK_MEM?.trim();
  // Strict shape: the value is spliced into the startup `options` string, so a
  // space would smuggle in another `-c`. Garbage falls back to the default,
  // like `poolMax`.
  return raw && /^[1-9]\d{0,6}(kB|MB|GB)$/.test(raw) ? raw : "16MB";
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
  options: `-c statement_timeout=15000 -c work_mem=${workMem()}`,
});

export type Pool = pg.Pool;

export async function closePool(): Promise<void> {
  await pool.end();
}
