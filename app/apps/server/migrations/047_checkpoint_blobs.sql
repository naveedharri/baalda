-- SPDX-License-Identifier: Apache-2.0
--
-- Checkpoints pin attachments and tree files. Additive only.
--
-- `vault_checkpoint_blobs`: one row per binary a vault checkpoint saw — a
-- registered tree file (`file_id` = its `files` id) or an `attachments/` drop
-- (`file_id` NULL). No byte copies at capture: blobs are content-addressed, so
-- the row names the bytes by (vault, sha256) and, on S3, by the object key.
--
-- Pins. A blob row can be deleted from many places (a file delete, a new
-- version replacing the old one, the orphan sweep, an org delete). Rather than
-- teach every one of them about checkpoints, the database keeps pinned bytes
-- alive itself:
--   * Postgres store: a BEFORE DELETE trigger on `blobs` moves the bytes of a
--     pinned row into `checkpoint_blob_bytes` (once per vault+sha) — the row is
--     RETIRED, not lost.
--   * S3 store: the object outlives its row because the deletion drain asks
--     `objectStillReferenced` (src/blobs/gc.ts), which now counts a pin.
-- When the last pin of a (vault, sha) goes (checkpoint pruned, vault deleted),
-- an AFTER DELETE trigger drops the retired bytes and re-queues the object for
-- the drain, which checks liveness again before deleting anything.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS vault_checkpoint_blobs (
  checkpoint_id    TEXT   NOT NULL REFERENCES vault_checkpoints (id) ON DELETE CASCADE,
  vault_id         TEXT   NOT NULL,
  rel_path         TEXT   NOT NULL,
  file_id          TEXT   NULL,
  folder_id        TEXT   NULL,
  sha256           TEXT   NOT NULL,
  size             BIGINT NULL,
  mime             TEXT   NULL,
  blob_id          TEXT   NULL,
  storage_provider TEXT   NOT NULL DEFAULT 'postgres',
  storage_key      TEXT   NULL,
  PRIMARY KEY (checkpoint_id, rel_path)
);

CREATE INDEX IF NOT EXISTS vault_checkpoint_blobs_vault_sha_idx
  ON vault_checkpoint_blobs (vault_id, sha256);
CREATE INDEX IF NOT EXISTS vault_checkpoint_blobs_key_idx
  ON vault_checkpoint_blobs (storage_key) WHERE storage_key IS NOT NULL;

-- Retired Postgres-store bytes, kept only while a checkpoint pins them. No FK:
-- rows are written from inside cascades (an org delete removes blobs and
-- checkpoints in one statement) and cleaned up by the pin trigger below.
CREATE TABLE IF NOT EXISTS checkpoint_blob_bytes (
  vault_id   TEXT        NOT NULL,
  sha256     TEXT        NOT NULL,
  size       BIGINT      NULL,
  mime       TEXT        NULL,
  data       BYTEA       NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, sha256)
);
ALTER TABLE checkpoint_blob_bytes ALTER COLUMN data SET STORAGE EXTERNAL;

CREATE OR REPLACE FUNCTION retire_pinned_blob() RETURNS trigger AS $$
BEGIN
  IF OLD.vault_id IS NOT NULL
     AND OLD.sha256 IS NOT NULL
     AND OLD.data IS NOT NULL
     AND coalesce(OLD.storage_provider, 'postgres') = 'postgres'
     AND EXISTS (
       SELECT 1 FROM vault_checkpoint_blobs p
        WHERE p.vault_id = OLD.vault_id AND p.sha256 = OLD.sha256
     )
  THEN
    INSERT INTO checkpoint_blob_bytes (vault_id, sha256, size, mime, data)
    VALUES (OLD.vault_id, OLD.sha256, OLD.size, OLD.mime, OLD.data)
    ON CONFLICT (vault_id, sha256) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blobs_retire_pinned ON blobs;
CREATE TRIGGER blobs_retire_pinned
  BEFORE DELETE ON blobs
  FOR EACH ROW
  EXECUTE FUNCTION retire_pinned_blob();

CREATE OR REPLACE FUNCTION release_checkpoint_blob_pin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault_checkpoint_blobs p
     WHERE p.vault_id = OLD.vault_id AND p.sha256 = OLD.sha256
  ) THEN
    DELETE FROM checkpoint_blob_bytes
     WHERE vault_id = OLD.vault_id AND sha256 = OLD.sha256;
    IF OLD.storage_provider <> 'postgres'
       AND OLD.storage_key IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM blobs b
          WHERE b.vault_id = OLD.vault_id AND b.sha256 = OLD.sha256
            AND b.storage_key = OLD.storage_key
       )
    THEN
      INSERT INTO blob_deletions (provider, storage_key)
      VALUES (OLD.storage_provider, OLD.storage_key);
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_checkpoint_blobs_release ON vault_checkpoint_blobs;
CREATE TRIGGER vault_checkpoint_blobs_release
  AFTER DELETE ON vault_checkpoint_blobs
  FOR EACH ROW
  EXECUTE FUNCTION release_checkpoint_blob_pin();
