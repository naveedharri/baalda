// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool } from "../db/pool.js";
import { requiresCloudPlan } from "../deployment-policy.js";
import { orgHasActiveSubscription } from "./entitlements.js";
export const FREE_NOTE_LIMIT = 20_000;
export const NOTE_LIMIT_MESSAGE = "This Free vault has reached 20,000 synced notes. Upgrade this vault to Pro to sync more notes. Existing notes keep syncing; additional notes stay on this device.";
export class NoteQuotaError extends Error {
  readonly status = 402;
  readonly code = "note_limit_reached";
  constructor() { super(NOTE_LIMIT_MESSAGE); }
}
type DB = Pick<pg.Pool, "query">;
/** A dedicated session lock spans separate statements, so count reads after a
 * waiting lock see committed inserts. No transaction: batch conflict recovery
 * deliberately catches unique violations without aborting later statements. */
export async function withNoteQuota<T>(vaultId: string, fallback: DB, work: (db: DB, remaining: number | null) => Promise<T>): Promise<T> {
  if (!requiresCloudPlan()) return work(fallback, null);
  // Bulk registration already owns a client: borrowing another slot can deadlock
  // when simultaneous batches fill the pool. Reuse that same session.
  const owned = !("release" in fallback);
  const db = owned ? await pool.connect() : fallback as pg.PoolClient;
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`note-quota:${vaultId}`]); locked = true;
    const { rows } = await db.query<{ organization_id: string }>("SELECT organization_id FROM vaults WHERE id = $1", [vaultId]);
    if (rows[0] && await orgHasActiveSubscription(rows[0].organization_id, db)) return await work(db, null);
    const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notes WHERE vault_id = $1 AND deleted_at IS NULL", [vaultId]);
    return await work(db, Math.max(0, FREE_NOTE_LIMIT - Number(count.rows[0]?.count ?? 0)));
  } finally {
    try { if (locked) await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`note-quota:${vaultId}`]); }
    catch (e) { if (owned) db.release(true); throw e; }
    if (owned) db.release();
  }
}
