-- Attachment lifecycle: which notes reference an attachment, and what still
-- has to be removed from an object store after its row is gone.
--
-- Two tables, for the two questions nothing could answer before:
--
--   1. "Is this attachment still used?" — `blob_refs`. Until now the only way
--      to ask was `note_index.content LIKE '%path%'`, one LIKE per (path,
--      readable note), which is fine as a per-request authorization heuristic
--      and useless as the basis for DELETING anything.
--   2. "Whose bytes still need deleting?" — `blob_deletions`, filled by a
--      trigger. See the trigger's own comment for why it is a trigger.

-- ── Which notes reference which attachment paths ───────────────────────────
--
-- Derived, exactly like `note_index` / `note_links`: written by
-- `src/index/indexer.ts` from the note's own markdown and rebuildable from it
-- at any time (`src/blobs/refs.ts rebuildBlobRefs`). Losing it costs nothing a
-- re-index cannot recompute — which is also why the GC that depends on it
-- refuses to run against a vault whose refs have never been built.
--
-- `rel_path` is stored ALREADY LOWERCASED. Paths compare case-insensitively
-- everywhere in this system (the server's `lower(path)` unique indexes, the
-- desktop's `samePath`), and a macOS vault routinely writes `Attachments/A.png`
-- into a note that the blob row calls `attachments/a.png`. Normalising on the
-- way in makes the primary key itself case-insensitive and keeps every lookup
-- an index probe instead of a `lower()` scan.
--
-- No FK on `doc_id`: a reference may belong to a `notes` row or (from PR3) a
-- `files` row, and notes are SOFT-deleted, so the delete that must purge these
-- rows is the hard one the indexer already performs (`purgeNoteIndex`).
CREATE TABLE IF NOT EXISTS blob_refs (
  vault_id TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  doc_id   TEXT NOT NULL,
  PRIMARY KEY (vault_id, rel_path, doc_id)
);

-- Purging one note's references, and answering "which notes reference this
-- blob" for the DELETE endpoint's 409.
CREATE INDEX IF NOT EXISTS blob_refs_doc_idx ON blob_refs (doc_id);

-- ── Objects whose row is gone but whose bytes are not ──────────────────────
--
-- A `blobs` row is deleted from four places that have no idea an object store
-- exists: `DELETE FROM blobs WHERE org_id = $1` in the org-delete transaction
-- (`http/routes/orgs.ts`), the `ON DELETE CASCADE` from `vaults` (migration
-- 003) that a vault delete fires, the new `DELETE /api/blobs/:id`, and the GC
-- sweeps themselves. On the Postgres provider that is the whole job — the bytes
-- ARE the row. On S3 it leaves an object nobody will ever ask for again, billed
-- forever.
--
-- Teaching all four paths about storage would mean four places to forget, and
-- two of them are cascades that no application code runs at all. A trigger is
-- the one place that cannot be bypassed: it fires inside the same transaction,
-- so a rollback un-queues the deletion exactly as it un-deletes the row. This
-- is the only trigger in the schema, and that is why it earns its keep.
--
-- The queue is drained by `src/blobs/gc.ts`, which is where the retry policy
-- lives; the table only has to remember what to try and how it went.
CREATE TABLE IF NOT EXISTS blob_deletions (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INT NOT NULL DEFAULT 0,
  -- When the drain last TRIED this row. Both halves of the retry policy need
  -- it: the exponential backoff is measured from here, and bumping it as the
  -- batch is claimed doubles as a lease, so a second instance's tick skips rows
  -- another one is currently deleting objects for.
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT
);

CREATE OR REPLACE FUNCTION enqueue_blob_deletion() RETURNS trigger AS $$
BEGIN
  -- Only a provider with an object namespace leaves anything behind. A
  -- `postgres` row's bytes are the row's own `data` column and are already
  -- gone; queuing it would be a permanent no-op the drain has to fail on.
  IF OLD.storage_provider <> 'postgres' AND OLD.storage_key IS NOT NULL THEN
    INSERT INTO blob_deletions (provider, storage_key)
    VALUES (OLD.storage_provider, OLD.storage_key);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blobs_enqueue_deletion ON blobs;
CREATE TRIGGER blobs_enqueue_deletion
  AFTER DELETE ON blobs
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_blob_deletion();
