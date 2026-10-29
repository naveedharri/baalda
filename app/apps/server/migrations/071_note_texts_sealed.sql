-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): a keyed vault's version/checkpoint text is
-- sealed into `note_texts.content_enc` (src/versions/texts.ts); its `content`
-- is stored as '' for such a row. Additive only: no existing text is dropped,
-- rewritten or nulled. Older plaintext rows (and pre-038 inline copies in
-- note_versions / vault_checkpoint_docs) stay as they are until the later,
-- separate, reversible null-out step.
ALTER TABLE note_texts ADD COLUMN IF NOT EXISTS content_enc BYTEA;
