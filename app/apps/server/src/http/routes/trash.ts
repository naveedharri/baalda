// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { scheduleIndex } from "../../index/indexer.js";
import { listTrash, restoreNote, trashContent, TrashError } from "../../trash/service.js";
import { getSession } from "../session.js";

import { ORIGIN_HEADER } from "./registry.js";

export interface TrashRouteDeps {
  onRegistryChanged?: (vaultId: string, origin: string | null) => void;
}

/**
 * GET  /api/vaults/:vaultId/trash   deleted notes the caller could read
 * POST /api/notes/:docId/restore    undelete (edit on the note, or owner/admin)
 * GET  /api/notes/:docId/trash-content  a deleted note's current text (read, or owner/admin)
 */
export function createTrashRoutes(deps: TrashRouteDeps): Hono {
  const routes = new Hono();

  routes.get("/vaults/:vaultId/trash", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    try {
      return c.json(await listTrash(session.userId, c.req.param("vaultId")));
    } catch (err) {
      if (err instanceof TrashError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  routes.get("/notes/:docId/trash-content", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    try {
      return c.json(await trashContent(session.userId, c.req.param("docId")));
    } catch (err) {
      if (err instanceof TrashError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  routes.post("/notes/:docId/restore", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    try {
      const out = await restoreNote(session.userId, c.req.param("docId"));
      scheduleIndex(out.docId, 0);
      deps.onRegistryChanged?.(out.vaultId, c.req.header(ORIGIN_HEADER) ?? null);
      return c.json({ docId: out.docId, relPath: out.relPath, renamed: out.renamed }, 200);
    } catch (err) {
      if (err instanceof TrashError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  return routes;
}
