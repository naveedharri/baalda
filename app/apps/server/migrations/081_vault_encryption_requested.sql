-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): opt-in for EXISTING vaults. A desktop may key a
-- vault only once `encryption_requested_at` is set. New vaults created while
-- BAALDA_VAULT_KEYS is on get it at creation (POST /api/vaults); an existing
-- vault gets it only when an owner/admin clicks "Encrypt this vault"
-- (POST /api/vaults/:vaultId/keys/request-encryption). One-way: nothing clears
-- it. Additive only: nullable columns, no rewrite, no backfill.
SET LOCAL lock_timeout = '10s';

ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS encryption_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS encryption_requested_by TEXT NULL;
