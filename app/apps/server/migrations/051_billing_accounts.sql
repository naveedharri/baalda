-- Billing accounts: one per paying person, every vault they own attached.
--
-- Until now a subscription belonged to one vault (organization). Team billing
-- moves the money to the PERSON: one billing account per owner, every vault
-- they own attached through `billing_account_orgs`, and one seat-based Team
-- subscription per account (migration 052 points `subscriptions` here).
--
-- Better Auth owns `organization`, so the attachment lives in our own table
-- instead of a column on theirs. Everything below is idempotent: the backfill
-- can run again without moving an org or overwriting a limit already set.

CREATE TABLE IF NOT EXISTS billing_accounts (
  id                   TEXT PRIMARY KEY,               -- 'ba_' || md5(owner_user_id)
  owner_user_id        TEXT NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE RESTRICT,
  provider_customer_id TEXT,
  seats_pending        INT,                            -- a seat change waiting on the provider
  seats_pending_at     TIMESTAMPTZ,
  free_people_limit    INT,                            -- NULL = config default
  free_synced_vaults   INT,                            -- NULL = config default
  plan_override        TEXT CHECK (plan_override IN ('team')),
  complimentary_until  TIMESTAMPTZ,
  override_reason      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_account_orgs (
  organization_id    TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts (id) ON DELETE RESTRICT,
  attached_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attached_by        TEXT
);

CREATE INDEX IF NOT EXISTS billing_account_orgs_account_idx
  ON billing_account_orgs (billing_account_id);

-- 1. One account for every user who owns at least one vault.
INSERT INTO billing_accounts (id, owner_user_id)
SELECT DISTINCT 'ba_' || md5(m."userId"), m."userId"
  FROM member m
 WHERE m.role = 'owner'
ON CONFLICT DO NOTHING;

-- 2. Each vault goes to the account of its EARLIEST owner.
INSERT INTO billing_account_orgs (organization_id, billing_account_id)
SELECT DISTINCT ON (m."organizationId") m."organizationId", 'ba_' || md5(m."userId")
  FROM member m
 WHERE m.role = 'owner'
 ORDER BY m."organizationId", m."createdAt", m.id
ON CONFLICT DO NOTHING;

-- 3. Grandfather today's free teams: an account whose vaults already hold
--    more than 2 distinct people keeps that many.
UPDATE billing_accounts a
   SET free_people_limit = p.people, updated_at = now()
  FROM (
    SELECT bao.billing_account_id, count(DISTINCT m."userId")::int AS people
      FROM billing_account_orgs bao
      JOIN member m ON m."organizationId" = bao.organization_id
     GROUP BY bao.billing_account_id
  ) p
 WHERE p.billing_account_id = a.id
   AND p.people > 2
   AND a.free_people_limit IS NULL;

-- 4. ...and an owner with more than one vault keeps them all synced.
UPDATE billing_accounts a
   SET free_synced_vaults = v.vaults, updated_at = now()
  FROM (
    SELECT billing_account_id, count(*)::int AS vaults
      FROM billing_account_orgs
     GROUP BY billing_account_id
  ) v
 WHERE v.billing_account_id = a.id
   AND v.vaults > 1
   AND a.free_synced_vaults IS NULL;
