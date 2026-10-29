-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): a keyed vault's search row is sealed into one
-- `search_enc` (JSON {content, vector, tokens} under the vault key, see
-- src/index/sealed-index.ts). Additive only: nothing here drops, rewrites or
-- nulls a plaintext column. A keyed re-index writes `search_enc` and leaves the
-- old plaintext columns as they were; nulling them is a later, separate,
-- reversible step.
SET LOCAL lock_timeout = '10s';

ALTER TABLE note_index ADD COLUMN IF NOT EXISTS search_enc BYTEA;
