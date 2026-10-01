-- SPDX-License-Identifier: Apache-2.0
--
-- Indexes for the Activity feed's listings and the deleted-readable set
-- (#261, #263). Additive only: no table, column or row changes.
--
-- The migration runner applies each file inside a transaction, so these cannot
-- be CREATE INDEX CONCURRENTLY. Both are partial or on small tables:
--  * note_versions_pre_shrink_idx covers only `pre-shrink` rows (rare by
--    design), so the index itself is tiny; the build reads note_versions once
--    and briefly blocks new version inserts while it does (they wait, they do
--    not fail).
--  * folder_tombstones holds a few rows per deleted folder.

-- Bounds only the wait to ACQUIRE each lock, not the build: a long-running
-- transaction on note_versions fails the deploy (which retries) instead of
-- queueing every version insert behind this statement while it waits.
SET LOCAL lock_timeout = '10s';

-- `GET /vaults/:id/shrink-events` now selects candidate docs first:
-- WHERE vault_id = $1 AND cause = 'pre-shrink' AND created_at >= $2.
CREATE INDEX IF NOT EXISTS note_versions_pre_shrink_idx
  ON note_versions (vault_id, created_at DESC)
  WHERE cause = 'pre-shrink';

-- The deleted-readable set's `dead_folder_paths` filters a vault's tombstones
-- and matches them by lower(path) prefix.
CREATE INDEX IF NOT EXISTS folder_tombstones_vault_lower_path_idx
  ON folder_tombstones (vault_id, lower(path) text_pattern_ops);
