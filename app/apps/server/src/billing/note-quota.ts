// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool } from "../db/pool.js";
import { requiresCloudPlan } from "../deployment-policy.js";
import { orgHasActiveSubscription } from "./entitlements.js";
import { resolveAccountPlan, teamModel } from "./plan.js";
import { billingModel } from "../config.js";
export const FREE_NOTE_LIMIT = 20_000;
/** Neutral, plan-aware refusal text; the code stays `note_limit_reached`. */
export function noteLimitMessage(limit: number = FREE_NOTE_LIMIT): string {
  const base = `This vault has reached its sync limit of ${limit.toLocaleString("en-US")} notes.`;
  // Team model: the Free ceiling is a hidden abuse cap, so the message names no number.
  return billingModel() === "team" ? "This vault has reached its sync limit. Upgrade to Team to lift it." : base;
}
/** @deprecated use `noteLimitMessage(limit)`; kept for older imports. */
export const NOTE_LIMIT_MESSAGE = `This vault has reached its sync limit of 20,000 notes.`;
export class NoteQuotaError extends Error {
  readonly status = 402;
  readonly code = "note_limit_reached";
  constructor(readonly limit: number = FREE_NOTE_LIMIT, message: string = noteLimitMessage(limit)) { super(message); }
}
type DB = Pick<pg.Pool, "query">;
/** A dedicated session lock spans separate statements, so count reads after a
 * waiting lock see committed inserts. No transaction: batch conflict recovery
 * deliberately catches unique violations without aborting later statements. */
export async function withNoteQuota<T>(vaultId: string, fallback: DB, work: (db: DB, remaining: number | null, cap: number) => Promise<T>): Promise<T> {
  if (!requiresCloudPlan()) return work(fallback, null, FREE_NOTE_LIMIT);
  // Bulk registration already owns a client: borrowing another slot can deadlock
  // when simultaneous batches fill the pool. Reuse that same session.
  const owned = !("release" in fallback);
  const db = owned ? await pool.connect() : fallback as pg.PoolClient;
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`note-quota:${vaultId}`]); locked = true;
    const { rows } = await db.query<{ organization_id: string }>("SELECT organization_id FROM vaults WHERE id = $1", [vaultId]);
    let cap = FREE_NOTE_LIMIT;
    if (teamModel()) {
      // Team model: `limits.notesPerVault` (Free = the hidden ABUSE_MAX_NOTES
      // ceiling, Team/self-host = none). Same lock, same error code.
      const limit = rows[0] ? (await resolveAccountPlan(db, { orgId: rows[0].organization_id })).limits.notesPerVault : null;
      if (limit === null) return await work(db, null, FREE_NOTE_LIMIT);
      cap = limit;
    } else if (rows[0] && await orgHasActiveSubscription(rows[0].organization_id, db)) return await work(db, null, cap);
    const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notes WHERE vault_id = $1 AND deleted_at IS NULL", [vaultId]);
    return await work(db, Math.max(0, cap - Number(count.rows[0]?.count ?? 0)), cap);
  } finally {
    try { if (locked) await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`note-quota:${vaultId}`]); }
    catch (e) { if (owned) db.release(true); throw e; }
    if (owned) db.release();
  }
}
