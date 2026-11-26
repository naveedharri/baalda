-- SPDX-License-Identifier: Apache-2.0
--
-- Every vault moves to the access model of 2026-11-25, keeping what everyone
-- can read and edit today:
--
--   * Default access is always Only what's shared (the org `denied` row on the
--     vault resource, "sealed"), except in a vault that was never shared, below.
--   * A vault that was Can edit / Can view by default gets an "Everyone" access
--     group with that level on the whole vault, holding every member (owners
--     and admins included) who has no vault level of their own (theirs keeps
--     meaning what it does). Its vault row carries the OLD row's access
--     revision, so a person whose join snapshot hid older notes still does not
--     see them: these rows are marked `legacy_team_grant` (migration 100), the
--     only group rows a snapshot skips. It takes new members automatically
--     (auto_join), so people who join later get what they would get today.
--   * A folder or note hidden from everyone (org `denied`) gets a No access row
--     for the Everyone group too, so the group does not open it. The org rows
--     on items (hidden, read-only, shared) all stay and keep working.
--   * Owners and admins keep exactly what they have in a Can edit / Can view /
--     sealed vault: a level of their own of Can edit everything only where they
--     can already edit everything (a Can edit vault with nothing hidden from the
--     team, no join snapshot of their own); anywhere else they are treated like
--     any member. People made admin
--     from now on start on Can edit everything (`PATCH .../members/:userId`).
--   * A vault that was never shared keeps its members as they are: they keep
--     Can edit on what they create, at the top level too, and see nothing else
--     until it is shared (the resolver's never-shared branch). Its owners and
--     admins get Can edit everything, so they see members' own notes too.
--   * join_default reads private (Only what's shared) everywhere. In a converted
--     vault a new member still gets the join snapshot the OLD New members setting
--     gave (kept in access_model_conversion.old_join_default), so with the
--     Everyone group taking them automatically they get exactly what they would
--     get today: a Private join still hides what existed before they joined. A
--     snapshot that would only repeat what the Everyone group gives (a Can edit
--     vault whose New members were Can edit) is not written, and existing ones
--     are removed (logged in access_model_conversion_snapshots): the resolver's
--     snapshot branch gives its level on its own, so such a snapshot kept the
--     Everyone group's later No access / Can view from reaching that person.
--     Vaults created after this migration write no join snapshot.
--
-- Everything written is logged in access_model_conversion(_rows), so the move
-- can be undone. Nothing is deleted; the old org vault row's permission is
-- changed in place and logged.
--
-- RELEASE ORDER: only in a release AFTER the one carrying 100 and the resolver
-- that reads group rows by depth and skips snapshot-covered group grants. A
-- server that predates them, serving this data during a deploy, would read
-- every converted vault as sealed with no groups and tell desktops their notes
-- were revoked.
SET LOCAL lock_timeout = '10s';


CREATE TABLE IF NOT EXISTS access_model_conversion (
  organization_id     TEXT PRIMARY KEY,
  old_posture         TEXT,
  old_posture_revision BIGINT,
  old_join_default    TEXT,
  everyone_group_id   TEXT,
  converted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_model_conversion_rows (
  organization_id TEXT NOT NULL,
  share_id        TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('inserted', 'updated')),
  old_permission  TEXT,
  PRIMARY KEY (organization_id, share_id)
);
CREATE TABLE IF NOT EXISTS access_model_conversion_snapshots (
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,
  access_revision BIGINT NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

DO $conv$
DECLARE
  o RECORD;
  posture TEXT;
  posture_id TEXT;
  posture_rev BIGINT;
  jd TEXT;
  gid TEXT;
  gname TEXT;
BEGIN
  FOR o IN SELECT id FROM organization ORDER BY id LOOP
    IF EXISTS (SELECT 1 FROM access_model_conversion WHERE organization_id = o.id) THEN
      CONTINUE;
    END IF;
    SELECT s.permission, s.id, s.access_revision INTO posture, posture_id, posture_rev
      FROM shares s
     WHERE s.resource_type = 'vault' AND s.resource_id = o.id
       AND s.principal_type = 'org' AND s.principal_id = o.id
     LIMIT 1;
    SELECT a.join_default INTO jd FROM organization_access_settings a WHERE a.organization_id = o.id;
    gid := NULL;

    -- Owners and admins keep exactly what they have (decided 2026-11-25): Can
    -- edit everything as a level of their own only where they can already edit
    -- everything (a Can edit vault with nothing hidden from the team, and no join
    -- snapshot of their own). Anywhere else they are treated like any member
    -- below. Their own vault rows stay as they are.
    IF posture = 'edit' AND NOT EXISTS (
         SELECT 1 FROM shares s
          WHERE s.org_id = o.id AND s.principal_type = 'org' AND s.principal_id = o.id
            AND s.resource_type IN ('folder', 'file') AND s.permission = 'denied') THEN
      WITH ins AS (
        INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
        SELECT gen_random_uuid()::text, o.id, 'vault', o.id, 'user', m."userId", 'edit', 0
          FROM member m
         WHERE m."organizationId" = o.id AND m.role IN ('owner', 'admin')
           AND NOT EXISTS (
             SELECT 1 FROM member_access_snapshots ms
              WHERE ms.organization_id = o.id AND ms.user_id = m."userId" AND ms.mode <> 'open')
           AND NOT EXISTS (
             SELECT 1 FROM shares s
              WHERE s.resource_type = 'vault' AND s.resource_id = o.id
                AND s.principal_type = 'user' AND s.principal_id = m."userId")
        RETURNING id)
      INSERT INTO access_model_conversion_rows (organization_id, share_id, action)
      SELECT o.id, id, 'inserted' FROM ins;
    END IF;

    IF posture IN ('edit', 'view') THEN
      gname := CASE WHEN EXISTS (SELECT 1 FROM access_groups g WHERE g.organization_id = o.id AND lower(g.name) = 'everyone')
                    THEN 'All members' ELSE 'Everyone' END;
      gid := gen_random_uuid()::text;
      INSERT INTO access_groups (id, organization_id, name, auto_join)
      VALUES (gid, o.id, gname, true);
      INSERT INTO access_group_members (group_id, organization_id, user_id)
      SELECT gid, o.id, m."userId" FROM member m
       WHERE m."organizationId" = o.id
         AND NOT EXISTS (
           SELECT 1 FROM shares s
            WHERE s.resource_type = 'vault' AND s.resource_id = o.id
              AND s.principal_type = 'user' AND s.principal_id = m."userId"
              AND s.permission IN ('edit', 'view', 'readonly', 'denied'));
      WITH ins AS (
        INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision, legacy_team_grant)
        VALUES (gen_random_uuid()::text, o.id, 'vault', o.id, 'group', gid, posture, posture_rev, true)
        RETURNING id)
      INSERT INTO access_model_conversion_rows (organization_id, share_id, action)
      SELECT o.id, id, 'inserted' FROM ins;
      -- What was hidden from everyone stays hidden from the Everyone group.
      WITH ins AS (
        INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision, legacy_team_grant)
        SELECT gen_random_uuid()::text, o.id, s.resource_type, s.resource_id, 'group', gid, 'denied', s.access_revision, true
          FROM shares s
         WHERE s.org_id = o.id AND s.principal_type = 'org' AND s.principal_id = o.id
           AND s.resource_type IN ('folder', 'file') AND s.permission = 'denied'
        ON CONFLICT DO NOTHING
        RETURNING id)
      INSERT INTO access_model_conversion_rows (organization_id, share_id, action)
      SELECT o.id, id, 'inserted' FROM ins;
      -- A snapshot that only repeats what the Everyone group gives goes, so the
      -- group's later rows reach that person (logged for the undo).
      WITH del AS (
        DELETE FROM member_access_snapshots ms
         USING access_group_members gm
         WHERE ms.organization_id = o.id
           AND gm.group_id = gid AND gm.user_id = ms.user_id
           AND posture = 'edit' AND ms.mode = 'open'
        RETURNING ms.organization_id, ms.user_id, ms.mode, ms.access_revision, ms.snapshot_at)
      INSERT INTO access_model_conversion_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
      SELECT organization_id, user_id, mode, access_revision, snapshot_at FROM del;
    END IF;

    IF posture IS NULL THEN
      -- Never shared: members are left as they are. They keep Can edit on what
      -- they create (notes, files, folders, at the top level too) and see
      -- nothing else until it is shared: the resolver's never-shared branch.
      -- Owners and admins get Can edit everything here (decided 2026-11-25:
      -- they see and edit members' own notes), unless they already have a
      -- level of their own.
      WITH ins AS (
        INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
        SELECT gen_random_uuid()::text, o.id, 'vault', o.id, 'user', m."userId", 'edit', 0
          FROM member m
         WHERE m."organizationId" = o.id AND m.role IN ('owner', 'admin')
           AND NOT EXISTS (
             SELECT 1 FROM shares s
              WHERE s.resource_type = 'vault' AND s.resource_id = o.id
                AND s.principal_type = 'user' AND s.principal_id = m."userId")
        RETURNING id)
      INSERT INTO access_model_conversion_rows (organization_id, share_id, action)
      SELECT o.id, id, 'inserted' FROM ins;
    ELSIF posture IN ('edit', 'view') THEN
      INSERT INTO access_model_conversion_rows (organization_id, share_id, action, old_permission)
      VALUES (o.id, posture_id, 'updated', posture);
      UPDATE shares SET permission = 'denied' WHERE id = posture_id;
    END IF;

    INSERT INTO organization_access_settings (organization_id, join_default)
    VALUES (o.id, 'private')
    ON CONFLICT (organization_id) DO UPDATE SET join_default = 'private', updated_at = now();

    INSERT INTO access_model_conversion
      (organization_id, old_posture, old_posture_revision, old_join_default, everyone_group_id)
    VALUES (o.id, posture, posture_rev, jd, gid);
  END LOOP;
END
$conv$;

-- New members: the join snapshot follows the vault's OLD New members setting in
-- a converted vault (see the header), and is not written where it would only
-- repeat the Everyone group, nor in vaults created after this migration.
CREATE OR REPLACE FUNCTION initialize_member_access_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  conv_posture TEXT;
  conv_join TEXT;
  selected_revision BIGINT;
BEGIN
  IF NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  SELECT c.old_posture, coalesce(c.old_join_default, 'private')
    INTO conv_posture, conv_join
    FROM access_model_conversion c
   WHERE c.organization_id = NEW."organizationId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF conv_posture = 'edit' AND conv_join = 'open' THEN
    RETURN NEW;
  END IF;

  INSERT INTO organization_access_settings (organization_id)
  VALUES (NEW."organizationId")
  ON CONFLICT (organization_id) DO NOTHING;

  SELECT access_revision
    INTO selected_revision
    FROM organization_access_settings
   WHERE organization_id = NEW."organizationId"
   FOR SHARE;

  INSERT INTO member_access_snapshots
    (organization_id, user_id, mode, access_revision, snapshot_at)
  VALUES
    (NEW."organizationId", NEW."userId", conv_join, selected_revision, NEW."createdAt")
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;
