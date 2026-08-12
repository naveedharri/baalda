import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { canEditDoc } from "../../permissions/http-gates.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { effectivePermission } from "../../permissions/resolver.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
import { recordVersion, sha256Hex, stampLastEdited } from "../../versions/capture.js";
import {
  captureCheckpoint,
  getCheckpointSummary,
  listCheckpoints,
  withVaultCheckpointLock,
} from "../../versions/checkpoints.js";
import { revertVaultToCheckpoint, RevertError } from "../../versions/revert.js";
import { getSession } from "../session.js";

/**
 * Version history API (session-authenticated).
 *
 *   GET    /api/notes/:id/versions                    list (view)
 *   GET    /api/notes/:id/versions/:versionId         one version + content (view)
 *   POST   /api/notes/:id/versions/:versionId/revert  restore it (edit)
 *   GET    /api/vaults/:vaultId/checkpoints           list (member)
 *   POST   /api/vaults/:vaultId/checkpoints           create (owner/admin)
 *   DELETE /api/vaults/:vaultId/checkpoints/:id       delete (owner/admin)
 *   POST   /api/vaults/:vaultId/checkpoints/:id/revert  revert the vault (owner)
 *
 * Gates mirror the rest of the app: per-doc `effectivePermission` for note
 * versions (so a `locked` share caps at view and a revert 403s), org role for
 * vault-wide operations. Version CONTENT is served only from the per-version
 * endpoint, never from a listing.
 */

export interface VersionRouteDeps {
  docWriter: DocWriter;
  /** Broadcast so open clients re-pull after a revert. */
  onRegistryChanged: (vaultId: string, originId: string | null) => void;
}

interface VersionRow {
  id: string;
  doc_id: string;
  created_at: Date;
  cause: "idle" | "pre-revert";
  author_id: string | null;
  author_name: string | null;
  sha256: string;
  size: number;
}

function versionSummary(r: VersionRow) {
  return {
    id: Number(r.id),
    createdAt: new Date(r.created_at).toISOString(),
    cause: r.cause,
    authorId: r.author_id,
    authorName: r.author_name,
    sha256: r.sha256,
    size: r.size,
  };
}

/** Live note → its collection id, or null when the note is gone. */
async function noteVaultId(docId: string): Promise<string | null> {
  const { rows } = await pool.query<{ vault_id: string }>(
    "SELECT vault_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
    [docId],
  );
  return rows[0]?.vault_id ?? null;
}

