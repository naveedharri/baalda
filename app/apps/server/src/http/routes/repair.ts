import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { canEditDoc } from "../../permissions/http-gates.js";
import { docStoredBytes, resetDocCrdt } from "../../yjs/persistence.js";
import { getSession } from "../session.js";

/**
 * Repair endpoints for docs the sync layer cannot fix on its own.
 *
 *   GET  /api/notes/:id/crdt-size    how big this doc is, and whether it is stuck
 *   POST /api/notes/:id/reset-crdt   discard its history and re-seed it (edit)
 *
 * ── Why this has to exist ────────────────────────────────────────────────────
 * A doc whose Yjs state exceeds `MAX_NOTE_MB` is refused by the sync server on
 * every connect. That makes it unfixable through the product's normal surfaces:
 * you cannot edit it down, because editing requires a connection, and every
 * connection is closed before a single update is applied. The client-side size
 * guard stops the resulting reconnect storm but cannot un-stick the note — only
 * discarding the history can, and only the server owns the canonical copy.
 *
 * Resetting is destructive in a specific and bounded way: the note's TEXT is
 * preserved (the caller sends what it should be), its edit HISTORY is not. That
 * is the trade being made deliberately — in every case seen so far the history
 * was duplication garbage from a past fork, and the text was the salvageable
 * part.
 */

export interface RepairRouteDeps {
  /** Close every socket on a doc and drop the server's cached copy, so clients
   *  re-pull the reset doc instead of merging the old one back in. */
  evictDoc: (vaultId: string, docId: string) => Promise<void> | void;
}

/** Live note → its collection id, or null when the note is gone. */
async function noteVaultId(docId: string): Promise<string | null> {
  const { rows } = await pool.query<{ vault_id: string }>(
    "SELECT vault_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
    [docId],
  );
  return rows[0]?.vault_id ?? null;
}

export function createRepairRoutes(deps: RepairRouteDeps): Hono {
  const routes = new Hono();
  const capBytes = config.maxNoteMb * 1024 * 1024;

  routes.get("/notes/:id/crdt-size", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const docId = c.req.param("id");
    const vaultId = await noteVaultId(docId);
    if (!vaultId) return c.json({ error: "Note not found" }, 404);
    // Size is an edit-level fact here: it is only actionable by someone who
    // could reset the doc, and it leaks how much content a doc holds.
    if (!(await canEditDoc(session.userId, docId))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const bytes = await docStoredBytes(docId);
    return c.json({ docId, bytes, capBytes, overCap: bytes > capBytes });
  });

  routes.post("/notes/:id/reset-crdt", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const docId = c.req.param("id");
    const vaultId = await noteVaultId(docId);
    if (!vaultId) return c.json({ error: "Note not found" }, 404);
    if (!(await canEditDoc(session.userId, docId))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    let body: { content?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {}; // no body ⇒ reset to empty
    }
    const content = typeof body.content === "string" ? body.content : "";
    // The replacement must itself fit, or the reset would hand back a doc that
    // is stuck in exactly the same way.
    if (Buffer.byteLength(content, "utf8") > capBytes) {
      return c.json(
        { error: "content_too_large", capBytes },
        413,
      );
    }

    const before = await docStoredBytes(docId);
    const { bytes: after } = await resetDocCrdt(docId, content);
    // Evict AFTER the write: a client that reconnects in between must find the
    // new state, never the old cached doc.
    await deps.evictDoc(vaultId, docId);
    return c.json({ docId, bytesBefore: before, bytesAfter: after });
  });

  return routes;
}
