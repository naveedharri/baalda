-- SPDX-License-Identifier: Apache-2.0
--
-- Seed the new-member default from each vault's CURRENT posture, once.
--
-- Migration 032 gave every organization a `join_default` of 'private' and
-- snapshots each new non-owner member against it. On its own that is a silent
-- behaviour change for vaults that already exist: a team whose posture is
-- Shared has an org-wide `edit` grant on the vault resource written long ago,
-- so it carries `access_revision = 0` — which the snapshot path in
-- `permissions/resolver.ts` ignores for content that predates the join. The
-- next person to accept an invitation to a Shared vault would land on an empty
-- sidebar and have no way to ask for the access the vault already advertises.
--
-- So: read the posture (`resolver.ts vaultBaseline` — the org-principal row on
-- `resource_type = 'vault'`, `resource_id = <organization id>`) and write the
-- matching join default.
--
--   org-wide vault grant 'edit'   -> 'open'      (the Access panel's Shared)
--   org-wide vault grant 'view'   -> 'readonly'  (Read-only)
--   'denied', or no row at all    -> 'private'   (Private / never shared)
--
-- This is a ONE-TIME snapshot of the release boundary, exactly like migration
-- 031. Only organizations that exist right now are touched; vaults created
-- afterwards keep 032's 'private' default, which is the intended product
-- behaviour. The column default and the `member` trigger are deliberately left
-- alone.
--
-- `ON CONFLICT DO NOTHING` is what makes this safe to run against a populated
-- database: an organization that already has a settings row — because 032 ran
-- days ago and somebody has since used the Access panel, or because
-- `ensureSettings` in `permissions/access-management.ts` lazily created one —
-- keeps whatever it says. The seed never overwrites a deliberate choice.
--
-- A row is written for EVERY organization, including the ones that resolve to
-- 'private'. It is semantically identical to leaving them out (the lazy
-- `ensureSettings` insert, and the trigger's own insert, both produce exactly
-- this row: join_default 'private', access_revision 0), and it is preferable
-- because it pins the answer: these vaults are private because that is what
-- their posture said in September 2026, not because they inherited whatever
-- the column default happens to be later on.
--
-- `access_revision` stays at its default of 0, and that is correct rather than
-- merely convenient. The revision only gates the `direct` share lookup —
-- `sharePermission` skips an ORG grant whose `access_revision <=` the one
-- captured at join, so a pre-existing grant cannot re-open pre-join content
-- through that path. The access a seeded default confers travels the other
-- path: `effectivePermission` maps `snapshot.mode` straight to a permission
-- ('open' -> edit, 'readonly' -> view) with no revision comparison at all, and
-- `vault-docs.ts listReadableDocsInVault` likewise unions every pre-join doc
-- into the readable set for any non-private mode. So a seeded 'open' at
-- revision 0 gives a future joiner edit on pre-existing content, which is the
-- whole point. Starting the counter above 0 would only make the first real ACL
-- mutation harder to reason about.
--
-- The unique constraint on (resource_type, resource_id, principal_type,
-- principal_id) already guarantees one org-principal row per vault resource,
-- so this reads exactly what `vaultBaseline` reads. It is written as an
-- aggregate that takes the LEAST open row rather than a scalar subquery
-- anyway: a scalar subquery would ABORT the whole migration if that invariant
-- were ever violated, while this degrades to a more closed answer, and a seed
-- that cannot fail is worth more than one that is marginally tidier.

INSERT INTO organization_access_settings (organization_id, join_default)
SELECT o.id,
       CASE (
         SELECT MIN(
                  CASE s.permission
                    WHEN 'denied' THEN 0
                    WHEN 'view'   THEN 1
                    WHEN 'edit'   THEN 2
                  END
                )
           FROM shares s
          WHERE s.resource_type = 'vault'
            AND s.resource_id = o.id
            AND s.principal_type = 'org'
            AND s.permission IN ('view', 'edit', 'denied')
       )
         WHEN 2 THEN 'open'
         WHEN 1 THEN 'readonly'
         ELSE 'private'
       END
  FROM organization o
ON CONFLICT (organization_id) DO NOTHING;
