-- A note's location is stored twice — rel_path (what clients render and write to
-- disk) and folder_id (what every ACL walk and the root-freeze latch read) — and
-- nothing kept them in agreement. The server now derives/validates folder_id from
-- rel_path on every create and move (registry/tree-ops.ts resolveParentFolder);
-- this migration repairs the rows written before that.
--
-- Found in production on 2026-08-27: 104 live notes with folder_id NULL and a
-- nested rel_path (registered without a folder id — "at the root" for permissions,
-- so folder shares never reached them, and refused as root creations once the
-- root was frozen), plus 3 whose folder_id pointed at a folder other than the one
-- at their path — one of them rendering a phantom root-level folder on every
-- desktop that no folder row backed and that re-materialized after every delete.

-- 0. Duplicate folder rows at one path. Nothing enforced (vault_id, path)
--    uniqueness, and two devices reconciling the same new folder at once (the
--    adopt-by-path SELECT races the INSERT) left 2–5 rows per path in production —
--    the desktop's path→id map then picked one at random, so notes and children
--    were split across twins. Keep the OLDEST row, re-point everything at it,
--    delete the rest. No tombstones for the losers: a tombstone tells clients to
--    remove the local folder, and the local folder IS the keeper's.
CREATE TEMP TABLE folder_dupes AS
SELECT f.id AS loser,
       (SELECT k.id FROM folders k
         WHERE k.vault_id = f.vault_id AND k.path = f.path
         ORDER BY k.created_at ASC, k.id ASC LIMIT 1) AS keeper
  FROM folders f;
DELETE FROM folder_dupes WHERE loser = keeper;

UPDATE notes n SET folder_id = d.keeper FROM folder_dupes d WHERE n.folder_id = d.loser;
UPDATE files fi SET folder_id = d.keeper FROM folder_dupes d WHERE fi.folder_id = d.loser;
UPDATE folders c SET parent_id = d.keeper FROM folder_dupes d WHERE c.parent_id = d.loser;
-- Children were re-pointed above, so ON DELETE CASCADE has nothing to cascade.
DELETE FROM folders f USING folder_dupes d WHERE f.id = d.loser;
DROP TABLE folder_dupes;

-- One path, one folder — the backstop the dedupe above should never be needed
-- again for. Both create surfaces adopt by path first; a lost race now surfaces
-- as 23505, which they catch and adopt.
CREATE UNIQUE INDEX IF NOT EXISTS folders_vault_path_uq ON folders (vault_id, path);

-- 1. A folder exists at the path's directory → the path wins; re-point folder_id.
--    Covers folder_id NULL + nested path, and folder_id pointing elsewhere.
UPDATE notes n
   SET folder_id = f.id, updated_at = now()
  FROM folders f
 WHERE n.deleted_at IS NULL
   AND position('/' IN n.rel_path) > 0
   AND f.vault_id = n.vault_id
   AND f.path = regexp_replace(n.rel_path, '/[^/]*$', '')
   AND n.folder_id IS DISTINCT FROM f.id;

-- 2. No folder exists at the path's directory but folder_id names a real folder →
--    the folder wins; move the file under it, keeping its name. If that name is
--    taken there, suffix the doc id's first 8 chars before the extension so the
--    live-path unique index (migration 021) is honoured and no content is lost.
--    (dirname of a root-level path is '', which a bare regexp_replace would not
--    give — hence the CASE.)
UPDATE notes n
   SET rel_path = f.path || '/' ||
       CASE
         WHEN EXISTS (
           SELECT 1 FROM notes o
            WHERE o.vault_id = n.vault_id AND o.deleted_at IS NULL AND o.id <> n.id
              AND o.rel_path = f.path || '/' || regexp_replace(n.rel_path, '^.*/', '')
         )
         THEN regexp_replace(regexp_replace(n.rel_path, '^.*/', ''), '(\.[^./]*)?$', '-' || left(n.id, 8) || '\1')
         ELSE regexp_replace(n.rel_path, '^.*/', '')
       END,
       updated_at = now()
  FROM folders f
 WHERE n.deleted_at IS NULL
   AND n.folder_id = f.id
   AND f.path <> (CASE WHEN position('/' IN n.rel_path) > 0
                       THEN regexp_replace(n.rel_path, '/[^/]*$', '') ELSE '' END)
   AND NOT EXISTS (
     SELECT 1 FROM folders g
      WHERE g.vault_id = n.vault_id
        AND g.path = (CASE WHEN position('/' IN n.rel_path) > 0
                           THEN regexp_replace(n.rel_path, '/[^/]*$', '') ELSE '' END)
   );

-- 3. Same as (1) for binary files (path column). None mismatched in production;
--    kept so the two tables can't drift apart in shape.
UPDATE files fi
   SET folder_id = f.id
  FROM folders f
 WHERE position('/' IN fi.path) > 0
   AND f.vault_id = fi.vault_id
   AND f.path = regexp_replace(fi.path, '/[^/]*$', '')
   AND fi.folder_id IS DISTINCT FROM f.id;
