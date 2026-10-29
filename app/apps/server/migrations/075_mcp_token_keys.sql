-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3) for MCP tokens. Additive only; nothing reads or
-- writes these unless BAALDA_VAULT_KEYS is on.
--
-- mcp_token_keys: the vault key (VK) wrapped under a key derived from the
-- token's own secret (src/crypto/token-wrap.ts). The server stores only the
-- token's sha256, so a database copy alone cannot unwrap it.
--
-- mcp_token_allow: a pre-existing token a member's device vouched for with
-- HMAC-SHA256(VK, token_id || token_hash). On that token's next call, with a
-- VK the server can verify, the MAC is checked and the wrap is stored. A row
-- inserted without VK has no valid MAC and never gets a key.
--
-- vault_pending_keys: the vault's future `vk_check`, registered by the
-- converting device BEFORE the vault is keyed. The vault stays plaintext (and
-- MCP unchanged) while pending; the pending check only lets the server verify
-- a presented VK so it can upgrade allow-listed tokens before conversion.
--
-- No foreign keys, on purpose (as 066): a cascade must never destroy key
-- material. Cleanup is explicit (token revoke, vault delete).
CREATE TABLE mcp_token_keys (
  token_id   TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  generation INT NOT NULL,
  wrapped_vk BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, vault_id, generation)
);
CREATE INDEX mcp_token_keys_vault ON mcp_token_keys (vault_id);

CREATE TABLE mcp_token_allow (
  token_id   TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  mac        BYTEA NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, vault_id)
);

-- The same vouching for an existing OAuth grant (`oauthAccessToken` row,
-- hash = sha256 of its refresh token). Consumed by slice 2's OAuth upgrade;
-- until then every grant active in the last 30 days keeps conversion waiting.
CREATE TABLE oauth_grant_allow (
  grant_id   TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  mac        BYTEA NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, vault_id)
);

CREATE TABLE vault_pending_keys (
  vault_id   TEXT PRIMARY KEY,
  vk_check   BYTEA NOT NULL,
  generation INT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
