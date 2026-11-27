-- SPDX-License-Identifier: Apache-2.0
--
-- Folder and Access (decided 2026-11-27). A vault's team-wide settings become
-- each person's own settings, so everyone opens and edits exactly what they do
-- today, and access groups stay an add-on a team chooses to use. No group is
-- created.
--
--   * A vault whose team level is Can edit or Can view: every member without a
--     whole-vault level of their own gets that level as their own (owners and
--     admins too: today they get exactly the team level).
--   * A vault never shared: members keep what they write; owners and admins get
--     Can edit everything (decided 2026-11-25).
--   * A vault already on Only what's shared: nobody gets a new vault level.
--   * Then every folder (top-down) and every note and file is checked person by
--     person: wherever the new settings would answer differently from today, a
--     setting just for that person is written on that folder, note or file with
--     what they have today, join records included, so nothing anyone sees or
--     can do changes. (For someone who joined earlier, a note added later
--     inside a folder that existed at their join follows that folder's row.)
--   * The team rows on folders, notes and files (shared, view, hidden) go; the
--     team row on the vault becomes Only what's shared; join records in the
--     converted vaults go. Read-only padlocks stay: they are caps.
--   * The level new people start with (invites, join code) is the vault's old
--     team level.
--
-- Everything written or removed is logged in access_personal_conversion*, so it
-- can be undone exactly. Access groups are not read: none exist before this.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS access_personal_conversion (
  organization_id      TEXT PRIMARY KEY,
  old_posture          TEXT,
  old_posture_revision BIGINT,
  old_join_default     TEXT,
  converted_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_personal_conversion_rows (
  organization_id TEXT NOT NULL,
  share_id        TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('inserted', 'updated', 'deleted')),
  resource_type   TEXT,
  resource_id     TEXT,
  principal_type  TEXT,
  principal_id    TEXT,
  old_permission  TEXT,
  access_revision BIGINT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ,
  PRIMARY KEY (organization_id, share_id)
);
CREATE TABLE IF NOT EXISTS access_personal_conversion_snapshots (
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,
  access_revision BIGINT NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

-- The level new people start with, in an invite or through the join code.
ALTER TABLE organization_access_settings ADD COLUMN IF NOT EXISTS new_member_level TEXT
  CHECK (new_member_level IS NULL OR new_member_level IN ('edit', 'view'));
ALTER TABLE org_join_codes ADD COLUMN IF NOT EXISTS access_level TEXT
  CHECK (access_level IS NULL OR access_level IN ('edit', 'view'));

-- ── what is converted ───────────────────────────────────────────────────────
CREATE TEMP TABLE c_org ON COMMIT DROP AS
SELECT o.id AS org_id,
       CASE s.permission WHEN 'edit' THEN 'edit' WHEN 'view' THEN 'view' WHEN 'denied' THEN 'sealed' ELSE 'never' END AS posture,
       s.id AS posture_id, s.permission AS posture_perm, s.access_revision AS posture_rev, a.join_default
  FROM organization o
  LEFT JOIN shares s ON s.resource_type = 'vault' AND s.resource_id = o.id
                    AND s.principal_type = 'org' AND s.principal_id = o.id
                    AND s.permission IN ('edit', 'view', 'denied')
  LEFT JOIN organization_access_settings a ON a.organization_id = o.id
 WHERE NOT EXISTS (SELECT 1 FROM access_personal_conversion c WHERE c.organization_id = o.id);
CREATE UNIQUE INDEX ON c_org (org_id);
ANALYZE c_org;

CREATE TEMP TABLE c_mem ON COMMIT DROP AS
SELECT m."organizationId" AS org_id, m."userId" AS user_id, m.role,
       ms.mode AS snap_mode, ms.access_revision AS snap_rev, ms.snapshot_at AS snap_at
  FROM member m
  JOIN c_org c ON c.org_id = m."organizationId"
  LEFT JOIN member_access_snapshots ms ON ms.organization_id = m."organizationId" AND ms.user_id = m."userId";
CREATE UNIQUE INDEX ON c_mem (org_id, user_id);
ANALYZE c_mem;

-- Only a place some setting reaches, or content someone with a join record
-- joined under, can answer differently after the move: everywhere else a
-- person's answer is the vault level, which the move copies. So only those
-- are checked.
CREATE TEMP TABLE c_hotf ON COMMIT DROP AS
WITH RECURSIVE r AS (
  SELECT f.id FROM folders f JOIN vaults v ON v.id = f.vault_id JOIN c_org c ON c.org_id = v.organization_id
   WHERE EXISTS (SELECT 1 FROM shares s WHERE s.resource_type = 'folder' AND s.resource_id = f.id)
  UNION
  SELECT k.id FROM r JOIN folders k ON k.parent_id = r.id
)
SELECT id FROM r;
CREATE UNIQUE INDEX ON c_hotf (id);
ANALYZE c_hotf;

CREATE TEMP TABLE c_snaporg ON COMMIT DROP AS
SELECT org_id, max(snap_at) AS snap_at FROM c_mem WHERE snap_mode IS NOT NULL GROUP BY org_id;
ANALYZE c_snaporg;

CREATE TEMP TABLE c_item ON COMMIT DROP AS
SELECT 'folder'::text AS kind, f.id, v.organization_id AS org_id, f.created_at, NULL::text AS created_by, f.id AS folder_id
  FROM folders f JOIN vaults v ON v.id = f.vault_id JOIN c_org c ON c.org_id = v.organization_id
 WHERE f.id IN (SELECT id FROM c_hotf)
    OR f.created_at <= (SELECT so.snap_at FROM c_snaporg so WHERE so.org_id = v.organization_id)
UNION ALL
SELECT 'file', n.id, v.organization_id, n.created_at, n.created_by, n.folder_id
  FROM notes n JOIN vaults v ON v.id = n.vault_id JOIN c_org c ON c.org_id = v.organization_id
 WHERE n.deleted_at IS NULL
   AND (n.folder_id IN (SELECT id FROM c_hotf)
        OR EXISTS (SELECT 1 FROM shares s WHERE s.resource_type = 'file' AND s.resource_id = n.id)
        OR n.created_at <= (SELECT so.snap_at FROM c_snaporg so WHERE so.org_id = v.organization_id))
UNION ALL
SELECT 'file', fi.id, v.organization_id, fi.created_at, NULL, fi.folder_id
  FROM files fi JOIN vaults v ON v.id = fi.vault_id JOIN c_org c ON c.org_id = v.organization_id
 WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = fi.id AND n.deleted_at IS NULL)
   AND (fi.folder_id IN (SELECT id FROM c_hotf)
        OR EXISTS (SELECT 1 FROM shares s WHERE s.resource_type = 'file' AND s.resource_id = fi.id)
        OR fi.created_at <= (SELECT so.snap_at FROM c_snaporg so WHERE so.org_id = v.organization_id));

-- Folder ancestry (d = 0 is the folder itself) for those items.
CREATE TEMP TABLE c_fa ON COMMIT DROP AS
WITH RECURSIVE r AS (
  SELECT DISTINCT i.folder_id, i.folder_id AS anc_id, 0 AS d FROM c_item i WHERE i.folder_id IS NOT NULL
  UNION ALL
  SELECT r.folder_id, p.parent_id, r.d + 1
    FROM r JOIN folders p ON p.id = r.anc_id
   WHERE p.parent_id IS NOT NULL AND r.d < 200
)
SELECT * FROM r;
CREATE INDEX ON c_fa (folder_id);
ANALYZE c_fa;

ALTER TABLE c_item ADD COLUMN stage INT;
UPDATE c_item i SET stage = CASE WHEN i.kind = 'file' THEN 100000
  ELSE (SELECT max(fa.d) FROM c_fa fa WHERE fa.folder_id = i.id) END;
CREATE INDEX ON c_item (stage);
ANALYZE c_item;

-- The places a setting can sit on, for each item: a note or file itself
-- (d = 0), then its folders nearest first; a folder and its ancestors.
CREATE TEMP TABLE c_ch ON COMMIT DROP AS
SELECT i.kind, i.id, 'file'::text AS rtype, i.id AS rid, 0 AS d FROM c_item i WHERE i.kind = 'file'
UNION ALL
SELECT i.kind, i.id, 'folder', fa.anc_id, fa.d + CASE WHEN i.kind = 'file' THEN 1 ELSE 0 END
  FROM c_item i JOIN c_fa fa ON fa.folder_id = i.folder_id;
CREATE INDEX ON c_ch (rtype, rid);
CREATE INDEX ON c_ch (kind, id);
ANALYZE c_ch;

-- ── one level calculation, used for "today" and for "after" ─────────────────
-- Mirrors effectivePermission (resolver.ts) without groups: 2 = edit, 1 = view,
-- 0 = none, for every member of the vault on every item of one stage, into
-- c_out. p_today picks the state: today's team rows and join records, or the
-- converted state. Reads shares as it stands when called.
CREATE TEMP TABLE c_out (org_id TEXT, user_id TEXT, kind TEXT, id TEXT, lvl INT) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.c_run(p_today BOOLEAN, p_stage INT, p_snap BOOLEAN)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  DROP TABLE IF EXISTS c_s_it, c_s_ch, c_s_u, c_s_or, c_s_o, c_s_pv;
  TRUNCATE c_out;
  CREATE TEMP TABLE c_s_it AS SELECT * FROM c_item WHERE stage = p_stage;
  CREATE INDEX ON c_s_it (kind, id);
  ANALYZE c_s_it;
  CREATE TEMP TABLE c_s_ch AS SELECT c.* FROM c_ch c JOIN c_s_it it ON it.kind = c.kind AND it.id = c.id;
  CREATE INDEX ON c_s_ch (rtype, rid);
  ANALYZE c_s_ch;
  -- each person's closest row of their own
  CREATE TEMP TABLE c_s_u AS
  SELECT DISTINCT ON (ch.kind, ch.id, s.principal_id) ch.kind, ch.id, s.principal_id AS user_id, s.permission
    FROM c_s_ch ch JOIN shares s ON s.resource_type = ch.rtype AND s.resource_id = ch.rid
                                AND s.principal_type = 'user' AND s.permission IN ('edit', 'readonly', 'view', 'denied')
   ORDER BY ch.kind, ch.id, s.principal_id, ch.d;
  CREATE INDEX ON c_s_u (kind, id, user_id);
  ANALYZE c_s_u;
  -- team rows on the chain
  CREATE TEMP TABLE c_s_or AS
  SELECT ch.kind, ch.id, s.permission, s.access_revision
    FROM c_s_ch ch JOIN c_s_it it ON it.kind = ch.kind AND it.id = ch.id
    JOIN shares s ON s.resource_type = ch.rtype AND s.resource_id = ch.rid
                 AND s.principal_type = 'org' AND s.principal_id = it.org_id;
  CREATE INDEX ON c_s_or (kind, id);
  ANALYZE c_s_or;
  CREATE TEMP TABLE c_s_o AS
  SELECT kind, id,
         bool_or(permission = 'denied' AND p_today) AS priv,
         bool_or(permission IN ('locked', 'readonly')) AS cap,
         max(CASE WHEN permission = 'edit' AND p_today THEN 2
                  WHEN permission = 'view' AND p_today THEN 1
                  WHEN permission = 'readonly' THEN 1 ELSE 0 END) AS og
    FROM c_s_or GROUP BY kind, id;
  CREATE INDEX ON c_s_o (kind, id);
  ANALYZE c_s_o;
  CREATE TEMP TABLE c_s_pv AS
  SELECT s.resource_id AS org_id, s.principal_id AS user_id,
         CASE s.permission WHEN 'edit' THEN 2 WHEN 'denied' THEN -1 ELSE 1 END AS lvl
    FROM shares s JOIN c_org c ON c.org_id = s.resource_id
   WHERE s.resource_type = 'vault' AND s.principal_type = 'user'
     AND s.permission IN ('edit', 'view', 'readonly', 'denied');
  CREATE INDEX ON c_s_pv (org_id, user_id);
  ANALYZE c_s_pv;

  INSERT INTO c_out
  SELECT it.org_id, m.user_id, it.kind, it.id,
    CASE WHEN g.lvl > 0 AND (coalesce(o.cap, false) OR u.permission = 'readonly') THEN 1 ELSE g.lvl END
  FROM c_s_it it
  JOIN c_mem m ON m.org_id = it.org_id
  JOIN c_org c ON c.org_id = it.org_id
  LEFT JOIN c_s_u u ON u.kind = it.kind AND u.id = it.id AND u.user_id = m.user_id
  LEFT JOIN c_s_o o ON o.kind = it.kind AND o.id = it.id
  LEFT JOIN c_s_pv pv ON pv.org_id = it.org_id AND pv.user_id = m.user_id
  CROSS JOIN LATERAL (SELECT
     CASE u.permission WHEN 'edit' THEN 2 WHEN 'readonly' THEN 1 WHEN 'view' THEN 1 ELSE 0 END AS ug,
     coalesce(o.priv, false) AS priv,
     coalesce(o.og, 0) AS og,
     CASE WHEN p_today THEN c.posture
          WHEN c.posture IN ('edit', 'view') THEN 'sealed' ELSE c.posture END AS posture,
     p_snap AND m.snap_mode IS NOT NULL AND it.created_at <= m.snap_at
       AND (p_today OR c.posture NOT IN ('edit', 'view')) AS snapped) x
  CROSS JOIN LATERAL (SELECT CASE
     WHEN u.permission = 'denied' THEN 0
     WHEN pv.lvl IS NOT NULL THEN
       CASE WHEN pv.lvl = -1 THEN x.ug
            ELSE GREATEST(pv.lvl, x.ug, CASE WHEN x.priv THEN 0 ELSE x.og END) END
     WHEN x.snapped THEN GREATEST(
       x.ug,
       CASE WHEN x.priv THEN 0 ELSE GREATEST(
         CASE m.snap_mode WHEN 'open' THEN 2 WHEN 'readonly' THEN 1 ELSE 0 END,
         -- team grants written after the join still reach older content
         coalesce((SELECT max(CASE WHEN r.permission = 'edit' THEN 2 ELSE 1 END)
                     FROM c_s_or r
                    WHERE r.kind = it.kind AND r.id = it.id
                      AND r.permission IN ('edit', 'view', 'readonly') AND r.access_revision > m.snap_rev
                      AND (p_today OR r.permission = 'readonly')), 0),
         CASE WHEN p_today AND c.posture IN ('edit', 'view') AND c.posture_rev > m.snap_rev
              THEN CASE c.posture WHEN 'edit' THEN 2 ELSE 1 END ELSE 0 END) END)
     WHEN x.priv THEN x.ug
     WHEN x.posture = 'view' THEN GREATEST(1, x.og, x.ug)
     WHEN x.posture = 'sealed' THEN GREATEST(x.og, x.ug)
     WHEN x.posture = 'edit' THEN 2
     -- never shared: owners/admins have no shortcut; people keep what they wrote
     WHEN m.role IS NOT NULL AND it.created_by IS NOT NULL AND it.created_by = m.user_id THEN 2
     ELSE GREATEST(x.og, x.ug)
   END AS lvl) g;
  DROP TABLE c_s_it, c_s_ch, c_s_u, c_s_or, c_s_o, c_s_pv;
END $f$;

-- Today's answers, before anything changes (folders also without join
-- records: see the header).
CREATE TEMP TABLE c_today (org_id TEXT, user_id TEXT, kind TEXT, id TEXT, lvl INT) ON COMMIT DROP;
DO $$
DECLARE st INT;
BEGIN
  FOR st IN SELECT DISTINCT stage FROM c_item ORDER BY 1 LOOP
    PERFORM pg_temp.c_run(true, st, true);
    INSERT INTO c_today SELECT org_id, user_id, kind, id, lvl FROM c_out;
  END LOOP;
