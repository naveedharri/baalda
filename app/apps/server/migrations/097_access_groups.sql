-- SPDX-License-Identifier: Apache-2.0
--
-- Access groups (Members and access → Groups). A group is a named set of
-- members of ONE vault (organization). Groups only ADD access:
--
--   * a group's grant is a `shares` row with principal_type = 'group' and
--     permission 'view' or 'edit' — never a deny, lock or cap (CHECK below),
--     so no deny/lock/cap query can ever match one;
--   * someone in two groups gets the higher level;
--   * a person's OWN vault level (a per-user row on the vault resource) wins:
--     groups are ignored for that person, see permissions/resolver.ts.
--
-- Membership rows reference `member`, so leaving the vault drops every group
-- membership with no extra gate. Deleting a group deletes its grants (trigger).
SET LOCAL lock_timeout = '10s';

CREATE TABLE access_groups (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  color           TEXT,
  -- "New members" join this group automatically when they join the vault.
  auto_join       BOOLEAN NOT NULL DEFAULT false,
  created_by      TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX access_groups_org_name ON access_groups (organization_id, lower(name));

CREATE TABLE access_group_members (
  group_id        TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  added_by        TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id, organization_id)
    REFERENCES access_groups (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES member ("organizationId", "userId") ON DELETE CASCADE
);
CREATE INDEX access_group_members_user ON access_group_members (organization_id, user_id);

-- Groups chosen when inviting someone; applied when the invitation is accepted.
CREATE TABLE invitation_groups (
  invitation_id TEXT NOT NULL REFERENCES "invitation" ("id") ON DELETE CASCADE,
  group_id      TEXT NOT NULL REFERENCES access_groups (id) ON DELETE CASCADE,
  PRIMARY KEY (invitation_id, group_id)
);

-- Team skills: a group's level for a skill. Groups only add, so there is no
-- 'none' here: no row means the group gives nothing.
CREATE TABLE skill_group_access (
  skill_id  TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  group_id  TEXT NOT NULL REFERENCES access_groups (id) ON DELETE CASCADE,
  level     TEXT NOT NULL CHECK (level IN ('required', 'optional')),
  set_by    TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  set_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, group_id)
);
CREATE INDEX skill_group_access_group ON skill_group_access (group_id);

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_principal_type_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_principal_type_check CHECK (principal_type IN ('user', 'org', 'group'));
ALTER TABLE shares
  ADD CONSTRAINT shares_group_grants_only CHECK (principal_type <> 'group' OR permission IN ('view', 'edit'));
CREATE INDEX IF NOT EXISTS shares_group_principal_idx ON shares (principal_id) WHERE principal_type = 'group';

CREATE FUNCTION drop_access_group_shares() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM shares WHERE principal_type = 'group' AND principal_id = OLD.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER access_groups_drop_shares AFTER DELETE ON access_groups
  FOR EACH ROW EXECUTE FUNCTION drop_access_group_shares();

-- New members join the vault's auto-join groups. The owner creating the vault
-- is not a "new member".
CREATE FUNCTION join_auto_groups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;
  INSERT INTO access_group_members (group_id, organization_id, user_id)
  SELECT g.id, g.organization_id, NEW."userId"
    FROM access_groups g
   WHERE g.organization_id = NEW."organizationId" AND g.auto_join
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_join_auto_groups AFTER INSERT ON member
  FOR EACH ROW EXECUTE FUNCTION join_auto_groups();

-- Access history covers groups and group membership too.
CREATE OR REPLACE FUNCTION record_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior JSONB;
  later JSONB;
  org TEXT;
  entity TEXT;
  actor TEXT := nullif(current_setting('baalda.audit_actor', true), '');
  label TEXT;
BEGIN
  IF TG_TABLE_NAME = 'shares' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('resourceType', OLD.resource_type, 'resourceId', OLD.resource_id,
        'principalType', OLD.principal_type, 'principalId', OLD.principal_id, 'permission', OLD.permission);
      org := OLD.org_id; entity := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('resourceType', NEW.resource_type, 'resourceId', NEW.resource_id,
        'principalType', NEW.principal_type, 'principalId', NEW.principal_id, 'permission', NEW.permission);
      org := NEW.org_id; entity := NEW.id;
      IF TG_OP = 'INSERT' THEN actor := coalesce(actor, NEW.created_by); END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'member' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('userId', OLD."userId", 'role', OLD.role);
      org := OLD."organizationId"; entity := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('userId', NEW."userId", 'role', NEW.role);
      org := NEW."organizationId"; entity := NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'access_groups' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('name', OLD.name, 'autoJoin', OLD.auto_join);
      org := OLD.organization_id; entity := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('name', NEW.name, 'autoJoin', NEW.auto_join);
      org := NEW.organization_id; entity := NEW.id;
      IF TG_OP = 'INSERT' THEN actor := coalesce(actor, NEW.created_by); END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'access_group_members' THEN
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('groupId', OLD.group_id, 'userId', OLD.user_id);
      org := OLD.organization_id; entity := OLD.group_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('groupId', NEW.group_id, 'userId', NEW.user_id);
      org := NEW.organization_id; entity := NEW.group_id;
      IF TG_OP = 'INSERT' THEN actor := coalesce(actor, NEW.added_by); END IF;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      prior := jsonb_build_object('joinDefault', OLD.join_default);
      org := OLD.organization_id; entity := org;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      later := jsonb_build_object('joinDefault', NEW.join_default);
      org := NEW.organization_id; entity := org;
    END IF;
  END IF;
  -- Ignore last-seen/ACL revision bookkeeping and cascades from vault deletion.
  IF prior IS NOT DISTINCT FROM later OR NOT EXISTS (SELECT 1 FROM organization WHERE id = org) THEN
    RETURN NULL;
  END IF;
  SELECT name INTO label FROM "user" WHERE id = actor;
  INSERT INTO access_audit (organization_id, actor_user_id, actor_name, entity_type, entity_id, action, before_state, after_state)
    VALUES (org, actor, label, TG_TABLE_NAME, entity, lower(TG_OP), prior, later);
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_access_groups AFTER INSERT OR UPDATE OR DELETE ON access_groups
  FOR EACH ROW EXECUTE FUNCTION record_access_audit();
CREATE TRIGGER audit_access_group_members AFTER INSERT OR UPDATE OR DELETE ON access_group_members
  FOR EACH ROW EXECUTE FUNCTION record_access_audit();
