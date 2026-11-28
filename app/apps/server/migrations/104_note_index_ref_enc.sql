SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Keyed vaults: a note's attachment reference excerpt, sealed (the twin of the
-- plaintext `ref_text`, migration 063). Without it the scoped attachment list
-- opened every readable note's whole sealed search row on every request: a
-- 14k-note vault read ~400 MB per list and ran into the statement timeout, and
-- the desktop retried every few seconds. Same key, same envelope, its own
-- column in the AAD. Additive; rows fill in as they are indexed or listed.
ALTER TABLE note_index ADD COLUMN ref_enc BYTEA;

-- An excerpt is only ever true of the body it was cut from. Any write that
-- replaces `search_enc` without writing a new `ref_enc` in the same statement
-- (the conversion backfill, an older writer) drops the old excerpt, so the
-- list reads the body instead of trusting a stale cut.
CREATE OR REPLACE FUNCTION note_index_ref_enc_follows_body() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.search_enc IS DISTINCT FROM OLD.search_enc
     AND NEW.ref_enc IS NOT DISTINCT FROM OLD.ref_enc THEN
    NEW.ref_enc := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS note_index_ref_enc_follows_body ON note_index;
CREATE TRIGGER note_index_ref_enc_follows_body
  BEFORE UPDATE OF search_enc ON note_index
  FOR EACH ROW EXECUTE FUNCTION note_index_ref_enc_follows_body();
