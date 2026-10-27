-- SPDX-License-Identifier: Apache-2.0
--
-- 1. `blobs` had no index leading with org_id, so the vault unsync/delete
--    preview (`countVaultContents`, http/routes/orgs.ts: sum(size) WHERE
--    org_id = $1) and the org delete (DELETE FROM blobs WHERE org_id = $1)
--    each read the whole table. The org-id column also covers hash-named
--    `attachments/` drops, which have no vault_id, so blobs_vault_idx cannot
--    stand in.
--
-- 2. pg_stat_statements, so an operator can see which statements cost the
--    most (e.g. the source of large sequential scans) without catching them
--    live. Its views only return data when `shared_preload_libraries`
--    includes it; creating the extension without that is harmless. Nothing in
--    the app reads it. A database role that may not create it, or a Postgres
--    build that does not ship it, skips it with a notice instead of failing
--    the migration.
--
-- The migration runner applies each file inside a transaction, so no
-- CONCURRENTLY: the index build blocks blob writes briefly (they wait, they
-- do not fail).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS blobs_org_idx ON blobs (org_id);

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  -- insufficient_privilege: the role may not create untrusted extensions.
  -- feature_not_supported: the extension is not installed ("is not available").
  -- undefined_file: its control file is present but a script file is missing.
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_stat_statements not enabled (%): %', SQLSTATE, SQLERRM;
END
$$;
