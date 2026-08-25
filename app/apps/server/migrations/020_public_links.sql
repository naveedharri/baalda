-- Public read-only note links (`GET /p/:token`). Revoke = DELETE the row (the
-- shares/mcp_tokens pattern: access dies immediately, nothing soft). The token
-- is stored plaintext ON PURPOSE: repeated "copy public link" must hand back
-- the SAME url (a hash can't reproduce it), and the token gates read-only
-- access to exactly one note whose plaintext already sits in this database
-- (doc_updates/note_index) — hashing it would protect nothing an attacker with
-- DB read doesn't already have. One active link per note (doc_id UNIQUE);
-- re-creating after a revoke mints a NEW token, so dead urls stay dead.
CREATE TABLE public_links (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL UNIQUE REFERENCES notes (id) ON DELETE CASCADE,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  -- 24 random bytes, base64url (192 bits / 32 chars): entropy IS the
  -- enumeration defense; there is deliberately no per-IP limiter here.
  token      TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX public_links_vault_idx ON public_links (vault_id);
