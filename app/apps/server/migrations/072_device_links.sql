-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): linking a new device to a user's account key.
-- A new device registers its public key (pending); one of the user's own
-- existing devices approves it by wrapping the account private key for it.
-- Additive only, and key material is never deleted: a removed device is
-- marked revoked (its wrap is kept, just no longer served), and a replaced
-- account key moves to `user_key_history`.
CREATE TABLE user_device_registrations (
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  public_key   BYTEA NOT NULL,
  name         TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

ALTER TABLE user_device_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS key_changed_at TIMESTAMPTZ;

CREATE TABLE user_key_history (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               TEXT NOT NULL,
  public_key            BYTEA NOT NULL,
  priv_wrapped_recovery BYTEA,
  created_at            TIMESTAMPTZ NOT NULL,
  replaced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_key_history_user ON user_key_history (user_id);

-- A vault key wrap sealed to a user's PREVIOUS account key, moved aside (not
-- deleted) when a member re-seals the vault key to their new account key.
CREATE TABLE vault_key_wrap_history (
  id                BIGSERIAL PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  generation        INT NOT NULL,
  sealed_vk         BYTEA NOT NULL,
  sealed_by_user_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  replaced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vault_key_wrap_history_user ON vault_key_wrap_history (vault_id, user_id);
