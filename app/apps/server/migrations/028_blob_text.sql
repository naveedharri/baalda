-- Extracted text for attachments, and the doc identity that gives a file its
-- own ACL.
--
-- Two halves of one change: files stop being anonymous bytes hanging off a
-- note's markdown and become docs like any other.
--
--   1. `blobs.doc_id` finally means something. It has been a dead column since
--      migration 002; from here it holds the `files` row id (== doc_id) of the
--      tree file whose bytes this blob is. That is what lets
--      `permissions/http-gates.ts canReadAttachment` ask `effectivePermission`
--      instead of guessing from `note_index.content LIKE '%path%'` — and with
--      it a folder share, an org grant, a sealed vault and a `locked` cap all
--      apply to a `.xlsx` exactly as they do to a `.md`, for free. Blobs with
--      no `doc_id` (the hash-named `attachments/` drops an editor makes, and
--      every row that predates this) keep the LIKE heuristic; the column is
--      nullable because both kinds are legitimate and always will be.
--
--   2. `blob_text` is what a file's words are indexed from. The desktop
--      extracts them (Rust owns disk I/O and the parsers; with a presigned
--      direct upload the server never sees the bytes at all) and PUTs them to
--      `/api/vaults/:vaultId/blobs/:blobId/text`.
--
-- On the invariant: "the server stores binary Y.Doc only" is about NOTES, whose
-- live source of truth is a CRDT. A file's source of truth is the file, and
-- this table is a DERIVED, purgeable cache of what is inside it — exactly what
-- `note_index` is for a note. It is ranking fuel and nothing else: it is never
-- served as the file's content, never an authorization input, and everything
-- that deletes a blob or a vault deletes it too (the FK cascades below, plus
-- `purgeBlobText` for the paths that delete a row without one).
--
-- `content` is capped at 1 MB by the route, not by the schema: a limit that
-- changes with a release belongs in code, and TOAST stores a long text out of
-- line either way.
CREATE TABLE IF NOT EXISTS blob_text (
  blob_id    TEXT PRIMARY KEY REFERENCES blobs (id) ON DELETE CASCADE,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  -- The `files` doc this text belongs to, when the blob has one. Denormalised
  -- from `blobs.doc_id` so the search pass can intersect against the readable
  -- set without joining back to `blobs` on every query. No FK: a `files` row
  -- may be hard-deleted while its bytes are still being torn down, and a text
  -- cache row is not a reason to fail that delete.
  doc_id     TEXT,
  chars      INT NOT NULL,
  content    TEXT NOT NULL,
  -- 256-dim hashed bag-of-words, the same `index/embedder.ts` vector
  -- `note_index` stores, so one cosine comparison ranks notes and files alike.
  vector     JSONB,
  -- Who extracted it. `client` is the only producer today; the column exists so
  -- a future server-side extractor can be told apart from (and can overwrite)
  -- what a desktop sent.
  source     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Search scans one vault at a time, exactly as `note_index` does.
CREATE INDEX IF NOT EXISTS blob_text_vault_idx ON blob_text (vault_id);

-- `canReadAttachment` and the search pass both look a blob up by the doc whose
-- ACL governs it; without this that is a sequential scan of every blob in the
-- deployment on a request path.
CREATE INDEX IF NOT EXISTS blobs_doc_idx ON blobs (doc_id);

COMMENT ON COLUMN blobs.doc_id IS
  'files.id (== doc_id) of the tree file these bytes are, or NULL for an attachments/ drop (028)';
