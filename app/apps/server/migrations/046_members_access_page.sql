-- SPDX-License-Identifier: Apache-2.0
--
-- Members & access page. Additive only.
--
-- `member.last_seen_at`: stamped (throttled, at most once per 10 minutes per
-- user+vault) when a member's vault channel authenticates or they mint a sync
-- token (`src/members/last-seen.ts`). Snake_case on purpose: Better Auth never
-- reads it, and its own camelCase columns are untouched.
--
-- `invitation_access`: the access an owner/admin chose when inviting someone
-- (`POST /api/orgs/:orgId/invitations`). Applied as a per-user vault row when
-- the invitation is accepted (Better Auth accept hook or the join-code path),
-- then deleted. The FK cascades, so a deleted invitation or vault takes it along.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "member" ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS invitation_access (
  invitation_id TEXT PRIMARY KEY REFERENCES "invitation" ("id") ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('open', 'readonly', 'private')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
