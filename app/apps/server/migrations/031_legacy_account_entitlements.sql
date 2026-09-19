-- SPDX-License-Identifier: Apache-2.0
--
-- Preserve the free-tier benefits accounts had before the 2026-09 attachment
-- sync / vault-limit change. This migration is the release boundary: every
-- user present when it runs receives the legacy benefits, while accounts
-- created afterward have no row and use the current product defaults.

CREATE TABLE account_entitlements (
  user_id                TEXT PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  free_vault_limit       INTEGER NOT NULL CHECK (free_vault_limit >= 0),
  attachment_sync        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO account_entitlements (user_id, free_vault_limit, attachment_sync)
SELECT id, 3, TRUE
FROM "user";