END $$;
CREATE INDEX ON c_today (kind, id, user_id);
ANALYZE c_today;

-- ── the move ────────────────────────────────────────────────────────────────
-- 1. Whole-vault levels of their own.
WITH ins AS (
  INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
  SELECT gen_random_uuid()::text, m.org_id, 'vault', m.org_id, 'user', m.user_id,
         CASE WHEN c.posture = 'never' THEN 'edit' ELSE c.posture END, 0
    FROM c_mem m JOIN c_org c ON c.org_id = m.org_id
   WHERE (c.posture IN ('edit', 'view') OR (c.posture = 'never' AND m.role IN ('owner', 'admin')))
     AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.resource_type = 'vault' AND s.resource_id = m.org_id
                       AND s.principal_type = 'user' AND s.principal_id = m.user_id)
  RETURNING id, org_id, principal_id)
INSERT INTO access_personal_conversion_rows (organization_id, share_id, action, resource_type, resource_id, principal_type, principal_id)
SELECT org_id, id, 'inserted', 'vault', org_id, 'user', principal_id FROM ins;

-- 2. Team rows on folders, notes and files go (padlocks stay); the vault's team
--    row becomes Only what's shared; join records in converted vaults go.
WITH del AS (
  DELETE FROM shares s USING c_org c
   WHERE s.org_id = c.org_id AND s.principal_type = 'org' AND s.principal_id = c.org_id
     AND s.resource_type IN ('folder', 'file') AND s.permission IN ('edit', 'view', 'denied')
  RETURNING s.*)
