-- Attachments a deleted note leaves behind (#408 follow-up, "deleted means deleted").
--
-- When a deleted note is purged, the attachments/ drops it embedded and no
-- live note still references are removed. A purge records them here first,
-- because the removal waits until the vault's reference table (blob_refs) is
-- known to be complete: version 2 of the extractor reads wiki embeds, and every
-- note indexed before it has to be re-indexed (keyed vaults can only do that
-- while a member's key is held).
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS blob_refs_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS attachment_cleanup (
  vault_id  text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  rel_path  text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, rel_path)
);
