SET LOCAL lock_timeout = '10s';

-- Secrets the server generates for itself when the operator sets none
-- (auth/pepper-boot.ts). Today: the account-key pepper, created only when vault
-- keys are on and ACCOUNT_KEY_PEPPER is unset, so a self-hosted password unlock
-- works out of the box. Kept in the database because a container's own disk
-- does not survive a redeploy; the trade-off (a stolen database includes it)
-- is documented in docs/DEPLOY.md.
CREATE TABLE server_secrets (
  name       TEXT PRIMARY KEY,
  value      BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A one-way fingerprint of each secret in use, never the secret itself. The
-- server refuses to start when the secret it is given no longer matches, which
-- would otherwise break every peppered login without a word.
CREATE TABLE server_secret_fingerprints (
  name        TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
