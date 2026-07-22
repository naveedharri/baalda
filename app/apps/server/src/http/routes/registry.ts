import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { listReadableDocsInVault, listVisibleFolders } from "../../permissions/vault-docs.js";
import { getSession } from "../session.js";

export interface RegistryDeps {
  /**
   * Called after any change to a vault's folder/note structure (create, rename,
   * move, delete). The vault channel broadcasts a `registry` control frame so
   * every open client re-pulls the registry and updates its local tree live —
   * without this, structural changes only surfaced on the next app restart.
   */
  onRegistryChanged?: (vaultId: string) => void;
}

/**
 * Registry API (session-authenticated). Lets the client map local vault files to
 * server doc_ids: create/list/rename/delete vaults, folders, notes, files.
 * doc_id is the join key between the .md file, the Yjs doc, and the relational
 * rows, and is NEVER changed by a rename/move — only the path columns move, so a
 * note keeps one identity across devices (spec: "key by doc_id, never by path").
 */
export function createRegistryRoutes(deps: RegistryDeps = {}): Hono {
  const registryRoutes = new Hono();
  const changed = (vaultId: string) => deps.onRegistryChanged?.(vaultId);

  // ── vaults ─────────────────────────────────────────────────────────────────
  registryRoutes.post("/vaults", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const name = body.name;
    const organizationId = body.organizationId ?? session.activeOrganizationId;
    if (typeof name !== "string" || !name) {
      return c.json({ error: "name is required" }, 400);
    }
    if (typeof organizationId !== "string" || !organizationId) {
      return c.json({ error: "organizationId is required (no active org)" }, 400);
    }

    const role = await orgRole(organizationId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only vault owner/admin can create vaults" }, 403);
    }

    const id = randomUUID();
    await pool.query(
      "INSERT INTO vaults (id, organization_id, name) VALUES ($1, $2, $3)",
      [id, organizationId, name],
    );
    // Private-by-default: a new vault grants NO org-wide access. Members see
    // only what they create or what an owner/admin explicitly shares with the
    // team (per-folder/file, or a vault-wide grant) via the Access panel.
    return c.json({ id, organizationId, name }, 201);
  });

  registryRoutes.get("/vaults", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query(
      `SELECT v.id, v.organization_id, v.name, v.created_at
         FROM vaults v
         JOIN member m ON m."organizationId" = v.organization_id
        WHERE m."userId" = $1
        ORDER BY v.created_at ASC`,
      [session.userId],
    );
    return c.json({ vaults: rows });
  });

  // ── folders ──────────────────────────────────────────────────────────────
  registryRoutes.post("/folders", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const { vaultId, name, path, parentId } = body;
    if (typeof vaultId !== "string" || typeof name !== "string" || typeof path !== "string") {
      return c.json({ error: "vaultId, name, path are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    // A given path maps to one folder per vault — adopt an existing row rather
    // than duplicating it (reconcile and on-demand create can race).
    const existing = await pool.query(
      "SELECT id FROM folders WHERE vault_id = $1 AND path = $2 LIMIT 1",
      [vaultId, path],
    );
    if (existing.rows[0]) {
      return c.json({ id: existing.rows[0].id, vaultId, parentId: parentId ?? null, name, path }, 200);
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO folders (id, vault_id, parent_id, name, path, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, vaultId, parentId ?? null, name, path, body.sort ?? 0, session.userId],
    );
    changed(vaultId);
    return c.json({ id, vaultId, parentId: parentId ?? null, name, path }, 201);
  });

  registryRoutes.get("/folders", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.query("vaultId");
    if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
    const org = await vaultOrg(vaultId);
    if (!org || !(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    // Private-by-default: only folders the caller may see (created / shared /
    // path-to-a-shared-note). Owner/admin + Open vaults see everything.
    const folders = await listVisibleFolders(session.userId, vaultId);
    return c.json({ folders });
  });

  // Rename / move a folder. Rewrites the folder's own row AND every descendant
  // folder + note's path prefix (old → new) in place — ids are untouched, so
  // backlinks and CRDT docs survive the move.
  registryRoutes.patch("/folders/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { rows } = await pool.query(
      "SELECT vault_id, path FROM folders WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown folder" }, 404);
    if (!(await orgRole((await vaultOrg(row.vault_id))!, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const oldPath: string = row.path;
    const newPath = typeof body.path === "string" ? body.path : oldPath;
    const newName = typeof body.name === "string" ? body.name : basename(newPath);
    const newParentId = body.parentId === undefined ? undefined : (body.parentId ?? null);

    await pool.query(
      `UPDATE folders SET path = $1, name = $2${newParentId === undefined ? "" : ", parent_id = $4"}
       WHERE id = $3`,
      newParentId === undefined ? [newPath, newName, id] : [newPath, newName, id, newParentId],
    );
    if (newPath !== oldPath) {
      await rewriteDescendantPaths(row.vault_id, oldPath, newPath);
    }
    changed(row.vault_id);
    return c.json({ id, vaultId: row.vault_id, name: newName, path: newPath }, 200);
  });

  // Delete a folder subtree: soft-delete its notes (they keep their doc_id so a
  // teammate who has one open just loses tree visibility), then remove the
  // folder rows (ON DELETE CASCADE clears descendant folders).
  registryRoutes.delete("/folders/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const { rows } = await pool.query(
      "SELECT vault_id, path FROM folders WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown folder" }, 404);
    if (!(await orgRole((await vaultOrg(row.vault_id))!, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    await pool.query(
      `UPDATE notes SET deleted_at = now()
        WHERE vault_id = $1 AND deleted_at IS NULL
          AND (rel_path = $2 OR rel_path LIKE $2 || '/%')`,
      [row.vault_id, row.path],
    );
    await pool.query("DELETE FROM folders WHERE id = $1", [id]);
    changed(row.vault_id);
    return c.json({ ok: true }, 200);
  });

  // ── notes (markdown docs; id == doc_id) ────────────────────────────────────
  registryRoutes.post("/notes", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const { vaultId, folderId, title, relPath } = body;
    if (typeof vaultId !== "string" || typeof relPath !== "string") {
      return c.json({ error: "vaultId and relPath are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    // Client may supply a stable doc_id (generated locally); else we mint one.
    const id = typeof body.docId === "string" && body.docId ? body.docId : randomUUID();
    await pool.query(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $1, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, vaultId, folderId ?? null, title ?? null, relPath, session.userId],
    );
    changed(vaultId);
    return c.json(
      { id, docId: id, vaultId, folderId: folderId ?? null, title: title ?? null, relPath },
      201,
    );
  });

  registryRoutes.get("/notes", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.query("vaultId");
    if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
    const org = await vaultOrg(vaultId);
    if (!org || !(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const { rows } = await pool.query(
      `SELECT id, vault_id, folder_id, title, rel_path, doc_id, created_by, created_at, updated_at
         FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path`,
      [vaultId],
    );
    // Private-by-default: hide notes the caller can't read (leaks title/path and
    // would make the client materialize a note it can't sync). Owner/admin +
    // Open vaults get the full set from the readable-docs resolver.
    const readable = await listReadableDocsInVault(session.userId, vaultId);
    return c.json({ notes: rows.filter((n) => readable.has(n.id)) });
  });

  // Rename / move a single note (rel_path / folder / title). doc_id unchanged.
  registryRoutes.patch("/notes/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { rows } = await pool.query(
      "SELECT vault_id, rel_path, title, folder_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown note" }, 404);
    if (!(await orgRole((await vaultOrg(row.vault_id))!, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const relPath = typeof body.relPath === "string" ? body.relPath : row.rel_path;
    const title = body.title === undefined ? row.title : body.title;
    const folderId = body.folderId === undefined ? row.folder_id : (body.folderId ?? null);
    await pool.query(
      "UPDATE notes SET rel_path = $1, title = $2, folder_id = $3, updated_at = now() WHERE id = $4",
      [relPath, title, folderId, id],
    );
    changed(row.vault_id);
    return c.json({ id, docId: id, vaultId: row.vault_id, relPath, title, folderId }, 200);
  });

  // Soft-delete a note (keeps its row/doc_id; excluded from the registry list).
  registryRoutes.delete("/notes/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const { rows } = await pool.query(
      "SELECT vault_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown note" }, 404);
    if (!(await orgRole((await vaultOrg(row.vault_id))!, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [id]);
    changed(row.vault_id);
    return c.json({ ok: true }, 200);
  });

  // ── files (generic vault-file <-> doc mapping; id == doc_id) ────────────────
  registryRoutes.post("/files", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const { vaultId, folderId, path } = body;
    if (typeof vaultId !== "string" || typeof path !== "string") {
      return c.json({ error: "vaultId and path are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const id = typeof body.docId === "string" && body.docId ? body.docId : randomUUID();
    await pool.query(
      "INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      [id, vaultId, folderId ?? null, path],
    );
    changed(vaultId);
    return c.json({ id, docId: id, vaultId, folderId: folderId ?? null, path }, 201);
  });

  return registryRoutes;
}

/** Rewrite the path prefix of every descendant folder + note of a moved folder.
 *  `oldPath`/`newPath` are the folder's own paths; children share the prefix. */
async function rewriteDescendantPaths(
  vaultId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  // Postgres substring is 1-indexed; keep everything AFTER the old prefix. The
  // $4::int cast is load-bearing: a bare text param would select substring's
  // REGEX overload (substring(text FROM text)) and silently return NULL.
  const from = oldPath.length + 1;
  await pool.query(
    `UPDATE folders
        SET path = $2 || substring(path FROM $4::int)
      WHERE vault_id = $1 AND path LIKE $3 || '/%'`,
    [vaultId, newPath, oldPath, from],
  );
  await pool.query(
    `UPDATE notes
        SET rel_path = $2 || substring(rel_path FROM $4::int), updated_at = now()
      WHERE vault_id = $1 AND rel_path LIKE $3 || '/%'`,
    [vaultId, newPath, oldPath, from],
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
