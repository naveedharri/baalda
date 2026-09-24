-- SPDX-License-Identifier: Apache-2.0
--
-- A third version cause: `pre-shrink`, the note's text kept immediately before
-- one update removed most of it (issue #200, `src/versions/shrink-guard.ts`).
ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_cause_check;
ALTER TABLE note_versions
  ADD CONSTRAINT note_versions_cause_check
  CHECK (cause IN ('idle', 'pre-revert', 'pre-shrink'));
