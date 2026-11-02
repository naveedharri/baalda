SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Conversion no longer waits on the one computer that started it.
-- Additive only: two new tables, no rewrite, no backfill.

-- The pending vault key, sealed by a device that holds it (X-Baalda-VK checked
-- against the pending check) to another owner/admin's account key, so any
-- owner/admin's open app keeps the conversion going. Like vault_key_wraps: a
-- sealed box to an account public key, never a plain key. Deleted at keys/init.
CREATE TABLE vault_pending_key_shares (
  vault_id          TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  sealed_vk         BYTEA NOT NULL,
  sealed_by_user_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, user_id)
);

-- OAuth rows whose refresh token was exchanged for a newer pair. Better Auth
-- leaves the old refresh token valid until it expires; the conversion gate no
-- longer waits for a row an hour after it was replaced.
CREATE TABLE oauth_grant_consumed (
  grant_id    TEXT PRIMARY KEY REFERENCES "oauthAccessToken" (id) ON DELETE CASCADE,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