export function createVersionRoutes(deps: VersionRouteDeps): Hono {
  const routes = new Hono();

  // ── per-note versions ──────────────────────────────────────────────────────

  routes.get("/notes/:id/versions", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const docId = c.req.param("id");
    if (!(await noteVaultId(docId))) return c.json({ error: "Unknown note" }, 404);
    if ((await effectivePermission(session.userId, docId)) === "none") {
      return c.json({ error: "No access to this note" }, 403);
    }

    const { rows } = await pool.query<VersionRow>(
      `SELECT v.id, v.doc_id, v.created_at, v.cause, v.author_id,
              u.name AS author_name, v.sha256, octet_length(v.content) AS size
         FROM note_versions v
         LEFT JOIN "user" u ON u.id = v.author_id
        WHERE v.doc_id = $1
        ORDER BY v.id DESC`,
      [docId],
    );
    return c.json({ versions: rows.map(versionSummary) });
  });

  routes.get("/notes/:id/versions/:versionId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const docId = c.req.param("id");
    if (!(await noteVaultId(docId))) return c.json({ error: "Unknown note" }, 404);
    if ((await effectivePermission(session.userId, docId)) === "none") {
      return c.json({ error: "No access to this note" }, 403);
    }

    const versionId = Number.parseInt(c.req.param("versionId"), 10);
    if (!Number.isFinite(versionId)) return c.json({ error: "Unknown version" }, 404);
    const { rows } = await pool.query<VersionRow & { content: string }>(
      `SELECT v.id, v.doc_id, v.created_at, v.cause, v.author_id,
              u.name AS author_name, v.sha256, octet_length(v.content) AS size, v.content
         FROM note_versions v
         LEFT JOIN "user" u ON u.id = v.author_id
        WHERE v.id = $1`,
      [versionId],
    );
    const row = rows[0];
    // A version id belongs to exactly one doc; asking for it under another note
    // is a 404, not a peek at someone else's content.
    if (!row || row.doc_id !== docId) return c.json({ error: "Unknown version" }, 404);
    return c.json({ ...versionSummary(row), content: row.content });
  });

  routes.post("/notes/:id/versions/:versionId/revert", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const docId = c.req.param("id");
    const vaultId = await noteVaultId(docId);
    if (!vaultId) return c.json({ error: "Unknown note" }, 404);
    if (!(await canEditDoc(session.userId, docId))) {
      return c.json({ error: "You cannot edit this note" }, 403);
    }

    const versionId = Number.parseInt(c.req.param("versionId"), 10);
    if (!Number.isFinite(versionId)) return c.json({ error: "Unknown version" }, 404);
    const { rows } = await pool.query<{ doc_id: string; content: string }>(
      "SELECT doc_id, content FROM note_versions WHERE id = $1",
      [versionId],
    );
    const version = rows[0];
    if (!version || version.doc_id !== docId) return c.json({ error: "Unknown version" }, 404);

    // Capture where we are BEFORE overwriting it, so a revert is itself
    // undoable. `recordVersion` dedupes against the newest stored version, so
    // this is a no-op (null) when nothing has changed since the last capture.
    const current = await deps.docWriter.readContent(vaultId, docId);
    const preRevertVersionId = await recordVersion({
      vaultId,
      docId,
      content: current,
      cause: "pre-revert",
      authorId: session.userId,
    });

    // Forward-only: set the target text as a normal transaction so live editors
    // merge it. Never a state replace.
    if (sha256Hex(current) !== sha256Hex(version.content)) {
      await deps.docWriter.setContent(vaultId, docId, version.content, {
        userId: session.userId,
      });
    }
    await stampLastEdited(docId, session.userId);
    deps.onRegistryChanged(vaultId, null);
    return c.json({ ok: true, preRevertVersionId });
  });

  // ── vault checkpoints ──────────────────────────────────────────────────────

  /** Caller's role in the vault's organization, or null when not a member. */
  async function vaultRole(vaultId: string, userId: string): Promise<string | null | undefined> {
    const org = await vaultOrg(vaultId);
    if (!org) return undefined; // unknown vault
    return orgRole(org, userId);
  }

  routes.get("/vaults/:vaultId/checkpoints", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const role = await vaultRole(vaultId, session.userId);
    if (role === undefined) return c.json({ error: "Unknown vault" }, 404);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);
    return c.json({ checkpoints: await listCheckpoints(pool, vaultId) });
  });

  routes.post("/vaults/:vaultId/checkpoints", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const role = await vaultRole(vaultId, session.userId);
    if (role === undefined) return c.json({ error: "Unknown vault" }, 404);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner/admin can create checkpoints" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

    const outcome = await withVaultCheckpointLock(vaultId, (db) =>
      captureCheckpoint({
        db,
        docWriter: deps.docWriter,
        vaultId,
        kind: "manual",
        label,
        createdBy: session.userId,
      }),
    );
    // Busy: another checkpoint or a revert is running on this vault right now.
    if (!outcome.acquired) return c.json({ error: "Vault is busy, try again" }, 409);

    const summary = await getCheckpointSummary(pool, vaultId, outcome.value.id);
    return c.json(summary ?? { id: outcome.value.id }, 201);
  });

  routes.delete("/vaults/:vaultId/checkpoints/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const role = await vaultRole(vaultId, session.userId);
    if (role === undefined) return c.json({ error: "Unknown vault" }, 404);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner/admin can delete checkpoints" }, 403);
    }
    const { rowCount } = await pool.query(
      "DELETE FROM vault_checkpoints WHERE id = $1 AND vault_id = $2",
      [c.req.param("id"), vaultId],
    );
    if (!rowCount) return c.json({ error: "Unknown checkpoint" }, 404);
    return c.body(null, 204);
  });

  routes.post("/vaults/:vaultId/checkpoints/:id/revert", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const role = await vaultRole(vaultId, session.userId);
    if (role === undefined) return c.json({ error: "Unknown vault" }, 404);
    // Owner only: this rewrites every note in the vault at once.
    if (role !== "owner") {
      return c.json({ error: "Only the vault owner can revert a vault" }, 403);
    }
    const checkpointId = c.req.param("id");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM vault_checkpoints WHERE id = $1 AND vault_id = $2",
      [checkpointId, vaultId],
    );
    if (!rows[0]) return c.json({ error: "Unknown checkpoint" }, 404);

    try {
      const outcome = await revertVaultToCheckpoint({
        vaultId,
        checkpointId,
        userId: session.userId,
        docWriter: deps.docWriter,
        onRegistryChanged: deps.onRegistryChanged,
      });
      if (!outcome.acquired) return c.json({ error: "Vault is busy, try again" }, 409);
      return c.json({ ok: true, ...outcome.result });
    } catch (err) {
      if (err instanceof RevertError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  return routes;
}
