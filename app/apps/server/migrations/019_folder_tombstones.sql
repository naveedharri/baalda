-- Folder tombstones: the missing half of inbound structural deletes.
--
-- Notes soft-delete (`notes.deleted_at`), so every client can tell "deleted"
-- from "never seen" and remove its local file. Folders were hard-deleted with
-- ON DELETE CASCADE and left NO trace — so any device still holding the folder
-- locally saw "missing from the server" on its next pull and re-registered it,
-- resurrecting the folder for the whole team. Deleting a folder was
-- structurally impossible to make stick.
--
-- One row per folder in a deleted subtree, keyed by the folder's id (ids are
-- what clients persist in .context/config.json, so an id match is proof the
-- local folder IS the deleted one, not a same-named successor).
CREATE TABLE IF NOT EXISTS folder_tombstones (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folder_tombstones_vault
  ON folder_tombstones (vault_id);
