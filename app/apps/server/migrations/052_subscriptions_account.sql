-- Subscriptions belong to a billing account (051), not to one vault.
--
-- Expanded IN PLACE so code still running the old `ON CONFLICT
-- (organization_id)` keeps working through the pre-deploy window:
--  * a surrogate primary key `id` replaces `organization_id` as the key;
--  * `organization_id` stays UNIQUE (the old conflict target) but becomes
--    nullable, since an account-level subscription need not name a vault;
--  * a BEFORE INSERT trigger fills `id` for writers that do not know it.
-- Everything is guarded so the file is safe to run twice.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_account_id TEXT
  REFERENCES billing_accounts (id) ON DELETE SET NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats INT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS list_amount INT;   -- before discount, minor units
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS discount_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS discount_name TEXT;

-- The provider subscription id is the natural key. A provider id held by more
-- than one row (a canceled row for an old vault may linger with the same id)
-- goes to the most recently written row; the others key on their vault.
UPDATE subscriptions s
   SET id = CASE WHEN s.provider_subscription_id IS NOT NULL AND r.rn = 1
                 THEN s.provider_subscription_id
                 ELSE 'legacy:' || s.organization_id END
  FROM (
    SELECT organization_id,
           row_number() OVER (PARTITION BY provider_subscription_id
                              ORDER BY updated_at DESC, organization_id) AS rn
      FROM subscriptions
  ) r
 WHERE r.organization_id = s.organization_id
   AND s.id IS NULL;

-- Fill `id` on insert for writers that predate it (and tests that never name
-- it). Same rule as the backfill: the provider id unless another row holds it.
CREATE OR REPLACE FUNCTION subscriptions_fill_id() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL THEN
    IF NEW.provider_subscription_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE id = NEW.provider_subscription_id) THEN
      NEW.id := NEW.provider_subscription_id;
    ELSE
      NEW.id := 'legacy:' || COALESCE(NEW.organization_id, md5(random()::text || clock_timestamp()::text));
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscriptions_fill_id ON subscriptions;
CREATE TRIGGER subscriptions_fill_id BEFORE INSERT ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_fill_id();

-- Move the primary key from organization_id to id.
DO $$
DECLARE
  pk_cols text;
BEGIN
  SELECT string_agg(a.attname, ',') INTO pk_cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'subscriptions'::regclass AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM 'id' THEN
    IF pk_cols IS NOT NULL THEN
      EXECUTE (SELECT format('ALTER TABLE subscriptions DROP CONSTRAINT %I', conname)
                 FROM pg_constraint
                WHERE conrelid = 'subscriptions'::regclass AND contype = 'p');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'subscriptions'::regclass
                      AND conname = 'subscriptions_organization_id_key') THEN
      ALTER TABLE subscriptions
        ADD CONSTRAINT subscriptions_organization_id_key UNIQUE (organization_id);
    END IF;
    ALTER TABLE subscriptions ALTER COLUMN organization_id DROP NOT NULL;
    ALTER TABLE subscriptions ALTER COLUMN id SET NOT NULL;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
  END IF;
END
$$;

-- One row per provider subscription from here on. Skipped (with a notice)
-- if lingering duplicates exist; the store resolves by provider id either way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM subscriptions WHERE provider_subscription_id IS NOT NULL
     GROUP BY provider_subscription_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_sub_uniq
      ON subscriptions (provider_subscription_id)
      WHERE provider_subscription_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'subscriptions: duplicate provider_subscription_id rows, unique index skipped';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS subscriptions_account_idx ON subscriptions (billing_account_id);

-- Attach: live rows through the vault's account...
UPDATE subscriptions s
   SET billing_account_id = bao.billing_account_id
  FROM billing_account_orgs bao
 WHERE bao.organization_id = s.organization_id
   AND s.billing_account_id IS NULL;

-- ...tombstones (vault gone) through the recorded owner, creating the account
-- if that owner no longer owns anything. A vanished owner stays NULL.
INSERT INTO billing_accounts (id, owner_user_id)
SELECT DISTINCT 'ba_' || md5(s.owner_user_id), s.owner_user_id
  FROM subscriptions s
  JOIN "user" u ON u.id = s.owner_user_id
 WHERE s.billing_account_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE subscriptions s
   SET billing_account_id = a.id
  FROM billing_accounts a
 WHERE a.owner_user_id = s.owner_user_id
   AND s.billing_account_id IS NULL;
