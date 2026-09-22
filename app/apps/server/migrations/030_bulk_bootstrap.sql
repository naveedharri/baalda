-- Bulk sync engine (PR 2): bootstrap download sessions + the indexes the batch
-- and keyset paths depend on.
--
-- A bootstrap session MATERIALISES one joiner's ACL-resolved download set once,
-- in a stable order, so every page after it is an index-only keyset read.
-- Recomputing `listReadableDocsInVault` (several recursive CTEs) per page would
-- cost 300–500 runs for a 5,000-note vault joining once, and — worse — a set
-- that moved between pages would make "exactly once" unprovable.

CREATE TABLE bootstrap_sessions (
  id            TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  -- Not a FK to "user": the session is scoped to whoever created it and is
  -- checked against the caller on every GET, but a deleted user's rows are
  -- swept by TTL like any other, not cascaded mid-download.
  user_id       TEXT NOT NULL,
  doc_count     INTEGER NOT NULL,
  byte_estimate BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE bootstrap_session_docs (
  session_id TEXT NOT NULL REFERENCES bootstrap_sessions (id) ON DELETE CASCADE,
  -- Dense 1..N in `rel_path COLLATE "C"` order, so a folder's notes arrive
  -- together and a cursor is just "the last seq I stored".
  seq        INTEGER NOT NULL,
  doc_id     TEXT NOT NULL,
  -- Stored bytes at session creation: the progress denominator, and what lets a
  -- page be packed to a byte budget without reading a single BYTEA first.
  bytes      INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- Swept beside the blob GC tick (and opportunistically on session creation).
CREATE INDEX bootstrap_sessions_expires_idx ON bootstrap_sessions (expires_at);

-- Keyset pagination on the registry reads AND the session-creation ordering.
-- `COLLATE "C"` deliberately: a locale collation is not a stable total order
-- across libc versions, and a cursor that means something different after a base
-- image bump silently skips or repeats notes.
CREATE INDEX notes_vault_relpath_c_idx
  ON notes (vault_id, (rel_path COLLATE "C"))
  WHERE deleted_at IS NULL;

-- Yjs blobs are already compressed; TOAST's own pglz pass buys nothing and costs
-- CPU on every bootstrap page read. EXTERNAL stores them out of line, uncompressed.
-- Existing rows keep their current storage until they are rewritten, which is
-- what `compact()` does to any doc that is still being edited.
ALTER TABLE doc_snapshots ALTER COLUMN snapshot SET STORAGE EXTERNAL;
ALTER TABLE doc_updates   ALTER COLUMN update   SET STORAGE EXTERNAL;
