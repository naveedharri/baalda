-- Vault rename cleanup (pre-launch, no compat window needed): retire the last
-- "workspace" names from the schema. The user-facing entity is a *vault*
-- (= Better Auth organization); these columns/values predate the rename and
-- always held organization ids.

-- Columns that hold an organization id become org_id (NOT vault_id — in blobs,
-- vault_id already references the vaults registry row).
ALTER TABLE shares RENAME COLUMN workspace_id TO org_id;
ALTER TABLE blobs  RENAME COLUMN workspace_id TO org_id;

-- The org-wide grant value becomes 'vault' (a vault-wide grant; resource_id is
-- still the organization id). Drop the old CHECK first — it doesn't allow the
-- new value.
ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_resource_type_check;
UPDATE shares SET resource_type = 'vault' WHERE resource_type = 'workspace';
ALTER TABLE shares
  ADD CONSTRAINT shares_resource_type_check
  CHECK (resource_type IN ('folder', 'file', 'vault'));

-- OAuth consent binding: the row says which vault (org) the MCP tools operate
-- within.
ALTER TABLE mcp_oauth_workspace RENAME TO mcp_oauth_vault;
ALTER INDEX mcp_oauth_workspace_user_idx RENAME TO mcp_oauth_vault_user_idx;
