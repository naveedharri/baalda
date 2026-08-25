-- A path must belong to exactly ONE live note per vault. Two live rows for one
-- rel_path is a forked identity: different devices map the same file to
-- different docs, and every external write then bounces between the two,
-- duplicating the note's content on each cycle until the update log is tens of
-- MB and rebuilding the doc OOMs the server (the 2026-08-25 runaway-daily-notes
-- incident). POST /api/notes now adopts the existing live row for a same-path
-- register; this index backstops the concurrent race.

-- De-dupe first or the index cannot build: per (vault_id, rel_path), keep the
-- oldest live row that actually holds CRDT data (else simply the oldest) and
-- soft-delete the rest. The losers' doc_updates/doc_snapshots are deliberately
-- left in place — soft-deleted rows keep their history recoverable.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY vault_id, rel_path
           ORDER BY (EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = notes.id)
                  OR EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = notes.id)) DESC,
                    created_at ASC,
                    id ASC
         ) AS rn
  FROM notes
  WHERE deleted_at IS NULL
)
UPDATE notes SET deleted_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS notes_live_path_uq
  ON notes (vault_id, rel_path)
  WHERE deleted_at IS NULL;
