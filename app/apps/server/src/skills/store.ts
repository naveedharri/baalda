// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "../db/pool.js";
import {
  MAX_NOTES_CHARS,
  MAX_SKILL_SOURCES_PER_ORG,
  MAX_SKILLS_PER_ORG,
  SKILL_MD,
  SkillError,
  bundleSha256,
  checkSkillCaps,
  draftDescription,
  parseSkillFrontmatter,
  sha256Hex,
  type DecodedSkillFile,
} from "./validate.js";
import type {
  ManifestOrg,
  SkillDelivery,
  SkillDetail,
  SkillDraft,
  SkillFile,
  SkillFileMeta,
  SkillOrigin,
  SkillRole,
  SkillSource,
  SkillSummary,
  SkillVersionSummary,
  SkillsManifest,
} from "./types.js";

/**
 * SQL for the team skills catalog (migration 060, docs/SKILLS.md §3). Every
 * function takes an org id the caller already proved membership of; the
 * routes and MCP tools own authentication and the role gate.
 *
 * Draft writes and publish lock the skill row (`FOR UPDATE`) and compare
 * `draft_revision` against the caller's `baseRevision`, so two admins editing
 * the same draft get a 409 instead of silently overwriting each other.
 */

export function asSkillRole(role: string): SkillRole {
  return role === "owner" || role === "admin" ? role : "member";
}
export function isSkillAdmin(role: SkillRole): boolean {
  return role === "owner" || role === "admin";
}

type Person = { id: string; name: string } | null;
function person(id: string | null, name: string | null): Person {
  return id ? { id, name: name ?? "" } : null;
}

type SkillRow = {
  id: string;
  organization_id: string;
  name: string;
  delivery: SkillDelivery;
  pinned_version: number | null;
  latest_version: number | null;
  draft_revision: number;
  draft_description: string;
  created_at: Date;
  updated_at: Date;
  latest_description: string | null;
  latest_bundle: string | null;
  latest_published_at: Date | null;
  latest_published_by: string | null;
  latest_publisher_name: string | null;
  source: SkillOrigin | null;
};

const SKILL_COLUMNS = `s.id, s.organization_id, s.name, s.delivery, s.pinned_version, s.latest_version,
  s.draft_revision, s.draft_description, s.created_at, s.updated_at, s.source,
  lv.description AS latest_description, lv.bundle_sha256 AS latest_bundle,
  lv.published_at AS latest_published_at, lv.published_by AS latest_published_by,
  lu.name AS latest_publisher_name`;
const SKILL_FROM = `skills s
  LEFT JOIN skill_versions lv ON lv.skill_id = s.id AND lv.version = s.latest_version
  LEFT JOIN "user" lu ON lu.id = lv.published_by`;

type MetaRow = { skill_id: string; path: string; sha256: string; size: number; executable: boolean };

/** Draft file metadata for these skills, one query, grouped by skill. */
async function draftMetas(db: pg.Pool | pg.PoolClient, skillIds: string[]): Promise<Map<string, SkillFileMeta[]>> {
  const out = new Map<string, SkillFileMeta[]>();
  if (skillIds.length === 0) return out;
  const { rows } = await db.query<MetaRow>(
    `SELECT skill_id, path, sha256, size, executable FROM skill_draft_files
      WHERE skill_id = ANY($1) ORDER BY path`,
    [skillIds],
  );
  for (const r of rows) {
    const list = out.get(r.skill_id) ?? [];
    list.push({ path: r.path, sha256: r.sha256, size: r.size, executable: r.executable });
    out.set(r.skill_id, list);
  }
  return out;
}

