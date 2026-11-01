SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Seamless vault keys: the vault key reaches an invited or code-joining
-- person without a teammate being online. Every row here was produced by a
-- device that proved it holds the vault key (X-Baalda-VK); the server never
-- stores an invite secret, a join secret or a plain key, so no row here (alone
-- or together with any other table) opens a vault.
-- Additive only: new tables and nullable columns, no rewrite, no backfill.

-- B1/B2: per invitation, VK wrapped under the invite secret that travels only
-- in the email link's fragment (`wrapped_vk`), and/or VK sealed straight to the
-- invitee's existing account key (`sealed_vk` + the key it was sealed to).
-- Goes with the invitation (cascade): a secret wrap without its invitation is
-- useless, and the member's own wrap lives in vault_key_wraps once accepted.
CREATE TABLE IF NOT EXISTS invitation_vault_keys (
  invitation_id         TEXT PRIMARY KEY REFERENCES invitation (id) ON DELETE CASCADE,
  vault_id              TEXT NOT NULL,
  generation            INT,
  wrapped_vk            BYTEA,
  created_by_user_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_vk             BYTEA,
  sealed_for_public_key BYTEA,
  sealed_generation     INT,
  sealed_by_user_id     TEXT,
  sealed_at             TIMESTAMPTZ,
  CHECK (wrapped_vk IS NOT NULL OR sealed_vk IS NOT NULL),
  CHECK (wrapped_vk IS NULL OR generation IS NOT NULL),
  CHECK (sealed_vk IS NULL OR (sealed_for_public_key IS NOT NULL AND sealed_generation IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS invitation_vault_keys_vault ON invitation_vault_keys (vault_id);

-- C: VK wrapped under a join code's device secret J. Only sha256(J) is stored
-- (J is 128 random bits, so the hash reveals nothing). Rows belong to one org
-- join code: regenerating or deleting the code deletes them (trigger below).
CREATE TABLE IF NOT EXISTS vault_join_wraps (
  vault_id           TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  secret_hash        TEXT NOT NULL,
  code               TEXT NOT NULL,
  generation         INT NOT NULL,
  wrapped_vk         BYTEA NOT NULL,
  created_by_user_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, secret_hash)
);
CREATE INDEX IF NOT EXISTS vault_join_wraps_code ON vault_join_wraps (code);

CREATE OR REPLACE FUNCTION vault_join_wraps_code_gone() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.code IS DISTINCT FROM OLD.code THEN
    DELETE FROM vault_join_wraps WHERE code = OLD.code;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS org_join_codes_wraps_gone ON org_join_codes;
CREATE TRIGGER org_join_codes_wraps_gone
  AFTER UPDATE OF code OR DELETE ON org_join_codes
  FOR EACH ROW EXECUTE FUNCTION vault_join_wraps_code_gone();

-- F: the account private key wrapped under a password-derived unlock key
-- (derived with the server-only ACCOUNT_KEY_PEPPER, which is never stored).
ALTER TABLE user_keys
  ADD COLUMN IF NOT EXISTS priv_wrapped_password BYTEA,
  ADD COLUMN IF NOT EXISTS password_wrap_at TIMESTAMPTZ;
ALTER TABLE user_key_history
  ADD COLUMN IF NOT EXISTS priv_wrapped_password BYTEA;
