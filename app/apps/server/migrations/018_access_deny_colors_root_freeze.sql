-- Three small, independent schema additions.
--
-- 1. `denied` shares — a per-member DENY that actually takes access AWAY.
--    Until now the only way to narrow someone was `locked`, which caps at
--    `view`; there was no way to say "this folder is not for you". A `denied`
--    row is resolved after every allow rule and wins over all of them
--    (including the vault-wide Open grant and the creator escape hatch), so it
--    is the per-member counterpart of the vault's Private posture.
--    principal_type is always 'user': denying the whole org is what removing
--    the org grant already means.
--
-- 2. Item colors move server-side. They were a localStorage preference keyed by
--    path, so a folder tinted on one machine was grey everywhere else. Keyed by
--    id (not path) they survive renames and moves like every other fact here.
--
-- 3. `root_frozen` — an owner/admin latch that stops anything new being created
--    at the vault root once its top-level shape is settled.

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_permission_check;
ALTER TABLE shares
  ADD CONSTRAINT shares_permission_check
  CHECK (permission IN ('view', 'edit', 'locked', 'denied'));

ALTER TABLE folders ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE notes   ADD COLUMN IF NOT EXISTS color TEXT;

ALTER TABLE vaults ADD COLUMN IF NOT EXISTS root_frozen BOOLEAN NOT NULL DEFAULT false;
