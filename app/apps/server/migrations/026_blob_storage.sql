-- Attachment storage becomes an adapter: a blob's bytes may live somewhere
-- other than this database, and every read has to know WHERE from the row
-- rather than from the server's current configuration.
--
-- `storage_provider` is that record. It is written at upload time and never
-- rewritten by a config change, so flipping the server back to `postgres`
-- after a period on S3 leaves the S3-era blobs readable instead of orphaning
-- them. `storage_key` is the object's address in a provider that HAS an object
-- namespace; Postgres does not (the bytes are this row's `data` column), which
-- is why it stays NULL for postgres rows and needs no backfill.
--
-- `status` exists for the upload flow PR 2b adds, where the row is created
-- before any byte has moved: a `pending` row holds the (vault, sha256) dedupe
-- slot while the client uploads, and only becomes `ready` once the bytes are
-- verified. Everything that already exists is `ready` by definition.
--
-- `created_by` is who uploaded it (ON DELETE SET NULL — losing the uploader
-- must never take the attachment with it), and `updated_at` is what a
-- lifecycle sweep sorts on.
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'postgres';
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS storage_key      TEXT;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS created_by       TEXT REFERENCES "user" (id) ON DELETE SET NULL;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Provider and status are closed sets. Validated immediately: both columns were
-- just created with a legal default, so every existing row already passes.
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_storage_provider_chk;
ALTER TABLE blobs ADD  CONSTRAINT blobs_storage_provider_chk
  CHECK (storage_provider IN ('postgres', 's3'));

ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_status_chk;
ALTER TABLE blobs ADD  CONSTRAINT blobs_status_chk
  CHECK (status IN ('pending', 'ready'));

-- A blob stored anywhere but this database is unreachable without its key.
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_external_key_chk;
ALTER TABLE blobs ADD  CONSTRAINT blobs_external_key_chk
  CHECK (storage_provider = 'postgres' OR storage_key IS NOT NULL);

-- A postgres blob that says it is ready must actually hold bytes.
--
-- NOT VALID on purpose: this is the one rule an existing deployment can already
-- be breaking. `data` has been nullable since migration 002 and the download
-- route has always had a `data IS NULL -> 404` branch, so a server that has
-- been running for a while may hold rows this refuses. NOT VALID enforces it on
-- every write from here on without failing the migration on history; PR 2c's
-- lifecycle sweep is what cleans the stragglers up, and `VALIDATE CONSTRAINT`
-- can be run after that.
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_ready_data_chk;
ALTER TABLE blobs ADD  CONSTRAINT blobs_ready_data_chk
  CHECK (status <> 'ready' OR storage_provider <> 'postgres' OR data IS NOT NULL) NOT VALID;

-- Pending rows are what a TTL sweep looks for, and there are normally none of
-- them; a partial index keeps that scan proportional to the abandoned uploads
-- rather than to the whole blob store.
CREATE INDEX IF NOT EXISTS blobs_pending_idx ON blobs (created_at) WHERE status = 'pending';

-- The public-link asset route looks a blob up by (vault_id, rel_path) on every
-- image a shared page renders, and had no index for it — only
-- `blobs_vault_sha_idx` on (vault_id, sha256) existed.
CREATE INDEX IF NOT EXISTS blobs_vault_relpath_idx ON blobs (vault_id, rel_path);

COMMENT ON COLUMN blobs.storage_url IS 'dead — superseded by storage_key (026)';
