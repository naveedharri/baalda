-- In-app messages (docs/MESSAGES.md): operator-authored popups, banners and
-- toasts, targeted by audience and an optional server-side condition. The spec
-- is stored whole and validated on every admin write (src/messages/spec.ts).
CREATE TABLE app_messages (
  id          TEXT PRIMARY KEY,
  spec        JSONB NOT NULL,
  priority    INT NOT NULL DEFAULT 0,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_messages_live ON app_messages (priority DESC, created_at) WHERE archived_at IS NULL;

-- One person's history with one message; `org_id` is '' for account-wide
-- messages and the vault's org for per-vault ones.
CREATE TABLE app_message_receipts (
  message_id     TEXT NOT NULL REFERENCES app_messages (id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL DEFAULT '',
  first_shown_at TIMESTAMPTZ,
  last_shown_at  TIMESTAMPTZ,
  show_count     INT NOT NULL DEFAULT 0,
  snoozed_until  TIMESTAMPTZ,
  done_at        TIMESTAMPTZ,
  dismissed_at   TIMESTAMPTZ,
  action_id      TEXT,
  PRIMARY KEY (message_id, user_id, org_id)
);
CREATE INDEX app_message_receipts_user ON app_message_receipts (user_id);

-- An owner said they saved (or confirmed they hold) a vault key generation.
-- Feeds the `vault-key-not-saved` condition; a new generation asks again.
CREATE TABLE vault_key_backups (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  generation INT NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('file', 'confirmed')),
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, generation)
);
