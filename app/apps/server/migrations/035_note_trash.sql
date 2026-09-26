-- SPDX-License-Identifier: Apache-2.0
--
-- Per-vault note trash (offline reconciliation, Phase 2).
--
-- A soft-deleted note now records WHO deleted it and WHEN it is purged. Until
-- `purge_after` passes, the note's CRDT keeps accepting pushes (a teammate who
-- edited it offline still gets their edits onto the server) and any member with
-- edit on it can restore it. After that `src/trash/purge.ts` drops its CRDT,
-- versions and index rows and stamps `purged_at`, keeping the row as a tombstone.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ NULL;
-- Set when the purge job has dropped the note's CRDT/versions/index rows. The
-- row itself is KEPT as a permanent minimal tombstone (deleted_at stays set), so
-- a client offline past the window still learns "deleted", never an absent id
-- (which would look like a revocation the access-check cannot answer).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS notes_purge_after_idx
  ON notes (purge_after) WHERE purge_after IS NOT NULL;

-- Notes deleted before this shipped get the full retention window counted from
-- the ship date, not from their old `deleted_at`, so nobody loses a note the day
-- this deploys. 30 days mirrors TRASH_RETENTION_DAYS' default.
UPDATE notes SET purge_after = now() + interval '30 days'
 WHERE deleted_at IS NOT NULL AND purge_after IS NULL;
