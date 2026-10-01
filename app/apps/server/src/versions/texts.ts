import type pg from "pg";

/**
 * Content-addressed note text (#264, migration 038).
 *
 * Version history and vault checkpoints both used to store a full copy of the
 * note's text per row, so an unchanged note cost every daily checkpoint its
 * whole body again. Each distinct text of a note now lives ONCE in
 * `note_texts (doc_id, sha256)`; `note_versions` and `vault_checkpoint_docs`
 * rows store `content = NULL` and reference it by the `sha256` they already
 * carry. Rows written before 038 keep their inline `content`, which is why every
 * reader resolves `COALESCE(row.content, t.content)` — old checkpoints and
 * versions stay readable with no backfill.
 *
 * Cleanup is a grace-period sweep, not reference counting: a writer bumps
 * `last_ref_at` (the upsert below) BEFORE it inserts the row that points at the
 * text, and {@link gcNoteTexts} only drops rows that are both unreferenced and
 * older than {@link TEXT_GC_GRACE_MS}. A sweep can therefore never delete a text
 * a concurrent writer has just found and is about to reference.
 */

type Queryable = Pick<pg.Pool, "query">;

/** A text unreferenced for less than this is never swept. */
export const TEXT_GC_GRACE_MS = 60 * 60_000;
/** Re-bump `last_ref_at` at most this often, so an unchanged note does not
 *  rewrite its row on every checkpoint. Must stay well under the grace. */
const TOUCH_INTERVAL = "10 minutes";

/** Join a `note_versions v` row to its stored text. */
export const VERSION_TEXT_JOIN =
  "LEFT JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256";
/** The resolved text of a `note_versions v` row (inline pre-038, else shared). */
export const VERSION_CONTENT = "COALESCE(v.content, t.content)";

/**
 * Make sure `(docId, sha)` is stored, and mark it as just referenced. The
 * caller inserts its referencing row AFTER this returns.
 */
export async function storeNoteText(
  db: Queryable,
  input: { vaultId: string; docId: string; sha: string; content: string },
): Promise<void> {
  await db.query(
    `INSERT INTO note_texts (doc_id, sha256, vault_id, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, sha256) DO UPDATE SET last_ref_at = now()
       WHERE note_texts.last_ref_at < now() - interval '${TOUCH_INTERVAL}'`,
    [input.docId, input.sha, input.vaultId, input.content],
  );
}

/**
 * Drop a vault's texts that no version and no checkpoint references any more
 * and that nobody has pointed at for {@link TEXT_GC_GRACE_MS}. Both reference
 * checks are index probes (`note_versions_doc_idx`, the checkpoint-docs primary
 * key through the vault's handful of checkpoints). Returns the rows removed.
 */
export async function gcNoteTexts(db: Queryable, vaultId: string): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM note_texts t
      WHERE t.vault_id = $1
        AND t.last_ref_at < now() - ($2::bigint * interval '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM note_versions v WHERE v.doc_id = t.doc_id AND v.sha256 = t.sha256
        )
        AND NOT EXISTS (
          SELECT 1 FROM vault_checkpoint_docs d
            JOIN vault_checkpoints c ON c.id = d.checkpoint_id
           WHERE c.vault_id = t.vault_id AND d.doc_id = t.doc_id AND d.sha256 = t.sha256
        )`,
    [vaultId, TEXT_GC_GRACE_MS],
  );
  return rowCount ?? 0;
}
