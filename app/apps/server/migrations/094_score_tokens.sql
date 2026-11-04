SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- A keyed row's token set may now reach 1 MB (it lives only in its sealed
-- blobs): notes past the old 64 KB bound had every worded search open their
-- whole sealed body, 111 MB per search on one 14k-note vault (2026-11-02).
-- Keyed vaults re-run the backfill once so the new `*_score_tokens` steps give
-- those rows' score blobs a token set. No schema change.
UPDATE vault_crypto_state SET cursors = cursors - 'completedAt'
 WHERE vault_id IN (SELECT id FROM vaults WHERE vk_check IS NOT NULL);
