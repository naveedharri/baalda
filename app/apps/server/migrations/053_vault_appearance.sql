-- Vault-level appearance that owners/admins set for every member of a vault
-- (theme, automatic colours, content width, text size, line numbers,
-- properties mode). `settings` holds only the keys the owner chose; an absent
-- key means the app default. Validated by src/appearance/schema.ts.
CREATE TABLE IF NOT EXISTS vault_appearance (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
