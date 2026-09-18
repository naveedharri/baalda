-- Two fixes that both turn "the row is gone" into an answerable fact.

-- ── 1. File tombstones ─────────────────────────────────────────────────────
--
-- The `files` half of migration 019. A note soft-deletes (`notes.deleted_at`),
-- a folder leaves a `folder_tombstones` row — a FILE was hard-deleted and left
-- nothing at all, so `POST /vaults/:id/access-check` could not answer for its
-- id: it resolves only ids with a row in `notes` ∪ `files`. The desktop reads an
-- UNANSWERED id as "no second opinion" and, by its own rule, LEAVES THE WHOLE
-- REVOKED GROUP on disk — so one legitimately deleted binary permanently blocks
-- revocation cleanup on every other device in the vault.
--
-- It is also what separates a deletion from a REVOCATION. Without a tombstone a
-- deleted file simply disappears from a share-only member's readable set, which
-- reads exactly like having been shut out of it — and the revoked branch removes
-- the binary OUTRIGHT, with no `.context/trash` copy.
--
-- Keyed by the file's id (== its doc_id), which is what clients persist, so an
-- id match proves the local file IS the deleted one and not a same-named
-- successor. `path` is carried for diagnostics only.
CREATE TABLE IF NOT EXISTS file_tombstones (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_tombstones_vault
  ON file_tombstones (vault_id);

-- ── 2. Content dedupe is per-DOC for tree files ────────────────────────────
--
-- `blobs_vault_sha_idx` (migration 003) is UNIQUE (vault_id, sha256) with no
-- regard for `doc_id`, so two REGISTERED FILES at different paths holding
-- identical bytes collapsed into ONE row — one `rel_path`, one `doc_id`. Two
-- consequences, both data loss:
--   · the second file never appeared in `GET /vaults/:id/blobs`, so a new device
--     could not materialize it at all;
--   · `DELETE /api/files/:id` on the FIRST file ran `deleteDocBlobs` on the
--     shared row, and the second, still-registered file lost its bytes.
--
-- Split in two. An `attachments/` drop (`doc_id IS NULL`) keeps the old
-- one-row-per-content rule, which is what makes a fresh device settle a vault
-- full of attachments with zero bytes moved. A tree file gets a row of its own
-- per doc. The two rows share a storage OBJECT — keys are content-addressed
-- (`blobs/keys.ts`) — which costs nothing and is safe because the GC now checks
-- for a live row on the key before deleting it (`objectStillReferenced`).
DROP INDEX IF EXISTS blobs_vault_sha_idx;

CREATE UNIQUE INDEX IF NOT EXISTS blobs_vault_sha_attachment_idx
  ON blobs (vault_id, sha256) WHERE doc_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS blobs_vault_sha_doc_idx
  ON blobs (vault_id, sha256, doc_id) WHERE doc_id IS NOT NULL;
