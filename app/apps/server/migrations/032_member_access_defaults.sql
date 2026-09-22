-- SPDX-License-Identifier: Apache-2.0
--
-- Future-member access is a snapshot, not a live organization default. Existing
-- memberships deliberately receive no row and retain their current behaviour.

CREATE TABLE organization_access_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  join_default     TEXT NOT NULL DEFAULT 'private'
                   CHECK (join_default IN ('private', 'readonly', 'open')),
  access_revision  BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE member_access_snapshots (
  organization_id TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('private', 'readonly', 'open')),
  access_revision  BIGINT NOT NULL,
  snapshot_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES member ("organizationId", "userId") ON DELETE CASCADE
);

ALTER TABLE shares
  ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_permission_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_permission_check
  CHECK (permission IN ('view', 'edit', 'locked', 'denied', 'readonly'));

CREATE OR REPLACE FUNCTION initialize_member_access_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  selected_mode TEXT;
  selected_revision BIGINT;
BEGIN
  -- The creator/owner keeps the product's existing full-access semantics. The
  -- setting describes people who join the already-created vault later.
  IF NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  INSERT INTO organization_access_settings (organization_id)
  VALUES (NEW."organizationId")
  ON CONFLICT (organization_id) DO NOTHING;

  SELECT join_default, access_revision
    INTO selected_mode, selected_revision
    FROM organization_access_settings
   WHERE organization_id = NEW."organizationId"
   FOR SHARE;

  INSERT INTO member_access_snapshots
    (organization_id, user_id, mode, access_revision, snapshot_at)
  VALUES
    (NEW."organizationId", NEW."userId", selected_mode, selected_revision, NEW."createdAt")
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER member_access_snapshot_after_insert
AFTER INSERT ON member
FOR EACH ROW
EXECUTE FUNCTION initialize_member_access_snapshot();