INSERT INTO access_personal_conversion_rows
  (organization_id, share_id, action, resource_type, resource_id, principal_type, principal_id, old_permission, access_revision, created_by, created_at)
SELECT org_id, id, 'deleted', resource_type, resource_id, principal_type, principal_id, permission, access_revision, created_by, created_at FROM del;

INSERT INTO access_personal_conversion_rows (organization_id, share_id, action, resource_type, resource_id, principal_type, principal_id, old_permission, access_revision)
SELECT c.org_id, c.posture_id, 'updated', 'vault', c.org_id, 'org', c.org_id, c.posture_perm, c.posture_rev
  FROM c_org c WHERE c.posture IN ('edit', 'view');
UPDATE shares s SET permission = 'denied'
  FROM c_org c WHERE s.id = c.posture_id AND c.posture IN ('edit', 'view');

WITH del AS (
  DELETE FROM member_access_snapshots ms USING c_org c
   WHERE ms.organization_id = c.org_id AND c.posture IN ('edit', 'view')
  RETURNING ms.*)
INSERT INTO access_personal_conversion_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
SELECT organization_id, user_id, mode, access_revision, snapshot_at FROM del;

-- 3. Folders top-down, then notes and files: a setting just for the person
--    wherever the converted state answers differently from today.
DO $$
DECLARE st INT;
BEGIN
  FOR st IN SELECT DISTINCT stage FROM c_item ORDER BY 1 LOOP
    PERFORM pg_temp.c_run(false, st, true);
    WITH diff AS (
      SELECT a.org_id, a.user_id, a.kind, a.id,
             t.lvl AS want, a.lvl AS got,
             c.posture, m.role
        FROM c_out a
        JOIN c_org c ON c.org_id = a.org_id
        JOIN c_mem m ON m.org_id = a.org_id AND m.user_id = a.user_id
        JOIN c_today t ON t.kind = a.kind AND t.id = a.id AND t.user_id = a.user_id),
    ins AS (
      INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
      SELECT gen_random_uuid()::text, d.org_id, d.kind, d.id, 'user', d.user_id,
             CASE d.want WHEN 2 THEN 'edit' WHEN 1 THEN 'readonly' ELSE 'denied' END, 0
        FROM diff d
       WHERE d.got IS DISTINCT FROM d.want
         -- the decided gain: owners and admins of a never-shared vault can edit everything
         AND NOT (d.posture = 'never' AND d.role IN ('owner', 'admin') AND d.got > d.want)
      ON CONFLICT (resource_type, resource_id, principal_type, principal_id) DO NOTHING
      RETURNING id, org_id, resource_type, resource_id, principal_id)
    INSERT INTO access_personal_conversion_rows (organization_id, share_id, action, resource_type, resource_id, principal_type, principal_id)
    SELECT org_id, id, 'inserted', resource_type, resource_id, 'user', principal_id FROM ins;
  END LOOP;
END $$;

-- 4. What new people start with.
INSERT INTO organization_access_settings (organization_id, join_default, new_member_level)
SELECT c.org_id, 'private', CASE WHEN c.posture IN ('edit', 'view') THEN c.posture END FROM c_org c
ON CONFLICT (organization_id) DO UPDATE
  SET join_default = 'private',
      new_member_level = coalesce(EXCLUDED.new_member_level, organization_access_settings.new_member_level),
      updated_at = now();
UPDATE org_join_codes j SET access_level = c.posture
  FROM c_org c WHERE j.organization_id = c.org_id AND c.posture IN ('edit', 'view') AND j.access_level IS NULL;

INSERT INTO access_personal_conversion (organization_id, old_posture, old_posture_revision, old_join_default)
SELECT org_id, posture_perm, posture_rev, join_default FROM c_org;

-- New members get no join record any more: they start with their own level
-- (from the invite or the join code) and their groups.
CREATE OR REPLACE FUNCTION initialize_member_access_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;
