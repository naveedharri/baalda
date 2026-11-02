SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- When the device that claimed a vault's conversion last renewed its claim.
-- A claim not renewed for a few minutes is abandoned (a conversion takes
-- seconds), and another owner/admin may take it over. Additive only; the
-- default fills existing rows without a rewrite.
ALTER TABLE vault_pending_keys ADD COLUMN refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now();
