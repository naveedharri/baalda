-- Who registered a tree file, mirroring notes.created_by (m002) and
-- folders.created_by (m012). Drives the members-delete-only-their-own rule
-- (`permissions/http-gates.ts canDeleteItem`). Nullable and NOT backfilled here:
-- a file with no recorded creator counts as someone else's, so only an owner
-- or admin may delete it. 050 backfills it from the uploader on the file's
-- blob rows.

SET LOCAL lock_timeout = '10s';

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL;
