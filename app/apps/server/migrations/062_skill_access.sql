-- SPDX-License-Identifier: Apache-2.0
--
-- Who gets a team skill (docs/SKILLS.md, "Who gets a skill"). The Everyone row
-- is the skill's existing `delivery` (Required / Optional) plus
-- `everyone_access`: 'none' hides the skill from everyone without their own
-- row. A person's own row in `skill_member_access` beats the Everyone row
-- either way (Required, Optional or No access), like the vault's per-person
-- access. Owners and admins always SEE every skill to manage it; their own
-- effective level still decides what installs on their computer.
-- Existing skills keep today's behaviour: everyone, at their delivery.
ALTER TABLE skills
  ADD COLUMN everyone_access TEXT NOT NULL DEFAULT 'on' CHECK (everyone_access IN ('on', 'none'));

CREATE TABLE skill_member_access (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  level     TEXT NOT NULL CHECK (level IN ('required', 'optional', 'none')),
  set_by    TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  set_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);
CREATE INDEX skill_member_access_user ON skill_member_access (user_id);
