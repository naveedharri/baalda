-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): the owner's review at conversion. When an
-- owner/admin converts an EXISTING vault, the desktop lists every MCP token,
-- Claude/ChatGPT connection and public link the server knows and lets them
-- uncheck any. An unchecked one is recorded here: it is never allow-listed,
-- so it cannot pick up the vault key and needs reconnecting after conversion,
-- and the conversion gate (`conversionBlockers`) no longer waits for it.
-- Nothing is revoked: until the vault is keyed it keeps working exactly as
-- before, and allow-listing it again (re-checking it) deletes the row.
-- Additive only: a new table, no rewrite, no backfill.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS vault_conversion_exclusions (
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('mcp_token', 'oauth_grant', 'public_link')),
  item_id    TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, kind, item_id)
);
