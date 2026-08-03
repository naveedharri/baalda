import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { canEditDoc, canEditFolder } from "../../permissions/http-gates.js";
import { listReadableDocsInVault, listVisibleFolders } from "../../permissions/vault-docs.js";
import { purgeNoteIndex } from "../../index/indexer.js";
import { getSession } from "../session.js";

export interface RegistryDeps {
  /**
   * Called after any change to a vault's folder/note structure (create, rename,
   * move, delete). The vault channel broadcasts a `registry` control frame so
   * every open client re-pulls the registry and updates its local tree live —
   * without this, structural changes only surfaced on the next app restart.
   *
   * `originId` is the calling client's `x-baalda-origin` (the same opaque id it
   * sends in its vault-channel hello), or null when it didn't send one. The
   * channel uses it to skip notifying the client that caused the change: a
   * 500-note reconcile otherwise bounced ~1,100 `registry` frames back at its
   * own author, each triggering a full per-subscriber ACL recompute.
   */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
}

/** Header carrying the calling client's opaque instance id (see RegistryDeps). */
export const ORIGIN_HEADER = "x-baalda-origin";

/**
 * Registry API (session-authenticated). Lets the client map local vault files to
 * server doc_ids: create/list/rename/delete vaults, folders, notes, files.
 * doc_id is the join key between the .md file, the Yjs doc, and the relational
 * rows, and is NEVER changed by a rename/move — only the path columns move, so a
 * note keeps one identity across devices (spec: "key by doc_id, never by path").
 */
