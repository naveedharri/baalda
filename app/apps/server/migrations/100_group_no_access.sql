-- SPDX-License-Identifier: Apache-2.0
--
-- Access groups can say No access (2026-11-25). Within ONE group the deepest
-- of its rows on an item's chain decides (permissions/resolver.ts
-- `rowsGroupGrant`), so a group's `denied` row stops only that group's reach
-- from that folder or note down: "Everyone: Can edit, but HR: No access". It
-- never denies anyone else, and two groups still combine highest-wins.
--
-- Ships BEFORE the conversion (101), in its own release: a server that does not
-- know these rules must never serve converted data (see 101).
SET LOCAL lock_timeout = '10s';

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_group_grants_only;
ALTER TABLE shares
  ADD CONSTRAINT shares_group_grants_only CHECK (principal_type <> 'group' OR permission IN ('view', 'edit', 'denied'));

-- The rows migration 101 writes for a converted "Everyone" group stand for the
-- vault's old team posture: a join snapshot skips them like the org grant it
-- replaced. Every other group row gives what it opens, whenever someone joined.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS legacy_team_grant BOOLEAN NOT NULL DEFAULT false;
