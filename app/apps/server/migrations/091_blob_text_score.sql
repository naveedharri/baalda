SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- The attachment half of 090: a keyed file's ranking data (vector + token set)
-- sealed apart from its extracted text, so a search ranks files from ~1 KB
-- each. One vault's file search opened 371 MB per query (2026-11-02). Additive.
ALTER TABLE blob_text ADD COLUMN search_score_enc BYTEA;

UPDATE vault_crypto_state SET cursors = cursors - 'completedAt'
 WHERE vault_id IN (SELECT id FROM vaults WHERE vk_check IS NOT NULL);
