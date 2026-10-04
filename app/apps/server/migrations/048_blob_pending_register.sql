-- 048: one-step file upload (`files-with-bytes`).
--
-- A new tree file used to cost four requests: POST /api/files registered the
-- row, then intent → PUT → complete moved the bytes. Registration had no Pro
-- gate (the `attachment_sync_requires_pro` 402 fired only at intent), so a Free
-- vault, a refused upload or a crash between the two left a `files` row with no
-- bytes behind it.
--
-- Now the intent may carry `register: { docId, relPath, folderId? }`. Every gate
-- (Pro, path ↔ folder, create permission, frozen root) runs at intent BEFORE
-- anything is written, and the registration waits on the pending blob row in
-- this column until `complete` verifies the bytes. `complete` then creates the
-- `files` row in the SAME transaction that marks the blob ready, and clears the
-- column. A pending row that is never completed is collected by the existing
-- pending sweep, taking its registration with it — no row without bytes.
--
-- Shape: { "docId": text, "relPath": text, "folderId": text | null }.
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS pending_register JSONB;

COMMENT ON COLUMN blobs.pending_register IS
  'One-step file upload: the files registration {docId, relPath, folderId} complete creates with the bytes; NULL once applied or for an ordinary upload (048)';
