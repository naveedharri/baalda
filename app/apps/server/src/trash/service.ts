// SPDX-License-Identifier: Apache-2.0
//
// Per-vault note Trash: list, restore, purge (offline reconciliation, Phase 2).
//
// A soft-deleted note keeps its row, doc_id and CRDT for TRASH_RETENTION_DAYS.
// During that window pushes into it are accepted (`trash/access.ts`), any member
// with edit on it can restore it, and after it `purgeExpiredTrash` removes it.
import { randomUUID } from "node:crypto";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole, vaultOrg } from "../permissions/lookup.js";
import { listDeletedReadableDocsInVault } from "../permissions/vault-docs.js";
import { basename, dirname, findFolderByPath, joinPath } from "../registry/tree-ops.js";
import { purgeNoteIndex } from "../index/indexer.js";
import { trashedNotePermission } from "./access.js";

type Queryable = Pick<typeof defaultPool, "query">;

/** Most items one Trash listing returns; `truncated` says there were more. */
export const TRASH_LIST_MAX = 2000;

export interface TrashItem {
  docId: string;
  relPath: string;
  deletedAt: string;
  deletedBy: { id: string; name: string } | null;
  purgeAfter: string | null;
  sizeBytes: number;
  hasUnsyncedContributions: boolean;
}

export class TrashError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Deleted notes in this vault the caller could read, newest delete first.
 * Readability is `listDeletedReadableDocsInVault` — the same deleted-aware
 * readable set the registry's tombstone answer uses — so Trash never shows a
 * note the caller could not have opened. Notes past `purge_after` (awaiting the
 * purge job) are left out.
 */
