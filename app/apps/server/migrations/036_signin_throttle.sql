-- SPDX-License-Identifier: Apache-2.0
--
-- Per-account throttling of failed email/password sign-ins (issue #237).
--
-- Keyed by the lowercased email STRING, never by a user row, so an unknown
-- address is throttled exactly like a real one and the response cannot be used
-- to discover which accounts exist. Postgres-backed so the count survives a
-- restart and is shared by every server instance.
CREATE TABLE IF NOT EXISTS signin_throttle (
  email         TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lockouts      INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
