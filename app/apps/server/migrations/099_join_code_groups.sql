-- Access groups a join code adds people to (like the groups picked on an
-- email invitation, invitation_groups in 097). One set per vault, because a
-- vault has one join code. Applied in POST /api/orgs/join to a joiner who has
-- no live invitation (an invited person gets what their invitation says).
CREATE TABLE IF NOT EXISTS join_code_groups (
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  group_id        TEXT NOT NULL REFERENCES access_groups (id) ON DELETE CASCADE,
  set_by          TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, group_id)
);