export async function listTrash(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<{ items: TrashItem[]; truncated: boolean }> {
  const org = await vaultOrg(vaultId);
  if (!org) throw new TrashError(404, "unknown_vault", "Unknown vault");
  if (!(await orgRole(org, userId))) {
    throw new TrashError(403, "not_member", "Not a member of this vault");
  }
  const readable = [...(await listDeletedReadableDocsInVault(userId, vaultId, db))];
  if (readable.length === 0) return { items: [], truncated: false };

  const { rows } = await db.query<{
    id: string;
    rel_path: string;
    deleted_at: Date;
    purge_after: Date | null;
    deleted_by: string | null;
    deleted_by_name: string | null;
    size_bytes: string | number | null;
    unsynced: boolean;
  }>(
    `SELECT n.id, n.rel_path, n.deleted_at, n.purge_after, n.deleted_by,
            u.name AS deleted_by_name,
            COALESCE((SELECT octet_length(s.snapshot) FROM doc_snapshots s WHERE s.doc_id = n.id), 0)
              + COALESCE((SELECT sum(octet_length(du.update)) FROM doc_updates du WHERE du.doc_id = n.id), 0)
              AS size_bytes,
            EXISTS (SELECT 1 FROM doc_updates du
                     WHERE du.doc_id = n.id AND du.created_at > n.deleted_at) AS unsynced
       FROM notes n
       LEFT JOIN "user" u ON u.id = n.deleted_by
      WHERE n.vault_id = $1 AND n.deleted_at IS NOT NULL
        AND n.purged_at IS NULL
        AND (n.purge_after IS NULL OR n.purge_after > now())
        AND n.id = ANY($2::text[])
      ORDER BY n.deleted_at DESC, n.id ASC
      LIMIT $3`,
    [vaultId, readable, TRASH_LIST_MAX + 1],
  );
  const truncated = rows.length > TRASH_LIST_MAX;
  const items = rows.slice(0, TRASH_LIST_MAX).map((r) => ({
    docId: r.id,
    relPath: r.rel_path,
    deletedAt: r.deleted_at.toISOString(),
    deletedBy:
      r.deleted_by && r.deleted_by_name !== null ? { id: r.deleted_by, name: r.deleted_by_name } : null,
    purgeAfter: r.purge_after ? r.purge_after.toISOString() : null,
    sizeBytes: Number(r.size_bytes ?? 0),
    hasUnsyncedContributions: r.unsynced,
  }));
  return { items, truncated };
}

/** `<stem> (restored YYYY-MM-DD[ n]).<ext>` — the path a restore lands on when
 *  its old one is taken. Exported for tests. */
export function restoredPath(relPath: string, date: Date, counter: number): string {
  const dir = dirname(relPath);
  const name = basename(relPath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const day = date.toISOString().slice(0, 10);
  const suffix = counter <= 1 ? ` (restored ${day})` : ` (restored ${day} ${counter})`;
  return joinPath(dir, `${stem}${suffix}${ext}`);
}

async function pathTaken(db: Queryable, vaultId: string, relPath: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM notes WHERE vault_id = $1 AND deleted_at IS NULL AND lower(rel_path) = lower($2)
     UNION ALL
     SELECT 1 FROM files WHERE vault_id = $1 AND lower(path) = lower($2)
     LIMIT 1`,
    [vaultId, relPath],
  );
  return rows.length > 0;
}

/**
 * Make sure every folder on `dir` exists, recreating hard-deleted ones. A
 * recreated folder reuses the id its `folder_tombstones` row carried (the id
 * clients persisted) and that tombstone is removed, so clients see the folder
 * come back rather than a stranger at the same path.
 */
async function ensureFolderChain(
  db: Queryable,
  vaultId: string,
  dir: string,
  userId: string,
): Promise<string | null> {
  if (dir === "") return null;
  let parentId: string | null = null;
  let path = "";
  for (const segment of dir.split("/")) {
    path = path === "" ? segment : `${path}/${segment}`;
    const existing = await findFolderByPath(db, vaultId, path);
    if (existing) {
      parentId = existing.id;
      path = existing.path;
      continue;
    }
    const { rows: tomb } = await db.query<{ id: string }>(
      `SELECT ft.id FROM folder_tombstones ft
        WHERE ft.vault_id = $1 AND lower(ft.path) = lower($2)
          AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = ft.id)
        ORDER BY ft.deleted_at DESC LIMIT 1`,
      [vaultId, path],
    );
    const id = tomb[0]?.id ?? randomUUID();
    await db.query(
      `INSERT INTO folders (id, vault_id, parent_id, name, path, sort, created_by, color)
       VALUES ($1, $2, $3, $4, $5, 0, $6, NULL)`,
      [id, vaultId, parentId, segment, path, userId],
    );
    if (tomb[0]) await db.query("DELETE FROM folder_tombstones WHERE id = $1", [id]);
    parentId = id;
  }
  return parentId;
}

/**
 * Undelete a note. Caller needs `edit` on the tombstoned doc, or owner/admin.
 * The row keeps its doc_id and CRDT, so the restored note carries every edit
 * pushed into it while it sat in Trash.
 */
export async function restoreNote(
  userId: string,
  docId: string,
  now: Date = new Date(),
): Promise<{ docId: string; vaultId: string; relPath: string; renamed: boolean }> {
  const { rows } = await defaultPool.query<{
    vault_id: string;
    rel_path: string;
    deleted_at: Date | null;
    purged_at: Date | null;
  }>("SELECT vault_id, rel_path, deleted_at, purged_at FROM notes WHERE id = $1", [docId]);
  const note = rows[0];
  if (!note || !note.deleted_at) throw new TrashError(404, "not_in_trash", "Unknown or not deleted note");
  if (note.purged_at) throw new TrashError(410, "purged", "This note was permanently removed from Trash");
  const org = await vaultOrg(note.vault_id);
  const role = org ? await orgRole(org, userId) : null;
  const manager = role === "owner" || role === "admin";
  if (!manager && (await trashedNotePermission(userId, docId)) !== "edit") {
    throw new TrashError(403, "no_edit_permission", "You cannot restore this note");
  }

  const client = await defaultPool.connect();
  try {
    await client.query("BEGIN");
    // Serialise concurrent restores of one note, and re-check under the lock.
    const { rows: locked } = await client.query<{ deleted_at: Date | null; purged_at: Date | null }>(
      "SELECT deleted_at, purged_at FROM notes WHERE id = $1 FOR UPDATE",
      [docId],
    );
    if (!locked[0]?.deleted_at) throw new TrashError(404, "not_in_trash", "Note is not deleted");
    if (locked[0].purged_at) throw new TrashError(410, "purged", "This note was permanently removed from Trash");
    // Paths are unique per vault case-insensitively among LIVE rows; serialise
    // restores into one vault so two cannot pick the same suffix.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trash-restore:' || $1))", [note.vault_id]);

    let relPath = note.rel_path;
    let renamed = false;
    for (let n = 1; await pathTaken(client, note.vault_id, relPath); n++) {
      if (n > 1000) throw new TrashError(409, "path_taken", "No free path to restore to");
      relPath = restoredPath(note.rel_path, now, n);
      renamed = true;
    }
    const folderId = await ensureFolderChain(client, note.vault_id, dirname(relPath), userId);
    await client.query(
      `UPDATE notes
          SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL,
              rel_path = $2, folder_id = $3, updated_at = now()
        WHERE id = $1`,
      [docId, relPath, folderId],
    );
    await client.query("COMMIT");
    return { docId, vaultId: note.vault_id, relPath, renamed };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      throw new TrashError(409, "path_taken", "The restore path was taken concurrently; retry");
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Permanently remove the content of notes whose Trash window has passed: their
 * CRDT (`doc_updates`, `doc_snapshots`, `doc_state_vectors`), versions, derived
 * index/link/blob-ref rows and per-note share rows. The `notes` row is KEPT as a
 * permanent minimal tombstone with `purged_at` set: a client offline past the
 * window must still hear "deleted" (registry tombstones, `ready.tombstones`),
 * not see an absent id it would treat as a revocation. The live-path unique
 * indexes are partial on `deleted_at IS NULL`, so a kept row never blocks a
 * path. Idempotent; returns the ids purged by this call.
 */
export async function purgeExpiredTrash(
  now: Date = new Date(),
  db: Queryable = defaultPool,
): Promise<string[]> {
  // Stamp FIRST, re-checking the window in the same statement: a restore that
  // ran concurrently cleared purge_after and must win with its CRDT intact.
  const { rows } = await db.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM notes
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL
          AND purge_after IS NOT NULL AND purge_after <= $1
        ORDER BY purge_after ASC
        LIMIT 5000
     )
     UPDATE notes n SET purged_at = now()
       FROM due
      WHERE n.id = due.id AND n.deleted_at IS NOT NULL AND n.purged_at IS NULL
        AND n.purge_after IS NOT NULL AND n.purge_after <= $1
     RETURNING n.id`,
    [now],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  await purgeNoteIndex(ids, db);
  await db.query("DELETE FROM doc_updates WHERE doc_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM doc_snapshots WHERE doc_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM doc_state_vectors WHERE doc_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM note_versions WHERE doc_id = ANY($1::text[])", [ids]);
  // Per-note share rows use resource_type 'file' (a note id IS a doc id). Only
  // when no live `files` row shares the id.
  await db.query(
    `DELETE FROM shares s
      WHERE s.resource_type = 'file' AND s.resource_id = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = s.resource_id)`,
    [ids],
  );
  return ids;
}
