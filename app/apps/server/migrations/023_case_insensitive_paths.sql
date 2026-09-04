-- A path must name exactly ONE folder and ONE live note per vault, compared
-- CASE-INSENSITIVELY. Migration 021 (notes) and 022 (folders) established that
-- rule for exact paths; this extends it to case, which is the version that
-- actually matters on the platforms we ship.
--
-- macOS (APFS default) and Windows are case-insensitive: `Projects/Community`
-- and `Projects/community` are ONE directory on disk. Postgres TEXT is
-- case-sensitive, so both were legal distinct rows with distinct doc_ids — and
-- every desktop then mapped one file to two docs. Doc A egested to disk, the
-- watcher fired, doc B ingested a file that disagreed with its own CRDT state
-- and wrote back, forever.
--
-- Found in production 2026-09-04 in the BenAI OS vault: a teammate created
-- `Projects/community` on 2026-08-20 alongside the existing `Projects/Community`
-- from 2026-08-07, duplicating the whole subtree — 71 folders and 164 note
-- pairs. The ping-pong ran at **189 MB of updates per hour**; those 328 notes
-- were 0.5% of the vault's docs and 26% (190 MB of 733 MB) of all its CRDT
-- bytes, each individual update having grown to 0.6–3.5 MB.
--
-- The trade this locks in: a case-sensitive Linux vault can no longer keep
-- `a.md` and `A.md` as separate notes. That is the same call Git makes with
-- `core.ignorecase`, and it is the only choice that lets one vault sync between
-- a Mac and a Linux box at all — the Mac cannot represent both files.
-- Enforced going forward by `samePath()` in src/registry/tree-ops.ts, which the
-- HTTP registry and the MCP tools both route through; these indexes are the
-- backstop for the races those adopt-by-path lookups can still lose.

-- ── 1. Folders: merge case-variant twins ────────────────────────────────────
-- Same shape as 022's exact-path dedupe: keep the OLDEST row per
-- (vault_id, lower(path)), re-point everything at it, delete the losers. No
-- folder_tombstones rows for the losers — a tombstone tells clients to delete
-- the local folder, and the local folder IS the keeper's (one directory on a
-- case-insensitive disk, and the same content on a case-sensitive one).
CREATE TEMP TABLE folder_case_dupes AS
SELECT f.id AS loser,
       (SELECT k.id FROM folders k
         WHERE k.vault_id = f.vault_id AND lower(k.path) = lower(f.path)
         ORDER BY k.created_at ASC, k.id ASC LIMIT 1) AS keeper
  FROM folders f;
DELETE FROM folder_case_dupes WHERE loser = keeper;

UPDATE notes   n  SET folder_id = d.keeper FROM folder_case_dupes d WHERE n.folder_id  = d.loser;
UPDATE files   fi SET folder_id = d.keeper FROM folder_case_dupes d WHERE fi.folder_id = d.loser;
UPDATE folders c  SET parent_id = d.keeper FROM folder_case_dupes d WHERE c.parent_id  = d.loser;
-- Shares pointed at a loser have to follow it, or revoking/attaching access on
-- the surviving folder would silently ignore a grant that still governs it.
-- ON CONFLICT: the keeper may already carry the identical grant.
UPDATE shares s SET resource_id = d.keeper
  FROM folder_case_dupes d
 WHERE s.resource_type = 'folder' AND s.resource_id = d.loser
   AND NOT EXISTS (
     SELECT 1 FROM shares k
      WHERE k.resource_type = 'folder' AND k.resource_id = d.keeper
        AND k.principal_type = s.principal_type AND k.principal_id = s.principal_id);
DELETE FROM shares s USING folder_case_dupes d
 WHERE s.resource_type = 'folder' AND s.resource_id = d.loser;

-- Children were re-pointed above, so ON DELETE CASCADE has nothing to cascade.
DELETE FROM folders f USING folder_case_dupes d WHERE f.id = d.loser;
DROP TABLE folder_case_dupes;

-- Re-spell every surviving folder onto its parent's actual path, so a subtree
-- that mixed cases across levels (`Projects/Community/drafts` under a keeper
-- named `Projects/community`) agrees with `resolveFolderParent` again. Deepest
-- paths last: a parent must be corrected before its children read it. Bounded
-- by tree depth, and a no-op on the second pass.
DO $$
DECLARE
  fixed int;
