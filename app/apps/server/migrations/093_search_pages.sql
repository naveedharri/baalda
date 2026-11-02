SET LOCAL lock_timeout = '10s';
-- SPDX-License-Identifier: Apache-2.0
--
-- Keyed vaults: the ranking data of up to 500 notes (or files) sealed together
-- as one page, so a whole-vault search opens a few dozen pages instead of one
-- score blob per row. Derived and disposable: search uses a row's page only
-- while `stamps` still equals that row's `updated_at`, and the row's own score
-- blob otherwise. `doc_ids` (note doc ids or blob ids) and `stamps` are values
-- the index tables already hold in the clear; the sealed page binds to both.
-- Additive: a new table.
CREATE TABLE search_pages (
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('note', 'file')),
  page_no    INT NOT NULL,
  generation INT NOT NULL,
  doc_ids    TEXT[] NOT NULL,
  stamps     TEXT[] NOT NULL,
  page_enc   BYTEA NOT NULL,
  built_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, kind, page_no)
);
