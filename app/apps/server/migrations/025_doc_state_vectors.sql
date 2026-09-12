-- Per-doc state vector, so "is this client already up to date?" can be answered
-- without reading or merging the doc's update log.
--
-- The vault channel asks that question for EVERY readable doc on EVERY connect.
-- Before this table the only fast answer lived on `doc_snapshots.state_vector`,
-- which exists solely for docs that have passed `COMPACTION_THRESHOLD` (50)
-- lifetime updates — so an ordinary note, edited a handful of times, had no
-- snapshot row at all and took the slow path every single time: an EXISTS probe,
-- a snapshot read, the whole `doc_updates` log, and a full `Y.mergeUpdates` over
-- its history, usually only to conclude the client was already current. On a
-- few-hundred-note vault that is thousands of queries and hundreds of
-- single-threaded CRDT merges standing between the client and its `ready` frame.
--
-- `upto_update_id` is what makes the cached vector trustworthy: it records the
-- `doc_updates.id` high-water mark the vector accounts for (NULL when the log is
-- empty). A reader compares it against the doc's current max id, and only trusts
-- the vector when they agree — so a racing append can never be mistaken for
-- "nothing changed", which would silently withhold ops from a client.
--
-- Populated going forward by `appendUpdate`/`compact`, and lazily by the read
-- path for docs that predate this migration, so no backfill job is needed.
CREATE TABLE IF NOT EXISTS doc_state_vectors (
  doc_id         TEXT PRIMARY KEY,
  state_vector   BYTEA NOT NULL,
  upto_update_id BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
