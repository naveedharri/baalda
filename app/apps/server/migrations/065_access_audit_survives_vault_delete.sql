-- Access history must outlive the vault it describes: deleting a vault used to
-- cascade every `access_audit` row away with the organization. Keep the org id
-- as plain text instead. The trigger already skips rows cascaded by a vault
-- delete (it checks the organization still exists), so no new noise is logged.
SET LOCAL lock_timeout = '10s';

ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_organization_id_fkey;
