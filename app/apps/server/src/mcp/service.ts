import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";
import { effectivePermission, type Permission } from "../permissions/resolver.js";
import { listReadableDocsInVault } from "../permissions/vault-docs.js";
import { canEditFolder } from "../permissions/http-gates.js";
import {
  deleteFolderCascade,
  findFolder,
  folderIsEmpty,
  moveFolder,
  moveNote,
  TreeOpError,
} from "../registry/tree-ops.js";
import { purgeNoteIndex, searchNoteIndex } from "../index/indexer.js";
import type { McpAuth } from "./tokens.js";
import type { DocWriter } from "./doc-writer.js";

/**
 * The CRUD operations the MCP exposes, each one gated by the SAME ACL the rest
 * of the app uses (src/permissions/resolver.ts). Every function takes an
 * McpContext (who is calling + which vault) so the MCP can never reach
 * outside the token's (user, vault) scope.
 *
 * Read ops need `view`; write ops need `edit`; create/delete of folders needs
 * `edit` on the parent (owner/admin get `edit` everywhere).
 */

export interface McpContext {
  auth: McpAuth;
  docWriter: DocWriter;
  /** Force-close live sync sockets for a doc (used on delete). */
  disconnectDoc: (vaultId: string, docId: string) => void;
  /**
   * Announce a folder/note create/delete so connected apps re-pull the tree —
   * the same broadcast the HTTP registry routes fire.
   *
   * Writing the row is only half a write. Without this the note exists in
   * Postgres and nowhere else anyone can see: no `registry-changed` frame goes
   * out, every open sidebar keeps showing the old tree, and the note surfaces
   * only when a client next does a full reconcile — i.e. on restart. MCP is
   * meant to be indistinguishable from a teammate's edit, and a teammate's
   * edit announces itself.
   */
  onRegistryChanged?: (vaultId: string) => void;
}

/** A tool tried to touch something it may not, or that doesn't exist. */
export class McpToolError extends Error {}

function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

// ── scope + permission guards ───────────────────────────────────────────────

/** Confirm a vault (a `vaults` note-collection row) exists and is in scope —
 *  i.e. it belongs to the token's vault (the organization). */
async function requireVaultInScope(auth: McpAuth, vaultId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  const org = rows[0]?.organization_id;
  if (!org) throw new McpToolError(`Unknown vault: ${vaultId}`);
  if (org !== auth.organizationId) {
    throw new McpToolError("This vault is outside the scope of this token");
  }
}

async function isAdmin(auth: McpAuth): Promise<boolean> {
  const role = await orgRole(auth.organizationId, auth.userId);
  return role === "owner" || role === "admin";
}

/**
 * Highest permission the caller has to CREATE/DELETE inside a folder: admins
 * get `edit`; otherwise the max `edit` share on the folder or any ancestor.
 * A null folder is the vault root — only admins may write there.
 *
 * A lock on the folder (or any ancestor) makes it read-only for EVERYONE,
 * owners/admins included — the same deny-overlay `effectivePermission` applies
 * to note edits. It is checked before the admin short-circuit so create/delete
 * of notes and subfolders is blocked inside a locked folder, not just edits to
 * existing notes.
 */
async function folderWritePermission(
  auth: McpAuth,
  folderId: string | null,
): Promise<Permission> {
  // The vault root has no folder row to resolve against, so it can't go through
  // `canEditFolder` — and root writes stay admin-only. This is the one place the
  // two gates legitimately differ, and callers that MOVE things to the root have
  // to skip this check rather than inherit the admin-only rule (HTTP doesn't
  // apply it either).
  if (!folderId) return (await isAdmin(auth)) ? "edit" : "none";
  // Otherwise defer to the HTTP gate rather than keeping a second implementation.
  // The copy that used to live here was missing the creator rule, so a member who
  // made a folder in the app could rename and delete it over HTTP but couldn't
  // create a note in it over MCP — two doors onto the same data with different
  // locks. `canEditFolder` also checks membership, which this didn't.
  return (await canEditFolder(auth.userId, folderId)) ? "edit" : "none";
}

// ── vaults / folders ────────────────────────────────────────────────────────

export async function listVaults(ctx: McpContext) {
  const { rows } = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM vaults WHERE organization_id = $1 ORDER BY created_at ASC",
    [ctx.auth.organizationId],
  );
  return rows.map((r) => ({ vaultId: r.id, name: r.name }));
}

