-- Version history: per-note versions + vault-wide checkpoints.
--
-- Versions store MARKDOWN TEXT + sha256, not Yjs bytes. The CRDT update log is
-- destroyed by compaction and a Y.Doc with gc on cannot reconstruct a past
-- state anyway; text is also what a preview and a forward diff need. Reverting
-- never replaces state backwards — the stored text is the TARGET, applied as a
-- forward transaction through the doc writer.

CREATE TABLE note_versions (
  id         BIGSERIAL PRIMARY KEY,
  -- No FK on doc_id: a note is soft-deleted (and can be restored by a vault
  -- revert), so its versions must outlive any churn in the notes table.
  doc_id     TEXT NOT NULL,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  cause      TEXT NOT NULL CHECK (cause IN ('idle', 'pre-revert')),
  author_id  TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Newest-first listing + "what is the latest version of this doc" (the dedupe
-- check on every idle capture) are the only two reads.
CREATE INDEX note_versions_doc_idx ON note_versions (doc_id, id DESC);

-- A checkpoint is a whole-vault snapshot: the folder/note STRUCTURE as JSONB
-- plus one row per note body in vault_checkpoint_docs.
CREATE TABLE vault_checkpoints (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
  label      TEXT,
  created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- { notes: [{id, rel_path, folder_id, title}], folders: [{id, parent_id, name, path, sort}] }
  structure  JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX vault_checkpoints_vault_idx ON vault_checkpoints (vault_id, created_at DESC);

CREATE TABLE vault_checkpoint_docs (
  checkpoint_id TEXT NOT NULL REFERENCES vault_checkpoints (id) ON DELETE CASCADE,
  doc_id        TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  content       TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, doc_id)
);
