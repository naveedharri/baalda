-- SPDX-License-Identifier: Apache-2.0
--
-- Unicode-normalized path identity (#259). Additive only: one function and
-- three indexes. No table, column or row changes; every path stays stored
-- exactly as the client sent it.
--
-- macOS hands out file names DECOMPOSED (NFD: `e` + U+0301) where Windows and
-- Linux keep them COMPOSED (NFC: U+00E9). APFS opens both spellings as one
-- file, but the m023 unique indexes on `lower(path)` compare bytes, so a Mac
-- and a Windows client could each register `Café.md` — two doc ids for one
-- file on every Mac, the same fork m023 closed for case variants. The desktop
-- already compares paths as NFC + lowercase (`lib/pathIdentity.ts pathKey`);
-- this makes the server equally strict so even an older client cannot create
-- a twin.
--
-- `vault_path_key(p)` is THE comparison key. Every server path lookup now
-- reads `vault_path_key(col) = vault_path_key($n)`, and the JS mirror is
-- `registry/tree-ops.ts pathKey`. A one-statement IMMUTABLE SQL function is
-- inlined by the planner, so the indexes below match those predicates.
-- NEVER change its body in place: an index built on the old body would no
-- longer agree with the queries. A new key needs a new function and new
-- indexes.
--
-- normalize() exists from Postgres 13 and only on a UTF8 database. Anywhere
-- else the key falls back to plain lower(), which is exactly the m023
-- behaviour, so the server keeps working (without the NFC guarantee) rather
-- than failing every lookup at runtime.
--
-- The old `lower()` unique indexes stay: they are the guarantee wherever the
-- new one below has to be skipped.

-- Bounds only the wait to ACQUIRE each lock: a long-running transaction on
-- notes/files/folders fails the deploy (which retries) instead of queueing
-- every write behind this migration.
SET LOCAL lock_timeout = '10s';

DO $migration$
BEGIN
  IF getdatabaseencoding() = 'UTF8'
     AND current_setting('server_version_num')::int >= 130000 THEN
    CREATE OR REPLACE FUNCTION vault_path_key(p text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $fn$ SELECT normalize(lower(p), NFC) $fn$;
  ELSE
    RAISE NOTICE 'vault_path_key: database is not UTF8 on Postgres 13+; paths compare by lower() only';
    CREATE OR REPLACE FUNCTION vault_path_key(p text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $fn$ SELECT lower(p) $fn$;
  END IF;
END
$migration$;

-- One index per table. Each block takes the SHARE lock CREATE INDEX would take
-- anyway BEFORE counting, so no write can slip a twin in between the check and
-- the build. If a vault already holds NFC twins (two rows m023 allowed because
-- their bytes differ), the UNIQUE index cannot be built: rather than failing
-- the deploy or touching anyone's rows, we build the same index NON-unique, so
-- the lookups stay index-backed, and say so. The server's adopt-by-key lookups
-- (oldest row wins) keep new twins from being created either way; an operator
-- can merge the existing ones and re-run the unique build by hand.

DO $migration$
DECLARE
  twins bigint;
BEGIN
  LOCK TABLE notes IN SHARE MODE;
  SELECT count(*) INTO twins FROM (
    SELECT 1 FROM notes
     WHERE deleted_at IS NULL
     GROUP BY vault_id, vault_path_key(rel_path)
    HAVING count(*) > 1
  ) d;
  IF twins = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS notes_live_path_key_uq
      ON notes (vault_id, vault_path_key(rel_path))
      WHERE deleted_at IS NULL;
  ELSE
    RAISE NOTICE 'notes: % live path(s) have Unicode-normalization twins; built notes_live_path_key_idx non-unique (lower() uniqueness unchanged)', twins;
    CREATE INDEX IF NOT EXISTS notes_live_path_key_idx
      ON notes (vault_id, vault_path_key(rel_path))
      WHERE deleted_at IS NULL;
  END IF;
END
$migration$;

DO $migration$
DECLARE
  twins bigint;
BEGIN
  LOCK TABLE files IN SHARE MODE;
  SELECT count(*) INTO twins FROM (
    SELECT 1 FROM files
     GROUP BY vault_id, vault_path_key(path)
    HAVING count(*) > 1
  ) d;
  IF twins = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS files_vault_path_key_uq
      ON files (vault_id, vault_path_key(path));
  ELSE
    RAISE NOTICE 'files: % path(s) have Unicode-normalization twins; built files_vault_path_key_idx non-unique (lower() uniqueness unchanged)', twins;
    CREATE INDEX IF NOT EXISTS files_vault_path_key_idx
      ON files (vault_id, vault_path_key(path));
  END IF;
END
$migration$;

DO $migration$
DECLARE
  twins bigint;
BEGIN
  LOCK TABLE folders IN SHARE MODE;
  SELECT count(*) INTO twins FROM (
    SELECT 1 FROM folders
     GROUP BY vault_id, vault_path_key(path)
    HAVING count(*) > 1
  ) d;
  IF twins = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS folders_vault_path_key_uq
      ON folders (vault_id, vault_path_key(path));
  ELSE
    RAISE NOTICE 'folders: % path(s) have Unicode-normalization twins; built folders_vault_path_key_idx non-unique (lower() uniqueness unchanged)', twins;
    CREATE INDEX IF NOT EXISTS folders_vault_path_key_idx
      ON folders (vault_id, vault_path_key(path));
  END IF;
END
$migration$;
