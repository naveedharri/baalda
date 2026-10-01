-- SPDX-License-Identifier: Apache-2.0
--
-- Content-addressed note text for version history and vault checkpoints (#264).
--
-- Every daily checkpoint used to store a full copy of every note, and every
-- version a full copy of its note, even when the text was byte-identical to a
-- copy already held. Each distinct text of a note is now stored ONCE here, keyed
-- by (doc_id, sha256), and `note_versions` / `vault_checkpoint_docs` reference it
-- through the `sha256` they already carry. An unchanged note costs a checkpoint
-- one narrow `(checkpoint_id, doc_id, sha256)` row and no content bytes.
--
-- Backwards compatible and lock-light on large tables:
--   * Existing rows keep their inline `content`; readers resolve
--     `COALESCE(row.content, note_texts.content)`, so old checkpoints and
--     versions stay readable and restorable with no backfill. They age out
--     through the normal retention (5 checkpoints, 50 versions per note).
--   * `DROP NOT NULL` is a catalog-only change: no table rewrite, no scan.
--   * The new table starts empty, so its indexes cost nothing to build.
--
-- Keyed per DOC, not per vault: a note's own history is where the duplicates
-- are, the reference check on cleanup is an index probe on each referencing
-- table's existing (doc_id …) index, and purging a note's history (Trash) can
-- drop its texts by doc_id. Unreferenced rows are removed by
-- `gcNoteTexts` (`src/versions/texts.ts`) after a grace period measured from
-- `last_ref_at`, which every writer bumps before inserting its reference — that
-- grace is what keeps a cleanup from racing a writer that is about to point at
-- a row it just found.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS note_texts (
  doc_id      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  vault_id    TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ref_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, sha256)
);
CREATE INDEX IF NOT EXISTS note_texts_vault_idx ON note_texts (vault_id, last_ref_at);

ALTER TABLE note_versions ALTER COLUMN content DROP NOT NULL;
ALTER TABLE vault_checkpoint_docs ALTER COLUMN content DROP NOT NULL;