BEGIN
  FOR i IN 1..32 LOOP
    UPDATE folders c
       SET path = p.path || '/' || c.name
      FROM folders p
     WHERE c.parent_id = p.id
       AND c.path <> p.path || '/' || c.name
       AND lower(c.path) = lower(p.path || '/' || c.name);
    GET DIAGNOSTICS fixed = ROW_COUNT;
    EXIT WHEN fixed = 0;
  END LOOP;
END $$;

-- ── 2. Notes: soft-delete case-variant duplicates ───────────────────────────
-- Same keeper rule as 021: per (vault_id, lower(rel_path)) keep the oldest live
-- row that actually holds CRDT data (else simply the oldest) and tombstone the
-- rest. The losers' doc_updates/doc_snapshots are deliberately LEFT IN PLACE —
-- a soft-deleted note keeps its history recoverable, and the disk file (the
-- durable source of truth) is untouched and still owned by the keeper.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY vault_id, lower(rel_path)
           ORDER BY (EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = notes.id)
                  OR EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = notes.id)) DESC,
                    created_at ASC,
                    id ASC
         ) AS rn
  FROM notes
  WHERE deleted_at IS NULL
)
UPDATE notes SET deleted_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Re-spell surviving notes onto their folder's path, for the same reason as the
-- folder pass above (keeps migration 022's `dirname(rel_path) = folder.path`
-- invariant exact rather than merely case-insensitive). Guarded by the
-- `lower() = lower()` clause so this only ever fixes CASE — a note whose
-- rel_path and folder_id genuinely disagree is 022's business, not ours.
UPDATE notes n
   SET rel_path = f.path || '/' || substring(n.rel_path FROM '[^/]+$')
  FROM folders f
 WHERE n.folder_id = f.id
   AND n.deleted_at IS NULL
   AND n.rel_path <> f.path || '/' || substring(n.rel_path FROM '[^/]+$')
   AND lower(n.rel_path) = lower(f.path || '/' || substring(n.rel_path FROM '[^/]+$'));

-- ── 3. Files: same merge as notes, minus the CRDT tiebreak ──────────────────
-- `files` has no soft-delete column, so the loser rows go. A file's bytes live
-- in `blobs` keyed by the doc id, which is why the OLDEST row wins here too:
-- it is the one clients have been uploading against.
CREATE TEMP TABLE file_case_dupes AS
SELECT f.id AS loser,
       (SELECT k.id FROM files k
         WHERE k.vault_id = f.vault_id AND lower(k.path) = lower(f.path)
         ORDER BY k.created_at ASC, k.id ASC LIMIT 1) AS keeper
  FROM files f;
DELETE FROM file_case_dupes WHERE loser = keeper;

-- Per-file shares must follow, or the delete below would drop a grant that
-- still governs the surviving file (`shares.resource_id` has no FK to `files`,
-- so nothing would flag the orphan).
UPDATE shares s SET resource_id = d.keeper
  FROM file_case_dupes d
 WHERE s.resource_type = 'file' AND s.resource_id = d.loser
   AND NOT EXISTS (
     SELECT 1 FROM shares k
      WHERE k.resource_type = 'file' AND k.resource_id = d.keeper
        AND k.principal_type = s.principal_type AND k.principal_id = s.principal_id);
DELETE FROM shares s USING file_case_dupes d
 WHERE s.resource_type = 'file' AND s.resource_id = d.loser;

DELETE FROM files f USING file_case_dupes d WHERE f.id = d.loser;
DROP TABLE file_case_dupes;

-- ── 4. The backstops ────────────────────────────────────────────────────────
-- Both create surfaces adopt case-insensitively by path first; a lost race now
-- surfaces as 23505, which they catch and adopt (same contract as m021/m022).
CREATE UNIQUE INDEX IF NOT EXISTS folders_vault_path_ci_uq
  ON folders (vault_id, lower(path));

CREATE UNIQUE INDEX IF NOT EXISTS notes_live_path_ci_uq
  ON notes (vault_id, lower(rel_path))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS files_vault_path_ci_uq
  ON files (vault_id, lower(path));
