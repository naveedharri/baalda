SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Score blobs (090, 091) are now compressed before sealing: they averaged 8 KB
-- per note, not the ~1 KB 090 expected, and a 14k-note vault's search spent
-- most of its 10-20 s receiving them (2026-11-02). Keyed vaults re-run the
-- backfill once so the new `*_score_pack` steps re-seal existing blobs
-- compressed, in place. No schema change; every other step is already done.
UPDATE vault_crypto_state SET cursors = cursors - 'completedAt'
 WHERE vault_id IN (SELECT id FROM vaults WHERE vk_check IS NOT NULL);
