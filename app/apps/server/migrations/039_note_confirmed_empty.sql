-- A note whose content never reached the server and a note that is genuinely
-- empty looked identical: neither has a CRDT row (#257). The desktop now tells
-- the server when it settles a note as empty on disk AND in its local CRDT, and
-- this column records that answer, so "registered, no content, not confirmed
-- empty" really means "upload pending or abandoned" and can be counted.
--
-- Additive only. The marker is purely informational: nothing reads it to clear,
-- skip or overwrite content, and once CRDT rows exist for the note the marker is
-- simply moot (every reader checks for content first). NULL for every existing
-- row, which counts existing contentless notes as not-yet-confirmed until a
-- client that holds them settles them again on its next connect.
-- Catalog-only, but it still needs a brief ACCESS EXCLUSIVE lock on `notes`;
-- give up (and fail the deploy, which retries) rather than queue every read of
-- the hottest table behind a long-running query.
SET LOCAL lock_timeout = '10s';

ALTER TABLE notes ADD COLUMN IF NOT EXISTS confirmed_empty_at TIMESTAMPTZ;
