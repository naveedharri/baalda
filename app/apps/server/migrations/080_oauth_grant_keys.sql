-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3) for OAuth connector grants (claude.ai, ChatGPT).
-- Additive only; nothing reads or writes these unless BAALDA_VAULT_KEYS is on.
--
-- oauth_grant_keys: the vault key wrapped under a key derived from the grant's
-- own token (src/mcp/oauth-grant-keys.ts), once under the access token and once
-- under the refresh token, so a refresh with no desktop online can rewrap it
-- for the new pair. "oauthAccessToken" stores only `h1:` hashes of those
-- tokens (lazily, src/mcp/oauth-token-hash.ts), so a database copy cannot
-- unwrap either.
--
-- oauth_consents: a connector consent for a keyed (or converting) vault, which
-- only the user's desktop can finish (security rule 2). The desktop presents
-- VK; the server keeps it in process memory only until the authorization code
-- is exchanged, then wraps it under the new tokens. Nothing here holds a key.
--
-- No foreign keys (as 066/075): a cascade must never destroy key material.
CREATE TABLE oauth_grant_keys (
  grant_id   TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  generation INT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  wrapped_vk BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, vault_id, generation, kind)
);
CREATE INDEX oauth_grant_keys_vault ON oauth_grant_keys (vault_id);

CREATE TABLE oauth_consents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  approved_at     TIMESTAMPTZ,
  consumed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_consents_user_client ON oauth_consents (user_id, client_id, created_at DESC);
