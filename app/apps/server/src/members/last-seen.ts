// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * "Last active" for the Members page: `member.last_seen_at`, stamped when a
 * member's vault channel authenticates or they mint a sync token.
 *
 * Throttled in-process to one write per (user, vault) per 10 minutes, and
 * fire-and-forget: a stamp never blocks a handshake and an error is logged,
 * never thrown. Several server instances may each write once per window, which
 * is harmless.
 */
export const LAST_SEEN_THROTTLE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 50_000;

const lastStamped = new Map<string, number>();

type Queryable = Pick<pg.Pool, "query">;

/** Stamp now; resolves when the write finished (tests await it). */
export async function stampLastSeen(
  userId: string,
  organizationId: string,
  db: Queryable = defaultPool,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${userId}\u0000${organizationId}`;
  const prev = lastStamped.get(key);
  if (prev !== undefined && now - prev < LAST_SEEN_THROTTLE_MS) return false;
  if (lastStamped.size >= MAX_ENTRIES) lastStamped.clear();
  lastStamped.set(key, now);
  try {
    await db.query(
      `UPDATE member SET last_seen_at = now()
        WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, organizationId],
    );
    return true;
  } catch (err) {
    lastStamped.delete(key);
    console.error("[members] last-seen stamp failed:", (err as Error).message);
    return false;
  }
}

/**
 * Same, keyed by a note collection (`vaults.id`) — what the vault channel and
 * the sync-token mint know. Collections and organizations are 1:1 in practice,
 * so the throttle key is the collection id and the UPDATE joins to the org.
 */
export async function stampLastSeenForVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${userId}\u0000v:${vaultId}`;
  const prev = lastStamped.get(key);
  if (prev !== undefined && now - prev < LAST_SEEN_THROTTLE_MS) return false;
  if (lastStamped.size >= MAX_ENTRIES) lastStamped.clear();
  lastStamped.set(key, now);
  try {
    await db.query(
      `UPDATE member m SET last_seen_at = now()
         FROM vaults v
        WHERE v.id = $2 AND m."organizationId" = v.organization_id AND m."userId" = $1`,
      [userId, vaultId],
    );
    return true;
  } catch (err) {
    lastStamped.delete(key);
    console.error("[members] last-seen stamp failed:", (err as Error).message);
    return false;
  }
}

/** Fire-and-forget form for hot paths (handshake, token mint). */
export function noteLastSeenForVault(userId: string, vaultId: string): void {
  void stampLastSeenForVault(userId, vaultId).catch(() => {});
}

/** Test hook. */
export function resetLastSeenThrottle(): void {
  lastStamped.clear();
}
