-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3), schema only. Nothing reads or writes these
-- unless BAALDA_VAULT_KEYS is on (src/crypto/config.ts); with it off the
-- server behaves exactly as before. The server never stores a vault key (VK):
-- only `vk_check` (a constant sealed under VK) and VK sealed to each member's
-- public key by a member's device.
--
-- No foreign keys on these tables, on purpose: a cascade from `user`, `vaults`
-- or `organization` would silently destroy key material, and a lost wrap can
-- make a vault unreadable. Cleanup is explicit (rotation, account or vault
-- deletion), never a side effect of another table's delete.
ALTER TABLE vaults
  ADD COLUMN vk_check BYTEA,
  ADD COLUMN key_generation INT;

-- A user's long-lived key pair: the public key, and the private key wrapped
-- under their recovery secret (never the plain private key).
CREATE TABLE user_keys (
  user_id               TEXT PRIMARY KEY,
  public_key            BYTEA NOT NULL,
  priv_wrapped_recovery BYTEA,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The user's private key wrapped for one of their devices.
CREATE TABLE user_device_keys (
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  priv_wrapped BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

-- VK of one generation sealed to one member, by a member's device.
CREATE TABLE vault_key_wraps (
  vault_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  generation        INT NOT NULL,
  sealed_vk         BYTEA NOT NULL,
  sealed_by_user_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, user_id, generation)
);
CREATE INDEX vault_key_wraps_user ON vault_key_wraps (user_id);

-- "Please seal VK for me": a member waiting for another member's device. The
-- server only queues; it never seals.
CREATE TABLE vault_key_requests (
  vault_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, user_id)
);

-- Per-vault encryption progress (enabling, rotating) and resumable cursors.
CREATE TABLE vault_crypto_state (
  vault_id   TEXT PRIMARY KEY,
  phase      TEXT NOT NULL,
  generation INT NOT NULL,
  cursors    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
