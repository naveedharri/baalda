-- Notes a keyed vault's indexer had to DEFER (no member held the key). The
-- index catch-up drains exactly these rows when a key arrives, instead of
-- scanning every live note of the vault for staleness on every connect.
CREATE TABLE IF NOT EXISTS index_pending (
  doc_id    TEXT PRIMARY KEY,
  vault_id  TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_pending_vault_idx ON index_pending (vault_id, queued_at);

-- One-time seed: notes of keyed vaults that are already stale (deferred before
-- this queue existed), so none of them is stranded unsearchable.
INSERT INTO index_pending (doc_id, vault_id)
SELECT n.id, n.vault_id
  FROM notes n
  JOIN vaults v ON v.id = n.vault_id AND v.vk_check IS NOT NULL
  LEFT JOIN note_index ni ON ni.doc_id = n.id
 WHERE n.deleted_at IS NULL
   AND (ni.doc_id IS NULL
        OR ni.updated_at < n.updated_at
        OR ni.updated_at < (SELECT max(u.created_at) FROM doc_updates u WHERE u.doc_id = n.id))
ON CONFLICT (doc_id) DO NOTHING;
