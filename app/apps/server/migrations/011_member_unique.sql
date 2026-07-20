-- One membership row per (organization, user).
--
-- The `member` table shipped with only two separate non-unique indexes
-- (001_better_auth.sql), so a user could accumulate several membership rows for
-- the same org. That happens because the two join paths don't share a guard:
-- POST /api/orgs/join checks orgRole() and skips the insert if already a member,
-- but Better Auth's accept-invitation calls createMember unconditionally. Joining
-- one org via both an invitation and a join code therefore produced two rows, and
-- the workspace switcher listed the same org twice (see issue #14).

-- 1) Dedupe existing rows: keep the earliest membership per (org, user), drop the
--    rest (earliest createdAt wins; id breaks ties).
DELETE FROM "member" m
USING "member" keep
WHERE m."organizationId" = keep."organizationId"
  AND m."userId" = keep."userId"
  AND (keep."createdAt" < m."createdAt"
       OR (keep."createdAt" = m."createdAt" AND keep."id" < m."id"));

-- 2) Enforce it going forward. A duplicate createMember now fails loudly instead
--    of silently forking the membership.
CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_uidx"
  ON "member" ("organizationId", "userId");
