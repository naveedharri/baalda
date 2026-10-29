-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): a keyed vault's Yjs log is stored sealed
-- (src/crypto/doc-crypto.ts). A row is sealed iff its `*_enc` column is set;
-- the plaintext column is then NULL. Unkeyed vaults keep writing the plaintext
-- column exactly as before, so these columns stay NULL for them.
SET LOCAL lock_timeout = '10s';

ALTER TABLE doc_updates
  ADD COLUMN update_enc BYTEA,
  ALTER COLUMN update DROP NOT NULL;

ALTER TABLE doc_snapshots
  ADD COLUMN snapshot_enc BYTEA,
  ALTER COLUMN snapshot DROP NOT NULL;