export async function listFolders(ctx: McpContext, vaultId: string) {
  await requireVaultInScope(ctx.auth, vaultId);
  const { rows } = await pool.query<{
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
  }>(
    "SELECT id, parent_id, name, path FROM folders WHERE vault_id = $1 ORDER BY path",
    [vaultId],
  );
  return rows.map((r) => ({
    folderId: r.id,
    parentId: r.parent_id,
    name: r.name,
    path: r.path,
  }));
}

/**
 * Refuse a root-level create when the vault's root is frozen.
 *
 * The MCP surface has to honour the same latch as the HTTP registry, and for
 * the same reason: an assistant asked to "add a note" with no folder in mind is
 * one of the likelier ways a stray root file appears.
 */
async function assertRootNotFrozen(
  vaultId: string,
  parentId: string | null,
  action: "create" | "move" = "create",
): Promise<void> {
  if (parentId) return;
  const { rows } = await pool.query<{ root_frozen: boolean }>(
    "SELECT root_frozen FROM vaults WHERE id = $1",
    [vaultId],
  );
  if (rows[0]?.root_frozen) {
    throw new McpToolError(
      `This vault's root is frozen — ${action} this inside a folder instead.`,
    );
  }
}

export async function createFolder(
  ctx: McpContext,
  input: { vaultId: string; name: string; path: string; parentId?: string | null },
) {
  await requireVaultInScope(ctx.auth, input.vaultId);
  const parentId = input.parentId ?? null;
  if ((await folderWritePermission(ctx.auth, parentId)) !== "edit") {
    throw new McpToolError("You do not have edit access to create a folder here");
  }
  // Adopt an existing row at this path instead of inserting a duplicate, exactly
  // as `POST /api/folders` does. There is no UNIQUE constraint behind
  // (vault_id, path), so without this an assistant asking for "Ideas" twice
  // creates two rows at one path and the desktop's path→id map picks one at
  // random. Idempotent is also just the right shape for a tool an LLM retries.
  const existing = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM folders WHERE vault_id = $1 AND path = $2 LIMIT 1",
    [input.vaultId, input.path],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { folderId: row.id, parentId, name: row.name, path: input.path, adopted: true };
  }
  // After the adopt path: freezing the root must not break re-registering a
  // root folder that already exists.
  await assertRootNotFrozen(input.vaultId, parentId);

  const id = randomUUID();
  await pool.query(
    // `created_by` matters beyond bookkeeping: it's what `canEditFolder` and
    // `listVisibleFolders` use to give a non-admin rights over folders they made.
    // Omitting it (as this did) meant a member who created a folder through an
    // assistant couldn't see it in their own sidebar or rename it in the app.
    `INSERT INTO folders (id, vault_id, parent_id, name, path, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [id, input.vaultId, parentId, input.name, input.path, ctx.auth.userId],
  );
  ctx.onRegistryChanged?.(input.vaultId);
  return { folderId: id, parentId, name: input.name, path: input.path, adopted: false };
}

/**
 * Delete a folder. Empty-only by default; `recursive` also deletes its contents.
 *
 * The refusal stays the default deliberately. An assistant that has been getting
 * "Folder is not empty" as a brake should not start removing subtrees on the same
 * tool call it always used — destruction has to be asked for, and asking for it
 * leaves `recursive: true` visible in the tool log.
 */
export async function deleteFolder(
  ctx: McpContext,
  folderId: string,
  opts: { recursive?: boolean } = {},
) {
  const { rows } = await pool.query<{ vault_id: string }>(
    "SELECT vault_id FROM folders WHERE id = $1",
    [folderId],
  );
  const vaultId = rows[0]?.vault_id;
  if (!vaultId) throw new McpToolError(`Unknown folder: ${folderId}`);
  await requireVaultInScope(ctx.auth, vaultId);
  if ((await folderWritePermission(ctx.auth, folderId)) !== "edit") {
    throw new McpToolError("You do not have edit access to delete this folder");
  }
  if (!opts.recursive) {
    const { rows: files } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM files WHERE folder_id = $1",
      [folderId],
    );
    if (!(await folderIsEmpty(pool, folderId)) || (files[0]?.n ?? 0) > 0) {
      throw new McpToolError(
        "Folder is not empty — move its contents first, or pass recursive: true to delete them with it",
      );
    }
  }
  const { deletedNoteIds } = await deleteFolderCascade(pool, folderId);
  // Same trailing work as `delete_note`: drop derived index rows and kick anyone
  // whose editor is still attached to a doc that no longer exists.
  await purgeNoteIndex(deletedNoteIds);
  for (const docId of deletedNoteIds) ctx.disconnectDoc(vaultId, docId);
  ctx.onRegistryChanged?.(vaultId);
  return { deleted: folderId, deletedNotes: deletedNoteIds.length };
}

/**
 * Rename and/or move a folder, taking its whole subtree with it. Every descendant
 * path is rewritten and every id preserved, so backlinks and edit history survive.
 */
export async function moveFolderTool(
  ctx: McpContext,
  input: { folderId: string; path?: string; name?: string; parentId?: string | null },
) {
  const folder = await findFolder(pool, input.folderId);
  if (!folder) throw new McpToolError(`Unknown folder: ${input.folderId}`);
  await requireVaultInScope(ctx.auth, folder.vault_id);
  if ((await folderWritePermission(ctx.auth, input.folderId)) !== "edit") {
    throw new McpToolError("You do not have edit access to move this folder");
  }
  // Re-parenting must not be a way to change inherited access, so edit on the
  // destination is required too — but only for a real folder. `parentId: null`
  // means the vault root, which `folderWritePermission` treats as admin-only;
  // applying that here would make moving to the root admin-only over MCP while
  // HTTP allows it for the same user (it short-circuits on null the same way).
  if (input.parentId != null && (await folderWritePermission(ctx.auth, input.parentId)) !== "edit") {
    throw new McpToolError("You do not have edit access to the destination folder");
  }
  // Moving a folder OUT to the root is a root creation by another name — the
  // same latch the HTTP registry honours (a rename in place at root is fine).
  if (input.parentId === null && folder.parent_id !== null) {
    await assertRootNotFrozen(folder.vault_id, null, "move");
  }
  try {
    const moved = await moveFolder(pool, input.folderId, {
      path: input.path,
      name: input.name,
      parentId: input.parentId,
    });
    ctx.onRegistryChanged?.(moved.vaultId);
    return { folderId: moved.id, name: moved.name, path: moved.path };
  } catch (err) {
    if (err instanceof TreeOpError) throw new McpToolError(err.message);
    throw err;
  }
}

/** Rename, retitle, and/or move a single note. Its docId never changes. */
export async function moveNoteTool(
  ctx: McpContext,
  input: { docId: string; relPath?: string; title?: string; folderId?: string | null },
) {
  const note = await requireEditableNote(ctx.auth, input.docId);
  // Moving a note INTO a folder inherits that folder's grants, so it needs edit
  // on the destination as well as on the note. Same null-is-the-root carve-out as
  // `moveFolderTool`.
  if (
    input.folderId != null &&
    input.folderId !== note.folder_id &&
    (await folderWritePermission(ctx.auth, input.folderId)) !== "edit"
  ) {
    throw new McpToolError("You do not have edit access to the destination folder");
  }
  // Same root-freeze latch as HTTP's PATCH /api/notes/:id: dragging a note out
  // to a frozen root is refused; a rename in place at root is allowed.
  if (input.folderId === null && note.folder_id !== null) {
    await assertRootNotFrozen(note.vault_id, null, "move");
  }
  try {
    const moved = await moveNote(pool, input.docId, {
      relPath: input.relPath,
      title: input.title,
      folderId: input.folderId,
    });
    ctx.onRegistryChanged?.(moved.vaultId);
    return {
      docId: moved.id,
      relPath: moved.relPath,
      title: moved.title,
      folderId: moved.folderId,
    };
  } catch (err) {
    if (err instanceof TreeOpError) throw new McpToolError(err.message);
    throw err;
  }
}

// ── notes (markdown docs) ─────────────────────────────────────────────────────

export async function listNotes(
  ctx: McpContext,
  vaultId: string,
  folderId?: string | null,
) {
  await requireVaultInScope(ctx.auth, vaultId);
  const params: unknown[] = [vaultId];
  let where = "vault_id = $1 AND deleted_at IS NULL";
  if (folderId !== undefined && folderId !== null) {
    params.push(folderId);
    where += ` AND folder_id = $${params.length}`;
  }
  const { rows } = await pool.query<{
    id: string;
    folder_id: string | null;
    title: string | null;
    rel_path: string;
    updated_at: string;
  }>(
    `SELECT id, folder_id, title, rel_path, updated_at
       FROM notes WHERE ${where} ORDER BY rel_path`,
    params,
  );

  // effectivePermission honours role AND locks, and never returns 'none' for an
  // admin — so this both filters (members see only what's shared) and reports an
  // accurate permission (a locked note shows 'view' even for an owner/admin).
  const out: Array<{
    docId: string;
    folderId: string | null;
    title: string;
    relPath: string;
    permission: Permission;
    updatedAt: string;
  }> = [];
  for (const r of rows) {
    const permission = await effectivePermission(ctx.auth.userId, r.id);
    if (permission === "none") continue; // members only see what's shared with them
    out.push({
      docId: r.id,
      folderId: r.folder_id,
      title: r.title ?? relPathStem(r.rel_path),
      relPath: r.rel_path,
      permission,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

/** Locate a live note + confirm it's in scope. Throws McpToolError otherwise. */
async function locateNote(auth: McpAuth, docId: string) {
  const { rows } = await pool.query<{
    vault_id: string;
    folder_id: string | null;
    title: string | null;
    rel_path: string;
    organization_id: string;
  }>(
    `SELECT n.vault_id, n.folder_id, n.title, n.rel_path, v.organization_id
       FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE n.id = $1 AND n.deleted_at IS NULL`,
    [docId],
  );
  const note = rows[0];
  if (!note) throw new McpToolError(`Unknown note: ${docId}`);
  if (note.organization_id !== auth.organizationId) {
    throw new McpToolError("This note is outside the scope of this token");
  }
  return note;
}

export async function readNote(ctx: McpContext, docId: string) {
  const note = await locateNote(ctx.auth, docId);
  const perm = await effectivePermission(ctx.auth.userId, docId);
  if (perm === "none") throw new McpToolError("You do not have access to this note");
  const content = await ctx.docWriter.readContent(note.vault_id, docId);
  return {
    docId,
    vaultId: note.vault_id,
    folderId: note.folder_id,
    title: note.title ?? relPathStem(note.rel_path),
    relPath: note.rel_path,
    permission: perm,
    content,
  };
}

export async function createNote(
  ctx: McpContext,
  input: {
    vaultId: string;
    relPath: string;
    title?: string | null;
    folderId?: string | null;
    content?: string;
  },
) {
  await requireVaultInScope(ctx.auth, input.vaultId);
  const folderId = input.folderId ?? null;
  if ((await folderWritePermission(ctx.auth, folderId)) !== "edit") {
    throw new McpToolError("You do not have edit access to create a note here");
  }
  // Adopt the live note already at this path instead of inserting a second row,
  // exactly as `createFolder` does. A vault-relative path addresses ONE note —
  // nothing in the schema enforces that, and the desktop's path→docId map just
  // picks one of a duplicate pair, so the loser becomes a row no client can see
  // or delete. An LLM retrying a tool call must not be able to create that.
  const existing = await pool.query<{ id: string; title: string | null; folder_id: string | null }>(
    `SELECT id, title, folder_id FROM notes
      WHERE vault_id = $1 AND rel_path = $2 AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [input.vaultId, input.relPath],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    // Seed content only into an EMPTY note. "Create" must never become a way to
    // overwrite a note that already says something — that's `update_note`, which
    // the caller can reach for once `adopted` has told it what happened.
    let seeded = false;
    if (input.content) {
      const current = await ctx.docWriter.readContent(input.vaultId, row.id);
      if (current.trim().length === 0) {
        await ctx.docWriter.setContent(input.vaultId, row.id, input.content, {
          userId: ctx.auth.userId,
        });
        seeded = true;
      }
    }
    return {
      docId: row.id,
      vaultId: input.vaultId,
      folderId: row.folder_id,
      title: row.title ?? relPathStem(input.relPath),
      relPath: input.relPath,
      adopted: true,
      seeded,
    };
  }
  // After the adopt path, for the same reason as `createFolder`.
  await assertRootNotFrozen(input.vaultId, folderId);

  const docId = randomUUID();
  await pool.query(
    `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6)`,
    [docId, input.vaultId, folderId, input.title ?? null, input.relPath, ctx.auth.userId],
  );
  if (input.content) {
    await ctx.docWriter.setContent(input.vaultId, docId, input.content, {
      userId: ctx.auth.userId,
    });
  }
  // After the content, so a client that reacts to the announcement by pulling
  // the note finds it already written rather than briefly empty.
  ctx.onRegistryChanged?.(input.vaultId);
  return {
    docId,
    vaultId: input.vaultId,
    folderId,
    title: input.title ?? relPathStem(input.relPath),
    relPath: input.relPath,
    adopted: false,
    seeded: Boolean(input.content),
  };
}

