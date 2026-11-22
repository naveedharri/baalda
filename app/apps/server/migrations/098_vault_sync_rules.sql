-- The vault's sync rules (#401): a gitignore-style list of paths no device in
-- the vault syncs. One row per vault, written by owners/admins; an absent row
-- means no rules (every device behaves exactly as before). `revision` is the
-- optimistic-concurrency counter a PUT must name (`baseRevision`).
-- Validated by src/sync-rules/schema.ts.
CREATE TABLE IF NOT EXISTS vault_sync_rules (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  rules JSONB NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
