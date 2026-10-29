-- SPDX-License-Identifier: Apache-2.0
--
-- Client-held vault keys (W3): a keyed vault's extracted file text is sealed
-- into `search_enc` (JSON {body, vector, tokens}, src/index/sealed-index.ts).
-- Additive only: no plaintext column is dropped, rewritten or nulled here. A
-- keyed write leaves an existing row's plaintext columns as they were; nulling
-- them is a later, separate, reversible step.
ALTER TABLE blob_text ADD COLUMN IF NOT EXISTS search_enc BYTEA;
