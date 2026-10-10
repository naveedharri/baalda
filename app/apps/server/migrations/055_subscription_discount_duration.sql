-- How long the subscription's discount lasts: 'once' (first payment only),
-- 'repeating' (for discount_duration_months) or 'forever'. A promo code is
-- often 'once', so the next renewal is charged at list price; the account
-- summary and seat previews use this to price renewals right. NULL = unknown
-- (a row written before this migration, or no discount).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS discount_duration TEXT,
  ADD COLUMN IF NOT EXISTS discount_duration_months INTEGER;
