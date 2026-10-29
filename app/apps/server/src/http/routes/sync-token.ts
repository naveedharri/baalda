import { Hono } from "hono";
import { refuseKeyIncapableClient } from "../../crypto/transport.js";
import { pool } from "../../db/pool.js";
import { createResolverCache } from "../../permissions/resolver.js";
import { syncPermission } from "../../trash/access.js";
import { mintSyncToken } from "../../tokens/sync-token.js";
import { getSession } from "../session.js";
import { noteLastSeenForVault } from "../../members/last-seen.js";

/**
 * POST /api/sync-token  { docId }  (spec 03 §7, 04 §4)
 *
 * Validates the Better Auth session, computes effective permission, and mints a
 * short-lived per-doc JWT:
 *   edit -> { readOnly:false }, view -> { readOnly:true }, none -> 403.
 */
export const syncTokenRoutes = new Hono();

/** At most one refusal line per (user, doc) per this long. */
export const SYNC_TOKEN_REFUSAL_LOG_EVERY_MS = 5 * 60_000;
/** Bound on remembered (user, doc) keys; past it, expired keys are swept and,
 *  if still full, the oldest are dropped (Map keeps insertion order). */
const REFUSAL_LOG_MAX_KEYS = 10_000;
const lastRefusalLog = new Map<string, number>();

/**
 * Log a refused mint as ONE line, throttled per (user, doc) so a client looping
 * on a doc it cannot open cannot flood the logs. Ids and codes only:
 *
 *   [sync-token] refused user=<id> doc=<id> status=403 reason=no_access
 */
export function logSyncTokenRefusal(
  userId: string,
  docId: string,
  status: 403 | 404,
  reason: string,
  now = Date.now(),
): boolean {
  const key = `${userId}\u0000${docId}`;
  const last = lastRefusalLog.get(key);
  if (last !== undefined && now - last < SYNC_TOKEN_REFUSAL_LOG_EVERY_MS) return false;
  lastRefusalLog.delete(key);
  if (lastRefusalLog.size >= REFUSAL_LOG_MAX_KEYS) {
    for (const [k, t] of lastRefusalLog) {
      if (now - t >= SYNC_TOKEN_REFUSAL_LOG_EVERY_MS) lastRefusalLog.delete(k);
    }
    while (lastRefusalLog.size >= REFUSAL_LOG_MAX_KEYS) {
      const oldest = lastRefusalLog.keys().next().value;
      if (oldest === undefined) break;
      lastRefusalLog.delete(oldest);
    }
  }
  lastRefusalLog.set(key, now);
  // `docId` is client-supplied (the 404 path has not matched a row): log it
  // only when it looks like an id, never raw text or a newline.
  const doc = /^[A-Za-z0-9_-]{1,128}$/.test(docId) ? docId : "<invalid>";
  console.info(`[sync-token] refused user=${userId} doc=${doc} status=${status} reason=${reason}`);
  return true;
}

/** Tests only: forget the refusal-log throttle. */
export function __clearSyncTokenRefusalLog(): void {
  lastRefusalLog.clear();
}

async function docVaultId(docId: string): Promise<string | null> {
  const { rows } = await pool.query<{ vault_id: string }>(
    `SELECT vault_id FROM notes
      WHERE id = $1
        AND (deleted_at IS NULL OR (purge_after IS NOT NULL AND purge_after > now()))
     UNION ALL
     SELECT vault_id FROM files WHERE id = $1
     LIMIT 1`,
    [docId],
  );
  return rows[0]?.vault_id ?? null;
}

syncTokenRoutes.post("/sync-token", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  let body: { docId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const docId = body.docId;
  if (typeof docId !== "string" || docId.length === 0) {
    return c.json({ error: "docId is required" }, 400);
  }

  const vaultId = await docVaultId(docId);
  if (!vaultId) {
    logSyncTokenRefusal(session.userId, docId, 404, "unknown_doc");
    return c.json({ error: "Unknown document" }, 404);
  }
  // A keyed vault mints no socket for a build without vault keys (426, the
  // refusal it already treats as "update"): the socket is where it would meet
  // `key_required`, which it has never seen.
  const outdated = await refuseKeyIncapableClient(c, vaultId);
  if (outdated) return outdated;

  // A note in Trash (inside its retention window) still mints: pushes into it
  // are accepted so offline edits reach the server; the note stays deleted.
  //
  // A fresh, request-scoped `ResolverCache` (#263): the same answer, in about
  // half the round trips — one share read for the four share questions and one
  // read for role, join snapshot and posture. It dies with this request.
  const permission = await syncPermission(session.userId, docId, pool, createResolverCache());
  if (permission === "none") {
    logSyncTokenRefusal(session.userId, docId, 403, "no_access");
    return c.json({ error: "No access to this document" }, 403);
  }

  const readOnly = permission === "view";
  // userId travels in the token so the sync server can attribute the edits that
  // arrive on this connection ("last edited by" + version authorship).
  const token = await mintSyncToken({ docId, vaultId, readOnly, userId: session.userId });
  noteLastSeenForVault(session.userId, vaultId);
  return c.json({ token, docId, vaultId, readOnly, permission });
});
