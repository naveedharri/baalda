-- SPDX-License-Identifier: Apache-2.0
--
-- A record of each time the shrink burst brake held someone's writes (#252).
--
-- The hold itself stays in memory (`src/versions/shrink-guard.ts`); this table
-- only lets the vault's owners/admins see it in Activity ("sync paused for a
-- member", when, how many notes) and release it early, and lets the member see
-- their own. A restart that forgets a hold leaves its row reading as held until
-- `held_until`; releasing such a row is a harmless no-op on the sync path.
--
-- Additive only: a new, empty table and its index. No existing row is touched.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS shrink_brake_events (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  note_count   INTEGER NOT NULL,
  engaged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  held_until   TIMESTAMPTZ NOT NULL,
  released_at  TIMESTAMPTZ,
  released_by  TEXT
);
CREATE INDEX IF NOT EXISTS shrink_brake_events_vault_idx
  ON shrink_brake_events (vault_id, engaged_at DESC);
