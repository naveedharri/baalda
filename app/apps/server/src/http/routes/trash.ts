// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { scheduleIndex } from "../../index/indexer.js";
import { listTrash, restoreNote, trashContent, TrashError } from "../../trash/service.js";
import { trashChanged } from "../../trash/activity.js";
import { getSession } from "../session.js";
import { ACCOUNT_READ_ONLY_BODY } from "../../permissions/http-gates.js";

import { ORIGIN_HEADER } from "./registry.js";
import { docCryptoOf, KeyRequiredError, keyRequiredResponse, requireVaultKey } from "../../crypto/transport.js";

/** `requireVaultKey`'s refusal, carried out of the service to be returned as-is. */
class KeyRefusal extends Error {
  constructor(readonly response: Response) {
    super("vault key refused");
  }
}

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
    // W3: a keyed vault's text is read with THIS request's key (Rule 1): 409
    // `key_required` without it, 426 for a build that predates vault keys.
    const cryptoFor = async (vaultId: string) => {
      const vkr = await requireVaultKey(c, vaultId);
      if (!vkr.ok) throw new KeyRefusal(vkr.response);
      return docCryptoOf(vaultId, vkr);
    };
    try {
      return c.json(await trashContent(session.userId, c.req.param("docId"), cryptoFor));
    } catch (err) {
      if (err instanceof KeyRefusal) return err.response;
      if (err instanceof KeyRequiredError) return keyRequiredResponse(c, null);
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
      trashChanged(out.vaultId);
      return c.json({ docId: out.docId, relPath: out.relPath, renamed: out.renamed }, 200);
    } catch (err) {
      if (err instanceof TrashError && err.status === 402) return c.json(ACCOUNT_READ_ONLY_BODY, 402);
      if (err instanceof TrashError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  return routes;
}
