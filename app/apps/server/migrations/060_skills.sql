-- SPDX-License-Identifier: Apache-2.0
--
-- Team AI skills (docs/SKILLS.md). A vault (organization) holds a catalog of
-- skills; each skill has ONE server-side draft (`skill_draft_files`) that
-- owners/admins publish into immutable, numbered versions
-- (`skill_versions` + `skill_version_files`). File bytes live here as bytea,
-- never in blobs or vault notes. Soft delete keeps versions and files (no
-- purge in v1) and frees the name.
-- `skill_sources` lists the GitHub marketplaces admins import skills from; the
-- server never calls GitHub, the desktop fetches.
CREATE TABLE skills (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  delivery         TEXT NOT NULL DEFAULT 'optional' CHECK (delivery IN ('required','optional')),
  pinned_version   INTEGER,
  latest_version   INTEGER,
  draft_revision   INTEGER NOT NULL DEFAULT 1,
  draft_description TEXT NOT NULL DEFAULT '',
  draft_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  draft_updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  -- Where an imported skill came from (a GitHub marketplace): `{repo, ref,
  -- path, commitSha, treeSha, pluginName?}`, validated by skills/validate.ts.
  -- Null for skills made in Baalda.
  source           JSONB
);
CREATE UNIQUE INDEX skills_org_name_live ON skills (organization_id, name) WHERE deleted_at IS NULL;
CREATE INDEX skills_org_live ON skills (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE skill_versions (
  id             TEXT PRIMARY KEY,
  skill_id       TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version >= 1),
  bundle_sha256  TEXT NOT NULL,
  description    TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  file_count     INTEGER NOT NULL,
  total_bytes    INTEGER NOT NULL,
  published_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_version_files (
  version_id  TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  executable  BOOLEAN NOT NULL DEFAULT false,
  content     BYTEA NOT NULL,
  PRIMARY KEY (version_id, path)
);

CREATE TABLE skill_draft_files (
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  executable  BOOLEAN NOT NULL DEFAULT false,
  content     BYTEA NOT NULL,
  PRIMARY KEY (skill_id, path)
);
CREATE UNIQUE INDEX skill_draft_files_ci ON skill_draft_files (skill_id, lower(path));
CREATE UNIQUE INDEX skill_version_files_ci ON skill_version_files (version_id, lower(path));

CREATE TABLE skill_sources (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  repo      TEXT NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  ref       TEXT,
  label     TEXT,
  added_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX skill_sources_org_repo_ref ON skill_sources (org_id, lower(repo), coalesce(ref, ''));