async function requireEditableNote(auth: McpAuth, docId: string) {
  const note = await locateNote(auth, docId);
  const perm = await effectivePermission(auth.userId, docId);
  if (perm !== "edit") {
    throw new McpToolError(
      perm === "view"
        ? "This note is read-only for you (view access or locked)"
        : "You do not have access to this note",
    );
  }
  return note;
}

/**
 * Content-only, so deliberately **no** `onRegistryChanged` here or in
 * `appendNote` — do not "fix" this by adding one.
 *
 * A registry broadcast makes every subscriber recompute its readable-doc set and
 * re-pull the whole folder+note listing. Nothing structural changed, so that work
 * buys nothing, and an assistant writing 20 notes in a session would trigger 20
 * full reconciles on every connected app.
 *
 * The `updated_at` bump below is the one thing that then goes unannounced: a
 * client's mirror of the modified time stays stale until its next full reconcile.
 * The content itself does fan out (the doc-writer publishes it), so what a user
 * sees is correct. If a live modified time is ever wanted, the instrument is a
 * doc-scoped frame (`{t:"touched", docId, updatedAt}`) the client applies to one
 * row — not a whole-tree re-pull.
 */
export async function updateNote(ctx: McpContext, docId: string, content: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  // The actor rides along so the edit is attributed to the MCP token's user —
  // an AI write shows up as "edited by <that user>" like any teammate's.
  await ctx.docWriter.setContent(note.vault_id, docId, content, { userId: ctx.auth.userId });
  await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [docId]);
  return { docId, bytes: content.length };
}

