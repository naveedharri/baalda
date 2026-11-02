SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- An allow-listed OAuth grant keeps its claim to the vault key across refreshes
-- made while no member's key is held. Additive only: one new table.
--
-- The connector refreshes about hourly. Without this, a refresh while nobody
-- had Baalda open gave the new row neither a key nor an allow-list entry (the
-- allow MAC is per grant and only a VK holder can make one), and the
-- connection needed a reconnect. A carry row copies the ROOT grant's allow
-- entry (id, refresh-token hash, VK-keyed MAC — useless without the key) and
-- holds the root's refresh token sealed under THIS row's refresh token. Only
-- the client that held the root token can have produced it, so a row inserted
-- into the database still never gets a key. Sealed under the refresh token
-- only, never the access token: an hour-long access token must not yield a
-- refresh token that lasts a week.
CREATE TABLE oauth_grant_carry (
  grant_id             TEXT NOT NULL REFERENCES "oauthAccessToken" (id) ON DELETE CASCADE,
  vault_id             TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  root_grant_id        TEXT NOT NULL,
  root_refresh_hash    TEXT NOT NULL,
  root_mac             BYTEA NOT NULL,
  wrapped_root_refresh BYTEA NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, vault_id)
);
