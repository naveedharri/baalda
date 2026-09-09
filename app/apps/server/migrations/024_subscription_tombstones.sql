-- A subscription must OUTLIVE the vault it paid for (#109, #111).
--
-- Migration 010 made `subscriptions.organization_id` a primary key with
-- `REFERENCES organization (id) ON DELETE CASCADE`. Deleting a vault therefore
-- erased every trace of its subscription while Polar happily kept charging:
--
--  1. `DELETE /api/orgs/:orgId` asked Polar to cancel *best-effort* — a provider
--     outage only logged, the vault was deleted anyway, and the row that named
--     the live subscription vanished with it. Nothing could ever retry, and no
--     screen could tell the owner they were still paying.
--  2. Every later Polar webhook for that subscription hit the FK on insert, the
--     transaction rolled back (undoing the `billing_events` idempotency claim
--     with it), the route 500'd, and Polar retried the same event forever.
--
-- So the FK goes and the row becomes a **tombstone**: `deleted_at` marks that
-- the org is gone, `org_name` keeps a display name for a vault we can no longer
-- read one from, and `owner_user_id` records who may still manage or transfer
-- it once the `member` rows have cascaded away. There is deliberately NO FK on
-- `owner_user_id` either — a tombstone must survive anything, and account
-- deletion silently nulling it would strand the subscription again.
--
-- `interval` / `amount` / `currency` come along in the same pass: every
-- provider mutation now returns Polar's authoritative snapshot and we persist
-- all of it, so "Subscriptions" can show a real price without a provider round
-- trip on the request path (the rule from 010: our Postgres answers "is this
-- vault paid", never the network).

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_organization_id_fkey;

ALTER TABLE subscriptions
  ADD COLUMN deleted_at    TIMESTAMPTZ,  -- when the vault (org) was deleted; NULL = org alive
  ADD COLUMN org_name      TEXT,         -- display snapshot, kept current on write while the org lives
  ADD COLUMN owner_user_id TEXT,         -- who may manage/transfer once the org row is gone (no FK on purpose)
  ADD COLUMN interval      TEXT,         -- 'month' | 'year'
  ADD COLUMN amount        INTEGER,      -- minor units, from the provider
  ADD COLUMN currency      TEXT;

-- Backfill the two display/authority columns for rows that predate this.
UPDATE subscriptions s SET org_name = o.name FROM organization o WHERE o.id = s.organization_id;
UPDATE subscriptions s SET owner_user_id = m."userId" FROM member m
 WHERE m."organizationId" = s.organization_id AND m.role = 'owner' AND s.owner_user_id IS NULL;

-- Webhooks now resolve the row by provider subscription id FIRST, so a
-- transferred subscription's events land on the vault that holds it now rather
-- than on whatever `metadata.organization_id` still names.
CREATE INDEX subscriptions_provider_sub_idx ON subscriptions (provider_subscription_id);
-- "Subscriptions from deleted vaults" lists tombstones by their owner.
CREATE INDEX subscriptions_owner_idx ON subscriptions (owner_user_id);
