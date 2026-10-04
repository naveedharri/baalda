-- SPDX-License-Identifier: Apache-2.0
--
-- Backfill `files.created_by` (added by 049 with no backfill).
--
-- Why: the creator-only delete rule (`permissions/http-gates.ts canDeleteItem`)
-- reads a NULL creator as "someone else's", so after 049 every pre-existing
-- tree file became admin-only to delete — plain members could no longer delete
-- files they uploaded themselves.
--
-- The uploader is already recorded: `blobs.created_by` (m026) on the blob rows
-- whose `blobs.doc_id` (m028) names the `files` row. A file takes that creator
-- only when its blob rows agree on exactly ONE distinct non-null uploader.
-- Files whose blob rows name two or more uploaders, files with no blob row at
-- all, and creators no longer present in "user" (the FK) are left NULL, i.e.
-- admin-only, exactly as before this migration. Rows that already carry a
-- creator are never touched, so re-running it is a no-op.

SET LOCAL lock_timeout = '10s';

UPDATE files f
   SET created_by = src.created_by
  FROM (
    SELECT b.doc_id, min(b.created_by) AS created_by
      FROM blobs b
     WHERE b.doc_id IS NOT NULL
       AND b.created_by IS NOT NULL
     GROUP BY b.doc_id
    HAVING count(DISTINCT b.created_by) = 1
  ) src
 WHERE f.id = src.doc_id
   AND f.created_by IS NULL
   AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = src.created_by);
