-- A percentage discount's size in basis points (10000 = 100% off), stored so
-- seat previews and the account summary price a percentage discount right.
-- NULL for a fixed discount or none (those keep using amount / list_amount).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS discount_basis_points INTEGER;
