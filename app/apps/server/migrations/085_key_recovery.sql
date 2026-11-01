SET LOCAL lock_timeout = '10s';

-- Launch safety net (decided 2026-11-01): while KEY_RECOVERY_PUBLIC_KEY is set,
-- the server keeps one copy of each vault key sealed to that public key. The
-- matching private key never reaches the server (it is kept offline), so these
-- rows alone open nothing. Unsetting the variable stops new copies and deletes
-- every row (crypto/key-recovery.ts).
CREATE TABLE vault_key_recovery (
  vault_id        TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  generation      INT NOT NULL,
  recovery_key_fp TEXT NOT NULL,
  sealed_vk       BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, generation, recovery_key_fp)
);
