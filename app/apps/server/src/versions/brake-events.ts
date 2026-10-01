// SPDX-License-Identifier: Apache-2.0
//
// The durable side of the shrink burst brake (#252, migration 042).
//
// The hold lives in memory (`shrink-guard.ts ShrinkBrake`); these rows are what
// the vault's owners/admins see in Activity ("sync paused for <member>", when,
// how many notes) and release from, and what the held member sees about
// themselves. Nothing on the sync path reads them: a row that outlives its hold
// (a restart forgot it) only makes a Release a no-op.

import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

export interface BrakeEvent {
  id: string;
  userId: string;
  userName: string | null;
  noteCount: number;
  engagedAt: string;
  heldUntil: string;
  releasedAt: string | null;
  releasedBy: string | null;
  /** Not released and not yet lapsed, as far as this table knows. */
  held: boolean;
}

/** Record one engagement. Best-effort for the caller: it logs and moves on. */
export async function recordBrakeEngaged(
  vaultId: string,
  userId: string,
  noteCount: number,
  heldUntil: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO shrink_brake_events (id, vault_id, user_id, note_count, held_until)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), vaultId, userId, noteCount, heldUntil],
  );
}

/** Stamp every still-live row for (vault, user) released. Returns how many. */
export async function markBrakeReleased(
  vaultId: string,
  userId: string,
  releasedBy: string,
): Promise<number> {
  const res = await pool.query(
    `UPDATE shrink_brake_events
        SET released_at = now(), released_by = $3
      WHERE vault_id = $1 AND user_id = $2
        AND released_at IS NULL AND held_until > now()`,
    [vaultId, userId, releasedBy],
  );
  return res.rowCount ?? 0;
}

/** Newest first since `since`; `onlyUserId` narrows to one member's own rows. */
export async function listBrakeEvents(
  vaultId: string,
  since: Date,
  onlyUserId: string | null,
  limit = 100,
): Promise<BrakeEvent[]> {
  const res = await pool.query<{
    id: string;
    user_id: string;
    user_name: string | null;
    note_count: number;
    engaged_at: Date;
    held_until: Date;
    released_at: Date | null;
    released_by: string | null;
    held: boolean;
  }>(
    `SELECT e.id, e.user_id, u.name AS user_name, e.note_count, e.engaged_at,
            e.held_until, e.released_at, e.released_by,
            (e.released_at IS NULL AND e.held_until > now()) AS held
       FROM shrink_brake_events e
       LEFT JOIN "user" u ON u.id = e.user_id
      WHERE e.vault_id = $1 AND e.engaged_at >= $2
        AND ($3::text IS NULL OR e.user_id = $3)
      ORDER BY e.engaged_at DESC
      LIMIT $4`,
    [vaultId, since, onlyUserId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    noteCount: r.note_count,
    engagedAt: new Date(r.engaged_at).toISOString(),
    heldUntil: new Date(r.held_until).toISOString(),
    releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
    releasedBy: r.released_by,
    held: r.held,
  }));
}
