import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";
import {
  ancestorFolderIds,
  effectivePermission,
  isLocked,
  type Permission,
} from "../permissions/resolver.js";
import { cosineSimilarity, embed, tokenize } from "../index/embedder.js";
import type { McpAuth } from "./tokens.js";
import type { DocWriter } from "./doc-writer.js";

/**
 * The CRUD operations the MCP exposes, each one gated by the SAME ACL the rest
 * of the app uses (src/permissions/resolver.ts). Every function takes an
 * McpContext (who is calling + which workspace) so the MCP can never reach
 * outside the token's (user, workspace) scope.
 *
 * Read ops need `view`; write ops need `edit`; create/delete of folders needs
 * `edit` on the parent (owner/admin get `edit` everywhere).
 */

export interface McpContext {
  auth: McpAuth;
  docWriter: DocWriter;
  /** Force-close live sync sockets for a doc (used on delete). */
  disconnectDoc: (vaultId: string, docId: string) => void;
}

/** A tool tried to touch something it may not, or that doesn't exist. */
export class McpToolError extends Error {}

function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

// ── scope + permission guards ───────────────────────────────────────────────

/** Confirm a vault exists and belongs to the token's workspace. */
async function requireVaultInScope(auth: McpAuth, vaultId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  const org = rows[0]?.organization_id;
  if (!org) throw new McpToolError(`Unknown vault: ${vaultId}`);
  if (org !== auth.organizationId) {
    throw new McpToolError("Vault is not in this token's workspace");
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
  if (folderId) {
    const chain = await ancestorFolderIds(pool, folderId);
    if (await isLocked(pool, auth.userId, null, chain)) return "none";
  }
  if (await isAdmin(auth)) return "edit";
  if (!folderId) return "none";
  const { rows } = await pool.query<{ permission: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id FROM folders f JOIN chain c ON f.id = c.parent_id
     )
     SELECT s.permission FROM shares s
      WHERE s.principal_type = 'user' AND s.principal_id = $2
        AND s.resource_type = 'folder' AND s.resource_id IN (SELECT id FROM chain)`,
    [folderId, auth.userId],
  );
  return rows.some((r) => r.permission === "edit") ? "edit" : "none";
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

export async function createFolder(
  ctx: McpContext,
  input: { vaultId: string; name: string; path: string; parentId?: string | null },
) {
  await requireVaultInScope(ctx.auth, input.vaultId);
  const parentId = input.parentId ?? null;
  if ((await folderWritePermission(ctx.auth, parentId)) !== "edit") {
    throw new McpToolError("You do not have edit access to create a folder here");
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO folders (id, vault_id, parent_id, name, path, sort)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [id, input.vaultId, parentId, input.name, input.path],
  );
  return { folderId: id, parentId, name: input.name, path: input.path };
}

/** Delete an EMPTY folder (no child folders/notes/files) — avoids orphaning content. */
export async function deleteFolder(ctx: McpContext, folderId: string) {
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
  const { rows: kids } = await pool.query<{ n: number }>(
    `SELECT (
        (SELECT count(*) FROM folders WHERE parent_id = $1)
      + (SELECT count(*) FROM notes WHERE folder_id = $1 AND deleted_at IS NULL)
      + (SELECT count(*) FROM files WHERE folder_id = $1)
     )::int AS n`,
    [folderId],
  );
  if ((kids[0]?.n ?? 0) > 0) {
    throw new McpToolError("Folder is not empty — delete or move its contents first");
  }
  await pool.query("DELETE FROM folders WHERE id = $1", [folderId]);
  return { deleted: folderId };
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
    throw new McpToolError("Note is not in this token's workspace");
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
  const docId = randomUUID();
  await pool.query(
    `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6)`,
    [docId, input.vaultId, folderId, input.title ?? null, input.relPath, ctx.auth.userId],
  );
  if (input.content) {
    await ctx.docWriter.setContent(input.vaultId, docId, input.content);
  }
  return {
    docId,
    vaultId: input.vaultId,
    folderId,
    title: input.title ?? relPathStem(input.relPath),
    relPath: input.relPath,
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

export async function updateNote(ctx: McpContext, docId: string, content: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  await ctx.docWriter.setContent(note.vault_id, docId, content);
  await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [docId]);
  return { docId, bytes: content.length };
}

export async function appendNote(ctx: McpContext, docId: string, text: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  await ctx.docWriter.appendContent(note.vault_id, docId, text);
  await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [docId]);
  return { docId, appended: text.length };
}

/** Soft-delete a note (matches the app: sets deleted_at, keeps CRDT history). */
export async function deleteNote(ctx: McpContext, docId: string) {
  const note = await requireEditableNote(ctx.auth, docId);
  await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [docId]);
  // Drop derived index rows and kick any live editors off the now-gone doc.
  await pool.query("DELETE FROM note_index WHERE doc_id = $1", [docId]);
  await pool.query("DELETE FROM note_links WHERE from_doc = $1", [docId]);
  ctx.disconnectDoc(note.vault_id, docId);
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

  const { rows } = await pool.query<{
    doc_id: string;
    title: string | null;
    rel_path: string;
    content: string;
    vector: number[] | null;
  }>(
    `SELECT ni.doc_id, ni.title, n.rel_path, ni.content, ni.vector
       FROM note_index ni
       JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
      WHERE ni.vault_id = $1`,
    [vaultId],
  );

  const qVec = embed(query);
  const qTokens = Array.from(new Set(tokenize(query)));
  const admin = await isAdmin(ctx.auth);

  const scored: Array<{ docId: string; title: string; relPath: string; score: number }> =
    [];
  for (const r of rows) {
    const perm = admin ? "edit" : await effectivePermission(ctx.auth.userId, r.doc_id);
    if (perm === "none") continue;
    const sim = r.vector ? cosineSimilarity(qVec, r.vector) : 0;
    const haystack = `${r.title ?? ""} ${r.content}`.toLowerCase();
    const matched = qTokens.filter((t) => haystack.includes(t)).length;
    const boost = qTokens.length > 0 ? 0.1 * (matched / qTokens.length) : 0;
    scored.push({
      docId: r.doc_id,
      title: r.title ?? relPathStem(r.rel_path),
      relPath: r.rel_path,
      score: sim + boost,
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
