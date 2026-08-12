import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { effectivePermission } from "../../permissions/resolver.js";
import { mintSyncToken } from "../../tokens/sync-token.js";
import { getSession } from "../session.js";

/**
 * POST /api/sync-token  { docId }  (spec 03 §7, 04 §4)
 *
 * Validates the Better Auth session, computes effective permission, and mints a
 * short-lived per-doc JWT:
 *   edit -> { readOnly:false }, view -> { readOnly:true }, none -> 403.
 */
export const syncTokenRoutes = new Hono();

async function docVaultId(docId: string): Promise<string | null> {
  const { rows } = await pool.query<{ vault_id: string }>(
    `SELECT vault_id FROM notes WHERE id = $1 AND deleted_at IS NULL
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
  if (!vaultId) return c.json({ error: "Unknown document" }, 404);

  const permission = await effectivePermission(session.userId, docId);
  if (permission === "none") {
    return c.json({ error: "No access to this document" }, 403);
  }

  const readOnly = permission === "view";
  // userId travels in the token so the sync server can attribute the edits that
  // arrive on this connection ("last edited by" + version authorship).
  const token = await mintSyncToken({ docId, vaultId, readOnly, userId: session.userId });
  return c.json({ token, docId, vaultId, readOnly, permission });
});
