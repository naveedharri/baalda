-- SPDX-License-Identifier: Apache-2.0
--
-- "Sales may raise Sam here" (Folder and Access, decided 2026-11-27). A setting
-- just for a person decides for them over their groups. When a group change is
-- held back by someone's own setting from higher up, "Let Sales decide" saves
-- a mark: at that place and inside it the person gets the higher of their own
-- level and what that group gives. The mark goes with the group membership (so
-- also when the group is deleted or the person leaves the vault) and on Reset.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS access_group_raises (
  group_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL CHECK (resource_type IN ('vault', 'folder', 'file')),
  resource_id     TEXT NOT NULL,
  created_by      TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id, resource_type, resource_id),
  FOREIGN KEY (group_id, user_id) REFERENCES access_group_members (group_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS access_group_raises_user ON access_group_raises (organization_id, user_id);

-- An invite where the inviter picked "Only what's shared" on purpose. An
-- invite with no level, no groups and no such row comes from an app made
-- before 2026-11-27, and gives the vault's old team level
-- (organization_access_settings.new_member_level), as it did before.
CREATE TABLE IF NOT EXISTS invitation_no_level (
  invitation_id TEXT PRIMARY KEY REFERENCES invitation (id) ON DELETE CASCADE
);
