// Confirmed-empty notes and stalled uploads (#257).
//
// On the server a genuinely empty note and a note whose content never arrived
// look the same: neither has a `doc_updates` or `doc_snapshots` row. The
// desktop already settles the first kind locally (`SyncManager
// .settleServerEmpty`: empty file AND empty local CRDT), and now reports that
// answer here, so a contentless row WITHOUT the marker means "upload pending or
// abandoned" — a number an owner can see and act on.
//
// Nothing in this module changes content, and nothing reads the marker to
// clear, skip or overwrite anything. `ready.empty` deliberately still names
// confirmed-empty notes: it is the safety net for a device whose own "pushed"
// checkpoint is wrong, and a marker set by one device says nothing about what
// another device may hold for the same note.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

type Queryable = Pick<pg.Pool, "query">;

/** Most doc ids one confirm-empty request may name — the `ready.empty` bound. */
export const CONFIRM_EMPTY_MAX = 2000;

/** A contentless, unconfirmed note this old counts as a stalled upload. */
export const STALLED_UPLOAD_MIN_AGE_MINUTES = 60;

/** Contentless: no CRDT row of either kind. Shared by both queries below. */
const NO_CONTENT = `NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = n.id)
   AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = n.id)`;

/**
 * Stamp `confirmed_empty_at` on the named live notes of `vaultId` that hold no
 * server content. Returns the ids actually stamped.
 *
 * The content check is in the same statement as the write, so a note whose
 * first update lands concurrently is never marked; and a marker on a note that
 * gains content later is moot, because every reader asks for content first.
 * The caller has already checked edit permission per id.
 */
export async function confirmEmptyNotes(
  vaultId: string,
  docIds: string[],
  db: Queryable = defaultPool,
): Promise<string[]> {
  if (docIds.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `UPDATE notes n SET confirmed_empty_at = now()
      WHERE n.vault_id = $1 AND n.id = ANY($2::text[])
        AND n.deleted_at IS NULL
        AND n.confirmed_empty_at IS NULL
        AND ${NO_CONTENT}
      RETURNING n.id`,
    [vaultId, docIds],
  );
  return rows.map((r) => r.id).sort();
}

export interface UploadHealth {
  /** Live notes with no server content and no confirmed-empty marker, older
   *  than `minAgeMinutes` — registered, but their content never arrived. */
  stalled: number;
  /** Live contentless notes a client has confirmed are genuinely empty. */
  confirmedEmpty: number;
  minAgeMinutes: number;
  /** Stalled notes per registering account, largest first (at most 10): the
   *  person whose device still holds the missing text. */
  byCreator: Array<{ userId: string | null; name: string | null; count: number }>;
}

/** The vault's stalled-upload census, for owners and admins in Health. */
export async function uploadHealth(
  vaultId: string,
  minAgeMinutes = STALLED_UPLOAD_MIN_AGE_MINUTES,
  db: Queryable = defaultPool,
): Promise<UploadHealth> {
  const { rows: totals } = await db.query<{ stalled: string; confirmed: string }>(
    `SELECT count(*) FILTER (
              WHERE n.confirmed_empty_at IS NULL
                AND n.created_at < now() - make_interval(mins => $2::int)) AS stalled,
            count(*) FILTER (WHERE n.confirmed_empty_at IS NOT NULL) AS confirmed
       FROM notes n
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL AND ${NO_CONTENT}`,
    [vaultId, minAgeMinutes],
  );
  const { rows: creators } = await db.query<{
    user_id: string | null;
    name: string | null;
    count: string;
  }>(
    `SELECT n.created_by AS user_id, u.name, count(*) AS count
       FROM notes n
       LEFT JOIN "user" u ON u.id = n.created_by
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL
        AND n.confirmed_empty_at IS NULL
        AND n.created_at < now() - make_interval(mins => $2::int)
        AND ${NO_CONTENT}
      GROUP BY n.created_by, u.name
      ORDER BY count(*) DESC, n.created_by
      LIMIT 10`,
    [vaultId, minAgeMinutes],
  );
  return {
    stalled: Number(totals[0]?.stalled ?? 0),
    confirmedEmpty: Number(totals[0]?.confirmed ?? 0),
    minAgeMinutes,
    byCreator: creators.map((r) => ({ userId: r.user_id, name: r.name, count: Number(r.count) })),
  };
}
