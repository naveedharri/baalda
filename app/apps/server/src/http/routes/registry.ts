import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { canEditDoc, canEditFolder } from "../../permissions/http-gates.js";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
  listVisibleFolders,
} from "../../permissions/vault-docs.js";
import { purgeNoteIndex } from "../../index/indexer.js";
import {
  TreeOpError,
  deleteFolderCascade,
  findFolder,
  findNote,
  moveFolder,
  moveNote,
  planFolderMove,
  planNoteMove,
  resolveFolderParent,
  resolveParentFolder,
} from "../../registry/tree-ops.js";
import { getSession } from "../session.js";

export interface RegistryDeps {
  /** Force-close live sync sockets for a doc, so an editor open on a note that
   *  just got deleted out from under it reconnects and learns it's gone. */
  disconnectDoc?: (vaultId: string, docId: string) => void;
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
 * Is this vault's ROOT closed to new folders/notes?
 *
 * "Freeze root" is a structural latch, not a permission: once a team has agreed
 * the top-level shape, nothing new lands beside it — by anyone, owners and
 * admins included. Making it role-scoped would defeat the point, because the
 * accidental root folder is nearly always created by someone who *does* have
 * permission. An owner/admin lifts the latch first, then creates.
 *
 * Only the root is affected. Everything nested keeps its normal ACL.
 */
export async function isRootFrozen(vaultId: string): Promise<boolean> {
  const { rows } = await pool.query<{ root_frozen: boolean }>(
    "SELECT root_frozen FROM vaults WHERE id = $1",
    [vaultId],
  );
  return rows[0]?.root_frozen === true;
}

/** The 403 body every frozen-root refusal shares, so clients can match on a code. */
const ROOT_FROZEN_ERROR = {
  error: "This vault's root is frozen — create this inside a folder instead.",
  code: "root_frozen",
} as const;

/** 400 body for a path that disagrees with its folder (or names a folder that
 *  does not exist). Terminal for the desktop's `withRetry`, which is right: the
 *  request is wrong, not the network. */
function pathFolderMismatch(err: TreeOpError) {
  return { error: err.message, code: "path_folder_mismatch" } as const;
}

/** Colors are a short id from the client's palette (`lib/appearance`), or null
 *  to clear. Anything else is ignored rather than stored. */
function normalizeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 32) return undefined;
  return value;
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

    // Is this the org's FIRST note collection? Asked before the insert, because
    // the answer decides whether the default access posture applies (below).
    const { rows: existing } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM vaults WHERE organization_id = $1",
      [organizationId],
    );
    const isFirstVault = existing[0]?.n === "0";

    const id = randomUUID();
    await pool.query(
      "INSERT INTO vaults (id, organization_id, name) VALUES ($1, $2, $3)",
      [id, organizationId, name],
    );

    // Shared-with-team by default: a brand-new vault gets an org-wide `edit`
    // grant, so anyone invited can read and write its notes the moment they
    // join.
    //
    // This replaces an earlier private-by-default posture. That one was right
    // about solo vaults and wrong about what vaults are FOR: you invited
    // someone, and they landed on an empty sidebar with no way to ask for
    // access. Owners can still lock a vault down — Access panel → Private
    // revokes exactly this row (`setVaultPosture` in AccessPanel.tsx).
    //
    // Only on the first collection. The grant is keyed on the ORG (one org can
    // own several collections and the grant covers all of them), so re-running
    // it later would resurrect a grant an owner had deliberately revoked —
    // silently re-opening a vault they had set to Private. A default is only a
    // default at creation time; after that the owner's choice is the truth.
    if (isFirstVault) {
      await pool.query(
        `INSERT INTO shares
           (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
         VALUES ($1, $2, 'vault', $2, 'org', $2, 'edit', $3)
         ON CONFLICT (resource_type, resource_id, principal_type, principal_id) DO NOTHING`,
        [randomUUID(), organizationId, session.userId],
      );
    }
    return c.json({ id, organizationId, name, rootFrozen: false }, 201);
  });

  registryRoutes.get("/vaults", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query(
      `SELECT v.id, v.organization_id, v.name, v.created_at, v.root_frozen
         FROM vaults v
         JOIN member m ON m."organizationId" = v.organization_id
        WHERE m."userId" = $1
        ORDER BY v.created_at ASC`,
      [session.userId],
    );
    return c.json({ vaults: rows });
  });

  /**
   * Vault-level settings. Today that is one latch: `rootFrozen`.
   *
   * Owner/admin only to WRITE; every member reads it from `GET /api/vaults`, so
   * a member's Settings page shows the toggle in its real state (disabled) and
   * their client can explain a refusal before the server has to.
   */
  registryRoutes.patch("/vaults/:vaultId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner or admin can change vault settings" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.rootFrozen !== "boolean") {
      return c.json({ error: "rootFrozen (boolean) required" }, 400);
    }
    const { rows } = await pool.query<{ id: string; name: string; root_frozen: boolean }>(
      "UPDATE vaults SET root_frozen = $2 WHERE id = $1 RETURNING id, name, root_frozen",
      [vaultId, body.rootFrozen],
    );
    // Every open client re-pulls the registry on this frame, which is also how
    // they learn the latch moved — no separate broadcast to keep in step.
    changed(c, vaultId);
    return c.json({ id: rows[0].id, name: rows[0].name, rootFrozen: rows[0].root_frozen }, 200);
  });

  /**
   * The vault's WHOLE structure, unfiltered — folders and notes, ids and paths,
   * no content. Owner/admin only.
   *
   * Every other listing here is ACL-filtered, which is right for sync and fatal
   * for administration: the moment an item is set to Private it leaves
   * `GET /api/notes`, its file leaves the manager's disk, and the Access panel —
   * which was drawing its list from that disk — lost the only row you could
   * un-Private it from. A restriction you cannot see is a restriction you cannot
   * lift.
   *
   * Deliberately a separate endpoint rather than a flag on the sync listings.
   * Those feed the reconciler, and an unfiltered response reaching it would have
   * the client materialise notes it has no right to sync. The two must not be
   * one call with a mode switch.
   */
  registryRoutes.get("/vaults/:vaultId/access-tree", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner or admin can manage access" }, 403);
    }
    const [folders, notes] = await Promise.all([
      pool.query<{ id: string; path: string; color: string | null }>(
        "SELECT id, path, color FROM folders WHERE vault_id = $1 ORDER BY path",
        [vaultId],
      ),
      // Paths and titles only. This bypasses the ACL, so it carries the minimum
      // that lets someone administer the tree and nothing that would let them
      // read a note they've shut themselves out of.
      pool.query<{ id: string; rel_path: string }>(
        "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path",
        [vaultId],
      ),
    ]);
    return c.json({
      folders: folders.rows.map((f) => ({ id: f.id, path: f.path, color: f.color })),
      notes: notes.rows.map((n) => ({ id: n.id, relPath: n.rel_path })),
    });
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

    // `path` is authoritative; `parentId` must be the folder at its dirname (or
    // is resolved from it when absent). See `resolveParentFolder` for the
    // incident this closes.
    let resolvedParent: string | null;
    try {
      resolvedParent = await resolveFolderParent(pool, vaultId, path, parentId ?? null);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }

    // Frozen root: only NEW root folders are refused. The adopt path above
    // already returned, so an existing folder still reconciles from every
    // device after the latch goes on. Judged on the RESOLVED parent, so a nested
    // path with no parentId is not mistaken for a root creation.
    if (resolvedParent === null && (await isRootFrozen(vaultId))) {
      return c.json(ROOT_FROZEN_ERROR, 403);
    }

    const id = randomUUID();
    const color = normalizeColor(body.color) ?? null;
    await pool.query(
      `INSERT INTO folders (id, vault_id, parent_id, name, path, sort, created_by, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, vaultId, resolvedParent, name, path, body.sort ?? 0, session.userId, color],
    );
    changed(c, vaultId);
    return c.json({ id, vaultId, parentId: resolvedParent, name, path, color }, 201);
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
    // Folder tombstones ride the same response as note tombstones do on
    // GET /api/notes, and for the same reason: the client subtracts one set
    // from the other, so both must come from one snapshot. Ids only — an id is
    // the minimum that lets a client stop re-registering (and remove) a local
    // folder, and it leaks nothing about what the folder was called.
    const { rows: tombstones } = await pool.query<{ id: string }>(
      "SELECT id FROM folder_tombstones WHERE vault_id = $1",
      [vaultId],
    );
    return c.json({ folders, tombstones: tombstones.map((t) => t.id) });
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
    const newParentId = body.parentId === undefined ? undefined : (body.parentId ?? null);
    const moveInput = {
      path: typeof body.path === "string" ? body.path : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      parentId: newParentId,
    };
    // Resolve where the folder will land BEFORE gating: a `path`-only move to
    // another directory (or to the root) is a re-parent whether or not the
    // caller said `parentId`, and both gates below must see the real target.
    const current = (await findFolder(pool, id))!;
    let plan;
    try {
      plan = await planFolderMove(pool, current, moveInput);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }
    // Re-parenting under another folder must not be a way to change inherited
    // access: require edit on the destination parent too (root/null is fine).
    if (
      plan.parentId != null &&
      plan.parentId !== current.parent_id &&
      !(await canEditFolder(session.userId, plan.parentId))
    ) {
      return c.json({ error: "You cannot move this folder there" }, 403);
    }

    // Moving a folder OUT to the root is a root creation by another name.
    if (plan.parentId === null && current.parent_id !== null && (await isRootFrozen(row.vault_id))) {
      return c.json(ROOT_FROZEN_ERROR, 403);
    }

    // Color is a vault-wide fact about the folder, so it rides the same PATCH
    // and syncs to every member like a rename does.
    const color = normalizeColor(body.color);
    if (color !== undefined) {
      await pool.query("UPDATE folders SET color = $2 WHERE id = $1", [id, color]);
    }

    try {
      const moved = await moveFolder(pool, id, moveInput);
      changed(c, moved.vaultId);
      return c.json(
        { id, vaultId: moved.vaultId, name: moved.name, path: moved.path, color },
        200,
      );
    } catch (err) {
      if (err instanceof TreeOpError) return c.json({ error: err.message }, 400);
      throw err;
    }
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
    const { deletedNoteIds } = await deleteFolderCascade(pool, id);
    // Their derived index rows go with them (see the single-note delete below)…
    await purgeNoteIndex(deletedNoteIds);
    // …and anyone with one of them open is kicked off the now-gone doc. Without
    // this a folder delete left live editors happily typing into notes that no
    // longer exist anywhere in the tree — the single-note delete has always done
    // it, and there's no reason a cascade should be gentler.
    for (const docId of deletedNoteIds) deps.disconnectDoc?.(row.vault_id, docId);
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

    // A live note already at this path IS this note — return it so the caller
    // adopts its doc_id. Registering the same path under a DIFFERENT id used to
    // create a second live row, forking the note's identity: two devices then
    // map one file to two docs, and every external write bounces between them,
    // duplicating the content each cycle (the 2026-08-25 runaway-daily-notes
    // incident). The unique index `notes_live_path_uq` backstops the race below.
    const { rows: samePath } = await pool.query<{
      id: string;
      folder_id: string | null;
      title: string | null;
    }>(
      "SELECT id, folder_id, title FROM notes WHERE vault_id = $1 AND rel_path = $2 AND deleted_at IS NULL",
      [vaultId, relPath],
    );
    if (samePath.length > 0) {
      const row = samePath[0];
      return c.json(
        {
          id: row.id,
          docId: row.id,
          vaultId,
          folderId: row.folder_id,
          title: row.title,
          relPath,
        },
        200,
      );
    }

    // `relPath` is authoritative; `folderId` must be the folder at its dirname
    // (or is resolved from it when the client sent none). A desktop whose
    // folder map missed a parent, or an assistant that computed the two
    // inconsistently, otherwise writes a row every client renders in one place
    // and every ACL walk reads in another (2026-08-27 phantom-root-folder).
    let resolvedFolder: string | null;
    try {
      resolvedFolder = await resolveParentFolder(pool, vaultId, relPath, folderId ?? null);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }

    // Frozen root: refuse only notes that do not exist yet. Re-registering a
    // root note that predates the latch (a second device, a repeat reconcile)
    // has to keep working, or freezing the root would break sync for the very
    // notes the team froze it to protect. Judged on the RESOLVED parent.
    if (resolvedFolder === null && (await isRootFrozen(vaultId))) {
      const { rowCount } = await pool.query("SELECT 1 FROM notes WHERE id = $1", [id]);
      if (!rowCount) return c.json(ROOT_FROZEN_ERROR, 403);
    }
    // RETURNING tells us whether the row is actually ours. `DO NOTHING` alone is
    // silent about *why* nothing happened, and answering 201 regardless told the
    // client "doc `id` now belongs to `vaultId`" even when that id was already a
    // note in a DIFFERENT vault. The client persisted that mapping and then synced
    // against a doc it has no grant on: /api/sync-token 403s forever, the provider
    // reconnects on every rejection, and the note never loads. A doc_id is global,
    // so a collision across vaults has to be reported, not swallowed.
    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by, color)
         VALUES ($1, $2, $3, $4, $5, $1, $6, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          id,
          vaultId,
          resolvedFolder,
          title ?? null,
          relPath,
          session.userId,
          normalizeColor(body.color) ?? null,
        ],
      );
    } catch (err) {
      // Lost the race against a concurrent register of the same path
      // (notes_live_path_uq). The winner's row is this note — adopt it.
      if ((err as { code?: string }).code === "23505") {
        const { rows } = await pool.query<{
          id: string;
          folder_id: string | null;
          title: string | null;
        }>(
          "SELECT id, folder_id, title FROM notes WHERE vault_id = $1 AND rel_path = $2 AND deleted_at IS NULL",
          [vaultId, relPath],
        );
        const row = rows[0];
        if (row) {
          return c.json(
            { id: row.id, docId: row.id, vaultId, folderId: row.folder_id, title: row.title, relPath },
            200,
          );
        }
      }
      throw err;
    }
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
      { id, docId: id, vaultId, folderId: resolvedFolder, title: title ?? null, relPath },
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
    // last_edited_* rides this pull deliberately: the file rows that show
    // "edited by X" are already re-fetched on every `registry` frame, so
    // attribution stays live without a second endpoint or a new wire frame.
    const { rows } = await pool.query(
      `SELECT n.id, n.vault_id, n.folder_id, n.title, n.rel_path, n.doc_id, n.created_by,
              n.created_at, n.updated_at, n.color,
              n.last_edited_by, u.name AS last_edited_by_name, n.last_edited_at
         FROM notes n
         LEFT JOIN "user" u ON u.id = n.last_edited_by
        WHERE n.vault_id = $1 AND n.deleted_at IS NULL
        ORDER BY n.rel_path`,
      [vaultId],
    );
    // Private-by-default: hide notes the caller can't read (leaks title/path and
    // would make the client materialize a note it can't sync). Owner/admin +
    // Open vaults get the full set from the readable-docs resolver.
    const readable = await listReadableDocsInVault(session.userId, vaultId);
    // Tombstones ride along in the SAME response, deliberately. The client's
    // whole reason for asking is to subtract one set from the other, and two
    // requests would let a note deleted in between land in neither list (or, on
    // the other ordering, in both) — forcing the client to invent a precedence
    // rule. One request, one snapshot, no rule needed.
    //
    // Ids only, no path or title: this is the signal that lets a client delete a
    // local file, so it carries the minimum that can justify that.
    const tombstones = await listDeletedReadableDocsInVault(session.userId, vaultId);
    return c.json({
      notes: rows.filter((n) => readable.has(n.id)),
      tombstones: [...tombstones],
    });
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
    const folderId = body.folderId === undefined ? undefined : (body.folderId ?? null);
    const moveInput = {
      relPath: typeof body.relPath === "string" ? body.relPath : undefined,
      title: body.title,
      folderId,
    };
    // Resolve the destination from the PATH first: a `relPath`-only move to
    // another folder (or out to the root) is a re-parent whether or not the
    // client also said `folderId`, and both gates below must judge the real one.
    const note = (await findNote(pool, id))!;
    let plan;
    try {
      plan = await planNoteMove(pool, note, moveInput);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }
    // Same rule the folder route has always had, applied here too: moving a note
    // INTO a folder must not be a way to hand out access to it. Folder grants
    // inherit down, so without this a member could take a note only they can read
    // and drop it into a team-shared folder, granting the whole team edit on it.
    if (
      plan.folderId != null &&
      plan.folderId !== row.folder_id &&
      !(await canEditFolder(session.userId, plan.folderId))
    ) {
      return c.json({ error: "You cannot move this note there" }, 403);
    }
    // Dragging a note out to the root is a root creation by another name —
    // unless it already lives there, which is a rename, not a move.
    if (plan.folderId === null && row.folder_id !== null && (await isRootFrozen(row.vault_id))) {
      return c.json(ROOT_FROZEN_ERROR, 403);
    }

    const color = normalizeColor(body.color);
    if (color !== undefined) {
      await pool.query("UPDATE notes SET color = $2 WHERE id = $1", [id, color]);
    }

    try {
      const moved = await moveNote(pool, id, moveInput);
      changed(c, moved.vaultId);
      return c.json(
        {
          id,
          docId: id,
          vaultId: moved.vaultId,
          relPath: moved.relPath,
          title: moved.title,
          folderId: moved.folderId,
          color,
        },
        200,
      );
    } catch (err) {
      if (err instanceof TreeOpError) return c.json({ error: err.message }, 400);
      throw err;
    }
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
    let resolvedFolder: string | null;
    try {
      resolvedFolder = await resolveParentFolder(pool, vaultId, path, folderId ?? null);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }
    // Frozen root: same rule as notes — refuse only files that do not exist
    // yet, so a device re-registering a root file that predates the latch
    // still syncs.
    if (resolvedFolder === null && (await isRootFrozen(vaultId))) {
      const { rowCount } = await pool.query("SELECT 1 FROM files WHERE id = $1", [id]);
      if (!rowCount) return c.json(ROOT_FROZEN_ERROR, 403);
    }
    await pool.query(
      "INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      [id, vaultId, resolvedFolder, path],
    );
    changed(c, vaultId);
    return c.json({ id, docId: id, vaultId, folderId: resolvedFolder, path }, 201);
  });

  return registryRoutes;
}