export function createRegistryRoutes(deps: RegistryDeps = {}): Hono {
  const registryRoutes = new Hono();
  // `c` is threaded in so the origin travels with the notification. It is a hint
  // only — a client that omits or forges it just gets told to re-pull, which is
  // exactly the pre-existing behaviour. It never affects authorization.
  const changed = (c: { req: { header: (n: string) => string | undefined } }, vaultId: string) =>
    deps.onRegistryChanged?.(vaultId, c.req.header(ORIGIN_HEADER) ?? null);

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
    changed(c, vaultId);
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
    // Edit permission on the folder itself (not bare membership): owner/admin,
    // the folder's creator, or an edit share. Blocks renaming/moving folders a
    // member has no rights on.
    if (!(await canEditFolder(session.userId, id))) {
      return c.json({ error: "You cannot modify this folder" }, 403);
    }
    const oldPath: string = row.path;
    const newPath = typeof body.path === "string" ? body.path : oldPath;
    const newName = typeof body.name === "string" ? body.name : basename(newPath);
    const newParentId = body.parentId === undefined ? undefined : (body.parentId ?? null);
    // Re-parenting under another folder must not be a way to change inherited
    // access: require edit on the destination parent too (root/null is fine).
    if (newParentId != null && !(await canEditFolder(session.userId, newParentId))) {
      return c.json({ error: "You cannot move this folder there" }, 403);
    }

    await pool.query(
      `UPDATE folders SET path = $1, name = $2${newParentId === undefined ? "" : ", parent_id = $4"}
       WHERE id = $3`,
      newParentId === undefined ? [newPath, newName, id] : [newPath, newName, id, newParentId],
    );
    if (newPath !== oldPath) {
      await rewriteDescendantPaths(row.vault_id, oldPath, newPath);
    }
    changed(c, row.vault_id);
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
    if (!(await canEditFolder(session.userId, id))) {
      return c.json({ error: "You cannot delete this folder" }, 403);
    }
    // $2 is an exact match; $3 is the LIKE prefix with %/_ escaped so a folder
    // path containing wildcards cannot widen the soft-delete beyond its subtree.
    // RETURNING id gives us exactly the cascade's victims, so their derived
    // index rows go with them (see the single-note delete below).
    const { rows: cascaded } = await pool.query<{ id: string }>(
      `UPDATE notes SET deleted_at = now()
        WHERE vault_id = $1 AND deleted_at IS NULL
          AND (rel_path = $2 OR rel_path LIKE $3 || '/%' ESCAPE '\\')
        RETURNING id`,
      [row.vault_id, row.path, likeEscape(row.path)],
    );
    await pool.query("DELETE FROM folders WHERE id = $1", [id]);
    await purgeNoteIndex(cascaded.map((n) => n.id));
    changed(c, row.vault_id);
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
    // RETURNING tells us whether the row is actually ours. `DO NOTHING` alone is
    // silent about *why* nothing happened, and answering 201 regardless told the
    // client "doc `id` now belongs to `vaultId`" even when that id was already a
    // note in a DIFFERENT vault. The client persisted that mapping and then synced
    // against a doc it has no grant on: /api/sync-token 403s forever, the provider
    // reconnects on every rejection, and the note never loads. A doc_id is global,
    // so a collision across vaults has to be reported, not swallowed.
    const inserted = await pool.query(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $1, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, vaultId, folderId ?? null, title ?? null, relPath, session.userId],
    );
    if (inserted.rowCount === 0) {
      const { rows: existing } = await pool.query<{ vault_id: string; rel_path: string }>(
        "SELECT vault_id, rel_path FROM notes WHERE id = $1",
        [id],
      );
      const row = existing[0];
      // Re-registering the same note in the same vault is the ordinary adopt
      // path (a second device, or a repeat reconcile) — still a success.
      if (row && row.vault_id !== vaultId) {
        return c.json(
          {
            error: "doc_id already belongs to another vault",
            code: "doc_id_conflict",
            docId: id,
          },
          409,
        );
      }
    }
    changed(c, vaultId);
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
    // Edit permission on the note itself (owner/admin, creator, or edit share),
    // not bare membership. This also closes the relocate-to-escalate path: a
    // member with no access to the note can't rename/move it at all.
    if (!(await canEditDoc(session.userId, id))) {
      return c.json({ error: "You cannot modify this note" }, 403);
    }
    const relPath = typeof body.relPath === "string" ? body.relPath : row.rel_path;
    const title = body.title === undefined ? row.title : body.title;
    const folderId = body.folderId === undefined ? row.folder_id : (body.folderId ?? null);
    await pool.query(
      "UPDATE notes SET rel_path = $1, title = $2, folder_id = $3, updated_at = now() WHERE id = $4",
      [relPath, title, folderId, id],
    );
    changed(c, row.vault_id);
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
    // Edit permission required to destroy a note — not bare membership.
    if (!(await canEditDoc(session.userId, id))) {
      return c.json({ error: "You cannot delete this note" }, 403);
    }
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [id]);
    // Drop the DERIVED search/graph rows with the note. They are a rebuildable
    // cache of the canonical Yjs state (migration 005), and note_index keeps a
    // full plain-text copy of the body — leaving it behind grew those tables
    // without bound and kept "deleted" content readable server-side. The Yjs
    // doc and the doc_id survive untouched, so re-creating the note re-indexes
    // it on its next store (indexer.scheduleIndex / backfillIndex).
    await purgeNoteIndex([id]);
    changed(c, row.vault_id);
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
    changed(c, vaultId);
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
  // $3 is the LIKE prefix with %/_ escaped so a folder path containing SQL
  // wildcards cannot match (and rewrite) unrelated notes/folders. The substring
  // offset ($4) is the true prefix length, unaffected by escaping.
  const prefix = likeEscape(oldPath);
  await pool.query(
    `UPDATE folders
        SET path = $2 || substring(path FROM $4::int)
      WHERE vault_id = $1 AND path LIKE $3 || '/%' ESCAPE '\\'`,
    [vaultId, newPath, prefix, from],
  );
  await pool.query(
    `UPDATE notes
        SET rel_path = $2 || substring(rel_path FROM $4::int), updated_at = now()
      WHERE vault_id = $1 AND rel_path LIKE $3 || '/%' ESCAPE '\\'`,
    [vaultId, newPath, prefix, from],
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Escape SQL LIKE metacharacters (\ % _) so a value is matched literally under
 *  `LIKE … ESCAPE '\'`. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