function summary(row: SkillRow, draft: SkillFileMeta[], role: SkillRole): SkillSummary {
  const draftBundle = bundleSha256(draft);
  return {
    id: row.id,
    orgId: row.organization_id,
    name: row.name,
    source: row.source ?? null,
    description: row.latest_description ?? (isSkillAdmin(role) ? row.draft_description : ""),
    delivery: row.delivery,
    pinnedVersion: row.pinned_version,
    latestVersion: row.latest_version,
    latestPublishedBy: person(row.latest_published_by, row.latest_publisher_name),
    latestPublishedAt: row.latest_published_at ? row.latest_published_at.toISOString() : null,
    effectiveVersion: row.pinned_version ?? row.latest_version,
    draftRevision: row.draft_revision,
    draftDiffers: row.latest_bundle === null || row.latest_bundle !== draftBundle,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Live skills of an org; members see only published ones. */
export async function listSkills(orgId: string, role: SkillRole): Promise<SkillSummary[]> {
  const { rows } = await pool.query<SkillRow>(
    `SELECT ${SKILL_COLUMNS} FROM ${SKILL_FROM}
      WHERE s.organization_id = $1 AND s.deleted_at IS NULL
        AND ($2 OR s.latest_version IS NOT NULL)
      ORDER BY s.name`,
    [orgId, isSkillAdmin(role)],
  );
  const metas = await draftMetas(pool, rows.map((r) => r.id));
  return rows.map((r) => summary(r, metas.get(r.id) ?? [], role));
}

/** A live skill of this org, else 404 `skill_not_found` (members: published only). */
async function loadSkill(
  db: pg.Pool | pg.PoolClient,
  orgId: string,
  skillId: string,
  role: SkillRole,
  lock = false,
): Promise<SkillRow> {
  const { rows } = await db.query<SkillRow>(
    `SELECT ${SKILL_COLUMNS} FROM ${SKILL_FROM}
      WHERE s.id = $1 AND s.organization_id = $2 AND s.deleted_at IS NULL
      ${lock ? "FOR UPDATE OF s" : ""}`,
    [skillId, orgId],
  );
  const row = rows[0];
  if (!row || (!isSkillAdmin(role) && row.latest_version === null)) {
    throw new SkillError(404, { error: "skill_not_found" });
  }
  return row;
}

type VersionRow = {
  id: string;
  version: number;
  bundle_sha256: string;
  description: string;
  notes: string;
  file_count: number;
  total_bytes: number;
  published_at: Date;
  published_by: string | null;
  publisher_name: string | null;
};
const VERSION_COLUMNS = `v.id, v.version, v.bundle_sha256, v.description, v.notes, v.file_count,
  v.total_bytes, v.published_at, v.published_by, u.name AS publisher_name`;

function versionSummary(v: VersionRow): SkillVersionSummary {
  return {
    version: v.version,
    bundleSha256: v.bundle_sha256,
    description: v.description,
    notes: v.notes,
    fileCount: v.file_count,
    totalBytes: v.total_bytes,
    publishedAt: v.published_at.toISOString(),
    publishedBy: person(v.published_by, v.publisher_name),
  };
}

export async function getSkillDetail(orgId: string, skillId: string, role: SkillRole): Promise<SkillDetail> {
  const row = await loadSkill(pool, orgId, skillId, role);
  return detail(pool, row, role);
}

async function detail(db: pg.Pool | pg.PoolClient, row: SkillRow, role: SkillRole): Promise<SkillDetail> {
  const { rows: versions } = await db.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM skill_versions v LEFT JOIN "user" u ON u.id = v.published_by
      WHERE v.skill_id = $1 ORDER BY v.version DESC`,
    [row.id],
  );
  const draft = (await draftMetas(db, [row.id])).get(row.id) ?? [];
  return {
    ...summary(row, draft, role),
    versions: versions.map(versionSummary),
    draftFiles: isSkillAdmin(role) ? draft : null,
  };
}

function seedSkillMd(name: string): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n`, "utf8");
}

async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function insertDraftFiles(db: pg.PoolClient, skillId: string, files: DecodedSkillFile[]): Promise<void> {
  if (files.length === 0) return;
  await db.query(
    `INSERT INTO skill_draft_files (skill_id, path, sha256, size, executable, content)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::bool[], $6::bytea[])`,
    [
      skillId,
      files.map((f) => f.path),
      files.map((f) => f.sha256),
      files.map((f) => f.size),
      files.map((f) => f.executable),
      files.map((f) => f.content),
    ],
  );
}

/** #3: create a skill with its draft (seeded SKILL.md when no files). */
export async function createSkill(
  orgId: string,
  userId: string,
  name: string,
  files: DecodedSkillFile[] | undefined,
  source: SkillOrigin | null = null,
): Promise<SkillDetail> {
  const draft = files ?? [
    (() => {
      const content = seedSkillMd(name);
      return { path: SKILL_MD, sha256: sha256Hex(content), size: content.length, executable: false, content };
    })(),
  ];
  checkSkillCaps(draft);
  const skillMd = draft.find((f) => f.path === SKILL_MD)?.content;
  return tx(async (db) => {
    // Serialise creates per org so the 500-skill cap cannot be raced past.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('skills:' || $1))", [orgId]);
    const { rows: count } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM skills WHERE organization_id = $1 AND deleted_at IS NULL",
      [orgId],
    );
    if (count[0].n >= MAX_SKILLS_PER_ORG) throw new SkillError(409, { error: "skill_limit_reached" });
    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO skills (id, organization_id, name, draft_description, draft_updated_by, created_by, source)
         VALUES ($1, $2, $3, $4, $5, $5, $6::jsonb)`,
        [id, orgId, name, draftDescription(skillMd), userId, source === null ? null : JSON.stringify(source)],
      );
    } catch (err) {
      // 23505 on `skills_org_name_live`: a live skill already has this name.
      if ((err as { code?: string })?.code !== "23505") throw err;
      throw new SkillError(409, { error: "skill_name_taken" });
    }
    await insertDraftFiles(db, id, draft);
    return detail(db, await loadSkill(db, orgId, id, "owner"), "owner");
  });
}

/** #5: delivery, pin and/or source. `pinnedVersion: null` unpins; `source: null` unlinks. */
export async function patchSkill(
  orgId: string,
  skillId: string,
  patch: { delivery?: SkillDelivery; pinnedVersion?: number | null; source?: SkillOrigin | null },
): Promise<SkillSummary> {
  return tx(async (db) => {
    await loadSkill(db, orgId, skillId, "owner", true);
    if (typeof patch.pinnedVersion === "number") {
      const { rows } = await db.query(
        "SELECT 1 FROM skill_versions WHERE skill_id = $1 AND version = $2",
        [skillId, patch.pinnedVersion],
      );
      if (!rows[0]) throw new SkillError(400, { error: "unknown_version" });
    }
    await db.query(
      `UPDATE skills SET
         delivery = COALESCE($2, delivery),
         pinned_version = CASE WHEN $3 THEN $4::int ELSE pinned_version END,
         source = CASE WHEN $5 THEN $6::jsonb ELSE source END,
         updated_at = now()
       WHERE id = $1`,
      [
        skillId,
        patch.delivery ?? null,
        patch.pinnedVersion !== undefined,
        patch.pinnedVersion ?? null,
        patch.source !== undefined,
        patch.source ? JSON.stringify(patch.source) : null,
      ],
    );
    const row = await loadSkill(db, orgId, skillId, "owner");
    const metas = await draftMetas(db, [skillId]);
    return summary(row, metas.get(skillId) ?? [], "owner");
  });
}

/** #6: soft delete; versions and files stay, the name is free again. */
export async function softDeleteSkill(orgId: string, skillId: string, userId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE skills SET deleted_at = now(), deleted_by = $3, updated_at = now()
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [skillId, orgId, userId],
  );
  if (!rowCount) throw new SkillError(404, { error: "skill_not_found" });
}

type FileRow = { path: string; sha256: string; size: number; executable: boolean; content: Buffer };

function withContent(r: FileRow): SkillFile {
  return {
    path: r.path,
    sha256: r.sha256,
    size: r.size,
    executable: r.executable,
    contentBase64: r.content.toString("base64"),
  };
}

async function readDraft(db: pg.Pool | pg.PoolClient, skillId: string): Promise<SkillDraft> {
  const { rows: head } = await db.query<{
    draft_revision: number;
    draft_updated_at: Date;
    draft_updated_by: string | null;
    updater_name: string | null;
  }>(
    `SELECT s.draft_revision, s.draft_updated_at, s.draft_updated_by, u.name AS updater_name
       FROM skills s LEFT JOIN "user" u ON u.id = s.draft_updated_by WHERE s.id = $1`,
    [skillId],
  );
  const { rows } = await db.query<FileRow>(
    "SELECT path, sha256, size, executable, content FROM skill_draft_files WHERE skill_id = $1 ORDER BY path",
    [skillId],
  );
  return {
    skillId,
    revision: head[0].draft_revision,
    updatedAt: head[0].draft_updated_at.toISOString(),
    updatedBy: person(head[0].draft_updated_by, head[0].updater_name),
    files: rows.map(withContent),
  };
}

/** #7 */
export async function getDraft(orgId: string, skillId: string): Promise<SkillDraft> {
  await loadSkill(pool, orgId, skillId, "owner");
  return readDraft(pool, skillId);
}

export type DraftWrite =
  | { kind: "replace"; files: DecodedSkillFile[]; source?: SkillOrigin | null }
  | { kind: "patch"; upsert: DecodedSkillFile[]; remove: string[] }
  | { kind: "reset"; version: number };

function checkRevision(row: SkillRow, baseRevision: number): void {
  if (row.draft_revision !== baseRevision) {
    throw new SkillError(409, { error: "stale_draft", revision: row.draft_revision });
  }
}

/**
 * #8/#9/#10: one transaction under the skill row lock. Caps are judged over
 * the RESULTING file set. An upsert whose path matches an existing file
 * case-insensitively replaces it (paths are unique ignoring case); `remove`
 * matches exactly and a missing path is a no-op. A replace may carry the
 * skill's `source` (a marketplace "pull update" records the new commit/tree
 * sha atomically with the content it fetched).
 */
export async function writeDraft(
  orgId: string,
  skillId: string,
  userId: string,
  baseRevision: number,
  write: DraftWrite,
): Promise<SkillDraft> {
  return tx(async (db) => {
    const row = await loadSkill(db, orgId, skillId, "owner", true);
    checkRevision(row, baseRevision);
    if (write.kind === "replace") {
      checkSkillCaps(write.files);
      await db.query("DELETE FROM skill_draft_files WHERE skill_id = $1", [skillId]);
      await insertDraftFiles(db, skillId, write.files);
    } else if (write.kind === "patch") {
      const { rows: current } = await db.query<{ path: string; size: number }>(
        "SELECT path, size FROM skill_draft_files WHERE skill_id = $1",
        [skillId],
      );
      const removed = new Set(write.remove);
      const replaced = new Set(write.upsert.map((f) => f.path.toLowerCase()));
      const kept = current.filter((f) => !removed.has(f.path) && !replaced.has(f.path.toLowerCase()));
      checkSkillCaps([...kept, ...write.upsert]);
      await db.query(
        `DELETE FROM skill_draft_files
          WHERE skill_id = $1 AND (path = ANY($2) OR lower(path) = ANY($3))`,
        [skillId, write.remove, [...replaced]],
      );
      await insertDraftFiles(db, skillId, write.upsert);
    } else {
      const { rows: version } = await db.query<{ id: string }>(
        "SELECT id FROM skill_versions WHERE skill_id = $1 AND version = $2",
        [skillId, write.version],
      );
      if (!version[0]) throw new SkillError(404, { error: "version_not_found" });
      await db.query("DELETE FROM skill_draft_files WHERE skill_id = $1", [skillId]);
      await db.query(
        `INSERT INTO skill_draft_files (skill_id, path, sha256, size, executable, content)
         SELECT $1, path, sha256, size, executable, content FROM skill_version_files WHERE version_id = $2`,
        [skillId, version[0].id],
      );
    }
    const { rows: md } = await db.query<{ content: Buffer }>(
      "SELECT content FROM skill_draft_files WHERE skill_id = $1 AND path = $2",
      [skillId, SKILL_MD],
    );
    const source = write.kind === "replace" ? write.source : undefined;
    await db.query(
      `UPDATE skills SET draft_revision = draft_revision + 1, draft_updated_at = now(),
         draft_updated_by = $2, draft_description = $3, updated_at = now(),
         source = CASE WHEN $4 THEN $5::jsonb ELSE source END
       WHERE id = $1`,
      [skillId, userId, draftDescription(md[0]?.content), source !== undefined, source ? JSON.stringify(source) : null],
    );
    return readDraft(db, skillId);
  });
}

/** #11: freeze the draft into the next numbered version. */
export async function publishSkill(
  orgId: string,
  skillId: string,
  userId: string,
  baseRevision: number,
  notes: string,
): Promise<SkillVersionSummary> {
  if (notes.length > MAX_NOTES_CHARS) throw new SkillError(400, { error: "invalid_notes" });
  return tx(async (db) => {
    const row = await loadSkill(db, orgId, skillId, "owner", true);
    checkRevision(row, baseRevision);
    const { rows: files } = await db.query<MetaRow>(
      "SELECT skill_id, path, sha256, size, executable FROM skill_draft_files WHERE skill_id = $1",
      [skillId],
    );
    if (!files.some((f) => f.path === SKILL_MD)) {
      throw new SkillError(400, { error: "invalid_skill", reason: "missing_skill_md" });
    }
    const { rows: md } = await db.query<{ content: Buffer }>(
      "SELECT content FROM skill_draft_files WHERE skill_id = $1 AND path = $2",
      [skillId, SKILL_MD],
    );
    const fm = parseSkillFrontmatter(md[0].content.toString("utf8"), row.name);
    if (!fm.ok) throw new SkillError(400, { error: "invalid_skill", reason: fm.reason });
    checkSkillCaps(files);
    const bundle = bundleSha256(files);
    if (row.latest_bundle === bundle) throw new SkillError(409, { error: "nothing_to_publish" });
    const version = (row.latest_version ?? 0) + 1;
    const versionId = randomUUID();
    const total = files.reduce((n, f) => n + f.size, 0);
    await db.query(
      `INSERT INTO skill_versions
         (id, skill_id, version, bundle_sha256, description, notes, file_count, total_bytes, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [versionId, skillId, version, bundle, fm.description, notes, files.length, total, userId],
    );
    await db.query(
      `INSERT INTO skill_version_files (version_id, path, sha256, size, executable, content)
       SELECT $1, path, sha256, size, executable, content FROM skill_draft_files WHERE skill_id = $2`,
      [versionId, skillId],
    );
    await db.query("UPDATE skills SET latest_version = $2, updated_at = now() WHERE id = $1", [skillId, version]);
    const { rows: v } = await db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM skill_versions v LEFT JOIN "user" u ON u.id = v.published_by
        WHERE v.id = $1`,
      [versionId],
    );
    return versionSummary(v[0]);
  });
}

/** #12: any published version of a live skill, with content. */
export async function getVersion(
  orgId: string,
  skillId: string,
  version: number,
): Promise<SkillVersionSummary & { files: SkillFile[] }> {
  await loadSkill(pool, orgId, skillId, "member");
  const { rows } = await pool.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM skill_versions v LEFT JOIN "user" u ON u.id = v.published_by
      WHERE v.skill_id = $1 AND v.version = $2`,
    [skillId, version],
  );
  if (!rows[0]) throw new SkillError(404, { error: "version_not_found" });
  const { rows: files } = await pool.query<FileRow>(
    "SELECT path, sha256, size, executable, content FROM skill_version_files WHERE version_id = $1 ORDER BY path",
    [rows[0].id],
  );
  return { ...versionSummary(rows[0]), files: files.map(withContent) };
}

// ---- manifest (#1) ----

/**
 * Every org the user belongs to (even with zero skills) with the effective
 * version of each live skill and its file metadata. Three queries whatever the
 * number of orgs or skills.
 */
export async function skillsManifest(userId: string): Promise<SkillsManifest> {
  const { rows: orgs } = await pool.query<{
    id: string;
    name: string;
    slug: string | null;
    role: string;
  }>(
    `SELECT o.id, o.name, o.slug, m.role
       FROM member m
       JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1
      ORDER BY o.name, o.id`,
    [userId],
  );
  const { rows: skills } = await pool.query<{
    id: string;
    organization_id: string;
    name: string;
    delivery: SkillDelivery;
    version_id: string;
    version: number;
    description: string;
    bundle_sha256: string;
    source: SkillOrigin | null;
  }>(
    `SELECT s.id, s.organization_id, s.name, s.delivery, v.id AS version_id, v.version,
            v.description, v.bundle_sha256, s.source
       FROM skills s
       JOIN member m ON m."organizationId" = s.organization_id AND m."userId" = $1
       JOIN skill_versions v ON v.skill_id = s.id AND v.version = COALESCE(s.pinned_version, s.latest_version)
      WHERE s.deleted_at IS NULL
      ORDER BY s.name`,
    [userId],
  );
  const files = new Map<string, SkillFileMeta[]>();
  if (skills.length > 0) {
    const { rows } = await pool.query<{ version_id: string } & SkillFileMeta>(
      `SELECT version_id, path, sha256, size, executable FROM skill_version_files
        WHERE version_id = ANY($1) ORDER BY path`,
      [skills.map((s) => s.version_id)],
    );
    for (const r of rows) {
      const list = files.get(r.version_id) ?? [];
      list.push({ path: r.path, sha256: r.sha256, size: r.size, executable: r.executable });
      files.set(r.version_id, list);
    }
  }
  const byOrg = new Map<string, ManifestOrg>();
  const out: ManifestOrg[] = orgs.map((o) => {
    const entry: ManifestOrg = {
      orgId: o.id,
      orgName: o.name,
      orgSlug: o.slug ?? "",
      role: asSkillRole(o.role),
      skills: [],
    };
    byOrg.set(o.id, entry);
    return entry;
  });
  for (const s of skills) {
    byOrg.get(s.organization_id)?.skills.push({
      skillId: s.id,
      name: s.name,
      description: s.description,
      delivery: s.delivery,
      version: s.version,
      bundleSha256: s.bundle_sha256,
      files: files.get(s.version_id) ?? [],
      source: s.source ?? null,
    });
  }
  return { serverTime: new Date().toISOString(), orgs: out };
}

// ---- MCP reads (published only) ----

export type PublishedSkill = {
  id: string;
  name: string;
  delivery: SkillDelivery;
  pinnedVersion: number | null;
  latestVersion: number;
  effectiveVersion: number;
  description: string;
};

/** Live skills with an effective version, described by that version. */
export async function listPublishedSkills(orgId: string): Promise<PublishedSkill[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    delivery: SkillDelivery;
    pinned_version: number | null;
    latest_version: number;
    description: string;
  }>(
    `SELECT s.id, s.name, s.delivery, s.pinned_version, s.latest_version, v.description
       FROM skills s
       JOIN skill_versions v ON v.skill_id = s.id AND v.version = COALESCE(s.pinned_version, s.latest_version)
      WHERE s.organization_id = $1 AND s.deleted_at IS NULL
      ORDER BY s.name`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    delivery: r.delivery,
    pinnedVersion: r.pinned_version,
    latestVersion: r.latest_version,
    effectiveVersion: r.pinned_version ?? r.latest_version,
    description: r.description,
  }));
}

