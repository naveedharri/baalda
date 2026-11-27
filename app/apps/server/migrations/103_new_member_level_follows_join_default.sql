-- SPDX-License-Identifier: Apache-2.0
--
-- What new people start with after the switch (101), corrected (2026-11-28).
--
-- 101 gave new members the vault's old TEAM level. Before the switch, someone
-- joining got the vault's New members setting on everything that already
-- existed: "Only what's shared" gave them nothing, "Can view" gave them view,
-- even in a vault whose team could edit. So a vault whose owner kept new
-- people out would, from the switch on, have given every newcomer Can edit
-- everything. New people now start with the LOWER of the two (team level and
-- New members setting): an owner who chose "Only what's shared" for new
-- members keeps exactly that, and invites/join codes then add a level or
-- groups as they choose.
--
-- Only values 101 set and nobody changed since are touched. Existing members
-- are not affected: this is only the starting level of people who join later.
UPDATE organization_access_settings s
   SET new_member_level = CASE coalesce(c.old_join_default, 'private')
                            WHEN 'readonly' THEN 'view'
                            ELSE NULL
                          END,
       updated_at = now()
  FROM access_personal_conversion c
 WHERE c.organization_id = s.organization_id
   AND c.old_posture IN ('edit', 'view')
   AND s.new_member_level = c.old_posture
   AND coalesce(c.old_join_default, 'private') <> 'open';

UPDATE org_join_codes j
   SET access_level = CASE coalesce(c.old_join_default, 'private')
                        WHEN 'readonly' THEN 'view'
                        ELSE NULL
                      END
  FROM access_personal_conversion c
 WHERE c.organization_id = j.organization_id
   AND c.old_posture IN ('edit', 'view')
   AND j.access_level = c.old_posture
   AND coalesce(c.old_join_default, 'private') <> 'open';
