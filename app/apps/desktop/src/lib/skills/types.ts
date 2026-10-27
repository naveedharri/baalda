// Skills wire types, verbatim from `docs/SKILLS.md` §2. The server keeps an
// identical copy in `app/apps/server/src/skills/types.ts`; change both or neither.

export type SkillDelivery = "required" | "optional";
export type SkillRole = "owner" | "admin" | "member";

/** A file with content, base64 of the raw bytes. */
export interface SkillFile {
  path: string;            // relPath, §1.2
  sha256: string;
  size: number;            // decoded bytes
  executable: boolean;
  contentBase64: string;
}
/** Upload shape: sha256/size are recomputed and checked by the server if present. */
export interface SkillFileInput {
  path: string;
  contentBase64: string;
  executable?: boolean;    // default false
  sha256?: string;         // when present and wrong → 400 sha_mismatch
}
export interface SkillFileMeta { path: string; sha256: string; size: number; executable: boolean }

export interface SkillVersionSummary {
  version: number;          // 1, 2, 3 …
  bundleSha256: string;
  description: string;      // frozen from SKILL.md at publish
  notes: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: string;      // ISO
  publishedBy: { id: string; name: string } | null;
}

export interface SkillSummary {
  id: string;
  orgId: string;
  name: string;
  description: string;      // latest published description, else the draft's (admins), else ""
  delivery: SkillDelivery;
  pinnedVersion: number | null;
  latestVersion: number | null;      // null = never published
  effectiveVersion: number | null;   // pinnedVersion ?? latestVersion
  draftRevision: number;
  draftDiffers: boolean;             // draft bundle hash != latest version's (true when never published)
  createdAt: string;
  updatedAt: string;
  source: SkillOrigin | null;
  latestPublishedBy: { id: string; name: string } | null; // null: never published, or the user was deleted
  latestPublishedAt: string | null;                       // ISO; null: never published
}

export interface SkillDetail extends SkillSummary {
  versions: SkillVersionSummary[];   // newest first
  draftFiles: SkillFileMeta[] | null; // null for members
}

export interface SkillDraft {
  skillId: string;
  revision: number;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
  files: SkillFile[];
}

export interface SkillsCatalog {
  role: SkillRole;
  skills: SkillSummary[];        // members: only skills with latestVersion != null
}

/** One entry the desktop installs. Only skills with an effective version appear. */
export interface ManifestSkill {
  skillId: string;
  name: string;
  description: string;           // of the effective version
  delivery: SkillDelivery;
  version: number;               // effective version
  bundleSha256: string;
  files: SkillFileMeta[];        // of the effective version (no content)
  source: SkillOrigin | null;
}
export interface ManifestOrg {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: SkillRole;
  skills: ManifestSkill[];
}
export interface SkillsManifest {
  serverTime: string;
  orgs: ManifestOrg[];           // EVERY org the user is a member of, even with zero skills
}

/** Vault-channel control frame (server → client). */
export type SkillsChangedFrame = { t: "skills-changed"; orgId: string };

// ---- Marketplace import (SKILLS.md "Addendum — Marketplace import (server)") ----

/** Where an imported skill came from. Recorded by the desktop that fetched it. */
export interface SkillOrigin {
  repo: string;              // "owner/name", ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$, ≤200 chars
  ref: string | null;        // branch/tag asked for, ^[A-Za-z0-9._/-]{1,255}$; null = default branch
  path: string;              // skill folder inside the repo; "" = repo root; ≤500 chars
  commitSha: string;         // lowercase hex, 40 or 64 chars
  treeSha: string;           // the skill folder's tree sha, lowercase hex, 40 or 64 chars
  pluginName?: string | null; // optional; when present a non-empty string ≤100 chars, or null
}

/** A GitHub marketplace admins import skills from. */
export interface SkillSource {
  id: string;
  orgId: string;
  repo: string;
  ref: string | null;
  label: string | null;
  addedBy: { id: string; name: string } | null;
  addedAt: string;           // ISO
}

// ---- Desktop-only shapes (not on the wire) --------------------------------

/** A published version with its files (`GET …/versions/:version`, route #12). */
export type SkillVersionWithFiles = SkillVersionSummary & { files: SkillFile[] };
