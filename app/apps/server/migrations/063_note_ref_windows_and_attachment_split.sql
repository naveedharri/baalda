-- SPDX-License-Identifier: Apache-2.0
--
-- #343, two parts.
--
-- 1. Reference excerpts for the scoped attachment list.
--
--    A plain member's attachment list asks "which `attachments/` (and other
--    non-file) blob paths does some note I can read contain?". Answering it
--    read `note_index.content` for every readable note, so its cost was the
--    TEXT of those notes: a vault with ~1 GB of single-file HTML apps spent
--    12-32 s just detoasting, past the statement timeout, although those
--    notes held almost no paths.
--
--    `ref_text` keeps only what the question can ever look at: for every
--    occurrence of every head in `ref_heads` (`attachments/`, the vault's
--    top-level folders, the first folder of each stored blob path), the head
--    and the next `REF_WINDOW_CHARS` characters, verbatim, joined by "\n"
--    (which no path contains). Every occurrence of a path whose anchor is in
--    `ref_heads` sits whole in its own excerpt, so a note covering the anchors
--    a request needs is answered from `ref_text` with the same result as from
--    `content`. A note that does not cover them (NULL here, or a head added
--    since) is read in full and recomputed in the background
--    (`src/blobs/ref-windows.ts`). Derived and rebuildable, like the rest of
--    `note_index`; NULL until the background backfill reaches a note.
ALTER TABLE note_index ADD COLUMN IF NOT EXISTS ref_text  TEXT;
ALTER TABLE note_index ADD COLUMN IF NOT EXISTS ref_heads TEXT[];

-- 2. Split attachment rows a copied file adopted before 0.1.92.
--
--    A file outside `attachments/` whose bytes equalled an `attachments/` drop
--    used to ADOPT the drop's row (`doc_id` := the file, path unchanged). From
--    then on, changing or deleting the file deleted that row (it is retired by
--    `doc_id`), the attachment vanished from every listing, and every device
--    holding it uploaded it again while the GC dropped the object behind them.
--    0.1.92 stopped making such rows; these are the ones made before.
--
--    Signature: a ready row bound to a LIVE `files` row outside `attachments/`
--    while its own path is still an `attachments/` path. The repair gives the
--    attachment its row back (doc_id NULL) and the file a row of its own on the
--    same stored object, exactly what 0.1.92 creates for a new copy. Where the
--    attachment has meanwhile been uploaded again (a doc-less row for the same
--    bytes already exists), the bound row simply becomes the file's own row
--    (its path is corrected), since the attachment is already back. No bytes
--    move: keys are content-addressed, the Postgres provider copies `data`.
CREATE TEMP TABLE _adopted_attachments ON COMMIT DROP AS
SELECT b.id, b.vault_id, b.sha256, f.id AS file_id, f.path AS file_path,
       EXISTS (
         SELECT 1 FROM blobs a
          WHERE a.vault_id = b.vault_id AND a.sha256 = b.sha256 AND a.doc_id IS NULL
       ) AS attachment_back
  FROM blobs b
  JOIN files f ON f.id = b.doc_id AND f.vault_id = b.vault_id
 WHERE b.status = 'ready'
   AND b.rel_path LIKE 'attachments/%'
   AND lower(f.path) NOT LIKE 'attachments/%';

-- The attachment is already back: the bound row becomes the file's own row.
UPDATE blobs b
   SET rel_path = x.file_path,
       filename = coalesce(nullif(regexp_replace(x.file_path, '^.*/', ''), ''), x.file_path),
       updated_at = now()
  FROM _adopted_attachments x
 WHERE b.id = x.id AND x.attachment_back;

-- Otherwise the row goes back to being the attachment ...
UPDATE blobs b
   SET doc_id = NULL, updated_at = now()
  FROM _adopted_attachments x
 WHERE b.id = x.id AND NOT x.attachment_back;

-- ... and the file gets a row of its own on the same object (none yet for
-- these bytes and this file, by the unique index the row just left).
INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, data, rel_path, filename,
                   storage_provider, storage_key, status, created_by, doc_id)
SELECT gen_random_uuid()::text, b.vault_id, b.org_id, b.sha256, b.size, b.mime, b.data,
       x.file_path, coalesce(nullif(regexp_replace(x.file_path, '^.*/', ''), ''), x.file_path),
       b.storage_provider, b.storage_key, 'ready', b.created_by, x.file_id
  FROM _adopted_attachments x
  JOIN blobs b ON b.id = x.id
 WHERE NOT x.attachment_back
ON CONFLICT DO NOTHING;
