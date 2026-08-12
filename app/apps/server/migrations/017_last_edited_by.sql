-- Who last EDITED a note's content, stamped server-side from the authenticated
-- editor (a human over sync, or an AI over MCP).
--
-- Separate from updated_at deliberately: updated_at is bumped by renames and
-- moves and is NOT bumped by ordinary human sync edits, so it answers a
-- different question than "who typed in here last, and when".

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS last_edited_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;