export async function appendNote(ctx: McpContext, docId: string, text: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  await ctx.docWriter.appendContent(note.vault_id, docId, text, { userId: ctx.auth.userId });
  await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [docId]);
  return { docId, appended: text.length };
}

/** Soft-delete a note (matches the app: sets deleted_at, keeps CRDT history). */
export async function deleteNote(ctx: McpContext, docId: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [docId]);
  // Drop derived index rows and kick any live editors off the now-gone doc.
  await purgeNoteIndex([docId]);
  ctx.disconnectDoc(note.vault_id, docId);
  // `disconnectDoc` only kicks editors off the doc itself; without this the
  // note stays listed in every open sidebar.
  ctx.onRegistryChanged?.(note.vault_id);
  return { deleted: docId };
}

// ── search ────────────────────────────────────────────────────────────────

export async function searchNotes(
  ctx: McpContext,
  vaultId: string,
  query: string,
  k = 10,
) {
  await requireVaultInScope(ctx.auth, vaultId);
  const limit = Number.isFinite(k) && k > 0 ? Math.min(Math.trunc(k), 50) : 10;

  // Two changes, neither of which alters the result shape or the ranking:
  //
  //  - the candidate set comes from `listReadableDocsInVault` (ONE query) rather
  //    than an O(N) sequential `effectivePermission` loop. That function is the
  //    documented readable-set dual of the resolver — same owner/admin, creator,
  //    folder/file/vault-grant and membership rules; `locked` only caps edit
  //    down to view, so it can't change which notes are readable. It also
  //    subsumes the old `isAdmin` short-circuit.
  //  - scoring runs in index/indexer.ts, which walks note_index in keyset
  //    batches and never pulls note bodies onto the heap. The old version
  //    selected `ni.content` + `ni.vector` for every row in the vault with no
  //    LIMIT and then pinned that whole array across the permission loop.
  const readable = await listReadableDocsInVault(ctx.auth.userId, vaultId);
  return searchNoteIndex({ vaultId, query, k: limit, readableDocIds: readable });
}
