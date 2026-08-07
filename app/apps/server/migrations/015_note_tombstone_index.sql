-- Tombstone lookups: `GET /api/notes` now also answers "which of this vault's
-- notes are soft-deleted?" on every registry pull (i.e. on every structural
-- change any teammate or MCP client makes), so the deleted rows need their own
-- access path rather than a scan over every note in the vault.
--
-- Partial on `deleted_at IS NOT NULL`: deleted notes are the small minority of a
-- healthy vault, so the index stays tiny and costs nothing on the live-note
-- queries, which can't use it.
CREATE INDEX IF NOT EXISTS notes_tombstone_idx
  ON notes (vault_id)
  WHERE deleted_at IS NOT NULL;
