SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Keyed vaults: the small half of a sealed search row on its own, so ranking a
-- search opens ~1 KB per note (vector + token set) instead of the whole note
-- body. A 14k-note vault's search read and decrypted 408 MB per query
-- (2026-11-02). Same key, same envelope, its own column in the AAD. Additive.
ALTER TABLE note_index ADD COLUMN search_score_enc BYTEA;

-- Keyed vaults re-run the backfill once so existing rows get the new column:
-- only the new step has work, every other table's cursor is already done.
UPDATE vault_crypto_state SET cursors = cursors - 'completedAt'
 WHERE vault_id IN (SELECT id FROM vaults WHERE vk_check IS NOT NULL);