/** One published version of a live skill by name, with every file's bytes. */
export async function readPublishedVersion(
  orgId: string,
  name: string,
  version: number | undefined,
): Promise<{ version: VersionRow; files: FileRow[] } | "skill_not_found" | "version_not_found"> {
  const skill = (await listPublishedSkills(orgId)).find((s) => s.name === name);
  if (!skill) return "skill_not_found";
  const { rows } = await pool.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM skill_versions v LEFT JOIN "user" u ON u.id = v.published_by
      WHERE v.skill_id = $1 AND v.version = $2`,
    [skill.id, version ?? skill.effectiveVersion],
  );
  if (!rows[0]) return "version_not_found";
  const { rows: files } = await pool.query<FileRow>(
    "SELECT path, sha256, size, executable, content FROM skill_version_files WHERE version_id = $1 ORDER BY path",
    [rows[0].id],
  );
  return { version: rows[0], files };
}

// ---- marketplace sources (Addendum — Marketplace import) ----

type SourceRow = {
  id: string;
  org_id: string;
  repo: string;
  ref: string | null;
  label: string | null;
  added_by: string | null;
  added_by_name: string | null;
  added_at: Date;
};

function sourceBody(r: SourceRow): SkillSource {
  return {
    id: r.id,
    orgId: r.org_id,
    repo: r.repo,
    ref: r.ref,
    label: r.label,
    addedBy: person(r.added_by, r.added_by_name),
    addedAt: r.added_at.toISOString(),
  };
}

const SOURCE_SELECT = `SELECT ss.*, u.name AS added_by_name FROM skill_sources ss
  LEFT JOIN "user" u ON u.id = ss.added_by`;

export async function listSkillSources(orgId: string): Promise<SkillSource[]> {
  const { rows } = await pool.query<SourceRow>(
    `${SOURCE_SELECT} WHERE ss.org_id = $1 ORDER BY ss.added_at, ss.id`,
    [orgId],
  );
  return rows.map(sourceBody);
}

/** The same repo + ref (repo ignoring case, null ref = default branch) is one source. */
export async function addSkillSource(
  orgId: string,
  userId: string,
  s: { repo: string; ref: string | null; label: string | null },
): Promise<SkillSource> {
  return tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('skill-sources:' || $1))", [orgId]);
    const { rows: count } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM skill_sources WHERE org_id = $1",
      [orgId],
    );
    if (count[0].n >= MAX_SKILL_SOURCES_PER_ORG) throw new SkillError(409, { error: "skill_source_limit_reached" });
    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO skill_sources (id, org_id, repo, ref, label, added_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, orgId, s.repo, s.ref, s.label, userId],
      );
    } catch (err) {
      // 23505 on `skill_sources_org_repo_ref`.
      if ((err as { code?: string })?.code !== "23505") throw err;
      throw new SkillError(409, { error: "skill_source_exists" });
    }
    const { rows } = await db.query<SourceRow>(`${SOURCE_SELECT} WHERE ss.id = $1`, [id]);
    return sourceBody(rows[0]);
  });
}

export async function removeSkillSource(orgId: string, sourceId: string): Promise<void> {
  const { rowCount } = await pool.query("DELETE FROM skill_sources WHERE id = $1 AND org_id = $2", [sourceId, orgId]);
  if (!rowCount) throw new SkillError(404, { error: "skill_source_not_found" });
}
