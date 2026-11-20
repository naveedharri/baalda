// SPDX-License-Identifier: Apache-2.0
/**
 * Attachments a deleted note leaves behind.
 *
 * An `attachments/` drop has no identity of its own: it is bytes a note embeds.
 * When the last note embedding it is deleted, nothing on any device shows it,
 * but its `blobs` row lived on. A member who reads the whole vault was sent it,
 * one who reads less was not, so every access change made old images appear
 * and disappear on their disk. Deleted means deleted: the purge of a note
 * removes the drops it embedded that no live note still references.
 *
 * "No live note references it" is only as good as `blob_refs`. Version 2 of the
 * extractor reads wiki embeds, and a note indexed before it may have recorded
 * nothing. So nothing is removed in a vault until its references are current:
 * an unkeyed vault rebuilds them from `note_index.content` on the spot; a keyed
 * one queues every note for a re-index (`index_pending`), drained while a
 * member's key is held. Until then the purge only queues the paths
 * (`attachment_cleanup`) and the hourly sweep asks again.
 *
 * Checkpoints keep the bytes (`vault_checkpoint_blobs` + the blobs delete
 * trigger), so a whole-vault revert still brings these back.
 */
import { pool as defaultPool } from "../db/pool.js";
import { rebuildBlobRefs } from "./refs.js";

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

/** The extractor version whose references a cleanup may trust. */
export const BLOB_REFS_VERSION = 2;

let notifier: ((vaultId: string) => void) | null = null;
/** Who tells the vault's devices to list attachments again (`registry-changed`). */
export function setAttachmentCleanupNotifier(fn: ((vaultId: string) => void) | null): void {
  notifier = fn;
}

/** Record the drops these notes embed, BEFORE their references are purged. */
export async function queueAttachmentCleanup(
  docIds: readonly string[],
  db: Queryable = defaultPool,
): Promise<void> {
  if (docIds.length === 0) return;
  await db.query(
    `INSERT INTO attachment_cleanup (vault_id, rel_path)
     SELECT DISTINCT vault_id, rel_path FROM blob_refs WHERE doc_id = ANY($1::text[])
     ON CONFLICT (vault_id, rel_path) DO NOTHING`,
    [[...docIds]],
  );
}

/**
 * Are this vault's references complete enough to delete on? Brings an old
 * vault up to {@link BLOB_REFS_VERSION} as a side effect (rebuild or queue).
 */
export async function refsAreCurrent(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rows } = await db.query<{ version: number; keyed: boolean }>(
    "SELECT blob_refs_version AS version, vk_check IS NOT NULL AS keyed FROM vaults WHERE id = $1",
    [vaultId],
  );
  const vault = rows[0];
  if (!vault) return false;
  if (vault.version < BLOB_REFS_VERSION) {
    if (vault.keyed) {
      await db.query(
        `INSERT INTO index_pending (doc_id, vault_id)
         SELECT id, vault_id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
         ON CONFLICT (doc_id) DO NOTHING`,
        [vaultId],
      );
    } else {
      await rebuildBlobRefs(vaultId, db as never);
    }
    await db.query("UPDATE vaults SET blob_refs_version = $2 WHERE id = $1", [vaultId, BLOB_REFS_VERSION]);
  }
  // Every live note's references must reflect its latest text. A note still
  // queued, one with CRDT content and no index row, or one edited since it was
  // last indexed (an embed cut from the deleted note and pasted here, say) may
  // reference anything, so the vault waits for its next sweep.
  const { rows: gaps } = await db.query<{ gap: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM index_pending WHERE vault_id = $1)
          OR EXISTS (
               SELECT 1 FROM notes n
                WHERE n.vault_id = $1 AND n.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM note_index ni WHERE ni.doc_id = n.id)
                  AND (EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = n.id)
                    OR EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = n.id))
             )
          OR EXISTS (
               SELECT 1 FROM notes n
                 JOIN note_index ni ON ni.doc_id = n.id
                WHERE n.vault_id = $1 AND n.deleted_at IS NULL
                  -- Recent only: indexing follows an edit within seconds, and
                  -- a row some background step appended without a re-index
                  -- (a converting compaction's merged row) must not hold the
                  -- vault's cleanup back forever.
                  AND EXISTS (SELECT 1 FROM doc_updates u
                               WHERE u.doc_id = n.id AND u.created_at > ni.updated_at
                                 AND u.created_at > now() - interval '10 minutes')
             ) AS gap`,
    [vaultId],
  );
  return !gaps[0]?.gap;
}

/**
 * Remove the queued drops nobody references any more, in every vault whose
 * references are current (or just `vaultIds`). Returns how many blobs went.
 */
export async function processAttachmentCleanup(
  vaultIds?: readonly string[],
  db: Queryable = defaultPool,
): Promise<number> {
  const { rows: vaults } = await db.query<{ vault_id: string }>(
    `SELECT DISTINCT vault_id FROM attachment_cleanup
      WHERE ($1::text[] IS NULL OR vault_id = ANY($1::text[]))`,
    [vaultIds ? [...vaultIds] : null],
  );
  let total = 0;
  for (const { vault_id: vaultId } of vaults) {
    if (!(await refsAreCurrent(vaultId, db))) continue;
    const { rows: gone } = await db.query<{ id: string }>(
      `WITH queued AS (
         DELETE FROM attachment_cleanup WHERE vault_id = $1 RETURNING rel_path
       )
       DELETE FROM blobs b
        USING queued q
        WHERE b.vault_id = $1 AND b.doc_id IS NULL
          AND lower(b.rel_path) = q.rel_path
          AND lower(b.rel_path) LIKE 'attachments/%'
          AND NOT EXISTS (
                SELECT 1 FROM blob_refs r JOIN notes n ON n.id = r.doc_id AND n.deleted_at IS NULL
                 WHERE r.vault_id = $1 AND r.rel_path = q.rel_path)
       RETURNING b.id`,
      [vaultId],
    );
    if (gone.length > 0) {
      total += gone.length;
      console.log(`[attachments] removed ${gone.length} attachment(s) only deleted notes used, vault=${vaultId}`);
      try {
        notifier?.(vaultId);
      } catch (err) {
        console.warn("[attachments] cleanup broadcast failed:", err);
      }
    }
  }
  return total;
}
