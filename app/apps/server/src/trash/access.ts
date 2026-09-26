// SPDX-License-Identifier: Apache-2.0
import { pool as defaultPool } from "../db/pool.js";
import {
  effectivePermission,
  type Permission,
  type ResolverCache,
} from "../permissions/resolver.js";

type Queryable = Pick<typeof defaultPool, "query">;

/**
 * Is this note in Trash and still inside its retention window? Such a doc keeps
 * accepting CRDT pushes (a teammate who edited it offline gets their work onto
 * the server) and can be restored. Past `purge_after` it is treated as gone.
 */
export async function isInTrashWindow(docId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM notes
      WHERE id = $1 AND deleted_at IS NOT NULL
        AND purge_after IS NOT NULL AND purge_after > now()`,
    [docId],
  );
  return rows.length > 0;
}

/**
 * The permission a caller holds on a doc for SYNC purposes: the live resolver
 * first, then — only if that says `none` and the doc is a note in its trash
 * window — the same resolver evaluated on the tombstoned row. The note stays
 * deleted; this only lets pushes land in its CRDT.
 *
 * Caveat: a note whose folder was hard-deleted by a folder delete lost the
 * folder rows its share walked, so a folder-scoped share no longer reaches it.
 * Owner/admin, authorship, per-note shares and vault-wide grants still do.
 */
export async function syncPermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<Permission> {
  const live = await effectivePermission(userId, docId, db, cache);
  if (live !== "none") return live;
  if (!(await isInTrashWindow(docId, db))) return "none";
  return effectivePermission(userId, docId, db, cache, { includeDeleted: true });
}

/** Permission on a soft-deleted note regardless of the window (Trash reads). */
export async function trashedNotePermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<Permission> {
  return effectivePermission(userId, docId, db, cache, { includeDeleted: true });
}

/**
 * Which of `docIds` are soft-deleted notes in this vault. Feeds the vault
 * channel's `ready.tombstones`; the ids are the client's own (its hello), so
 * naming them leaks nothing. One indexed query over a bounded list.
 */
export async function deletedNotesAmong(
  vaultId: string,
  docIds: string[],
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NOT NULL AND id = ANY($2::text[])",
    [vaultId, docIds],
  );
  return new Set(rows.map((r) => r.id));
}
