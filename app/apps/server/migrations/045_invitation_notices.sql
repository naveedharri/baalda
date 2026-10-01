-- SPDX-License-Identifier: Apache-2.0
--
-- Invitation reminders and expiry notices (#268). Additive only: one new side
-- table, no change to Better Auth's `invitation` table and no row rewrites.
--
-- `src/invitations/sweep.ts` claims a row here BEFORE it acts, so each
-- invitation gets at most one reminder email (`reminder_sent_at`) and at most
-- one "expired unaccepted" Activity notice (`expired_noticed_at`), however many
-- server instances run the sweep. A claim is never cleared: a reminder whose
-- send failed is not retried, because "at most once" is the promise.
--
-- The foreign keys cascade, so a canceled-and-deleted invitation or a deleted
-- vault (organization) takes its notices with it.

-- Bounds only the wait to ACQUIRE the FK locks on `invitation` and
-- `organization`: a long transaction there fails the deploy (which retries)
-- instead of queueing invitation writes behind this statement.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS invitation_notices (
  invitation_id      TEXT PRIMARY KEY REFERENCES invitation (id) ON DELETE CASCADE,
  organization_id    TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  reminder_sent_at   TIMESTAMPTZ,
  expired_noticed_at TIMESTAMPTZ
);

-- `GET /vaults/:id/invitation-expiries` lists one org's expiry notices.
CREATE INDEX IF NOT EXISTS invitation_notices_expired_idx
  ON invitation_notices (organization_id, expired_noticed_at DESC)
  WHERE expired_noticed_at IS NOT NULL;
