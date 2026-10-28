// SPDX-License-Identifier: Apache-2.0
/**
 * Skills wire types (docs/SKILLS.md §2). Copied verbatim by the desktop
 * (`src/lib/skills/types.ts`); change both or neither.
 */
export type SkillDelivery = "required" | "optional";
export type SkillRole = "owner" | "admin" | "member";
/** One person's level for a skill: Required or Optional installs it; none hides it (migration 062). */
export type SkillAccessLevel = "required" | "optional" | "none";

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

/**
 * Where an imported skill came from (Addendum — Marketplace import). Stored on
 * the skill as recorded by the desktop that fetched it; the server never calls
 * GitHub.
 */
export interface SkillOrigin {
  repo: string;              // "owner/name"
  ref: string | null;        // branch/tag asked for; null = the repo's default branch
  path: string;              // skill folder inside the repo, "" = repo root
  commitSha: string;         // 40 or 64 lowercase hex
  treeSha: string;           // the skill folder's tree sha, 40 or 64 lowercase hex
  pluginName?: string | null;
}

/** A GitHub marketplace admins import skills from. */
export interface SkillSource {
  id: string;
  orgId: string;
  repo: string;
  ref: string | null;
  label: string | null;
  addedBy: { id: string; name: string } | null;
  addedAt: string;
}

export interface SkillSummary {
  id: string;
  orgId: string;
  name: string;
  source: SkillOrigin | null;
  description: string;      // latest published description, else the draft's (admins), else ""
  delivery: SkillDelivery;
  pinnedVersion: number | null;
  latestVersion: number | null;      // null = never published
  latestPublishedBy: { id: string; name: string } | null; // publisher of latestVersion; null if never published or user deleted
  latestPublishedAt: string | null;  // ISO, latestVersion's published_at; null if never published
  effectiveVersion: number | null;   // pinnedVersion ?? latestVersion
  draftRevision: number;
  draftDiffers: boolean;             // draft bundle hash != latest version's (true when never published)
  createdAt: string;
  updatedAt: string;
  /** The caller's own level: what installs on their computer ("none" only reaches owners/admins). */
  myAccess: SkillAccessLevel;
  /** The Everyone row; owners/admins only, null for members. */
  everyone: SkillAccessLevel | null;
  /** Who gets it: members whose level is not "none". */
  sharedWith: SkillAudience;
}

export interface SkillAudience {
  /** Every member of the vault gets it. */
  everyone: boolean;
  count: number;
  total: number;
  /** The first few of them, by name. */
  people: { id: string; name: string; image: string | null }[];
}

/** A skill's Shared with list (owners/admins). */
export interface SkillAccessList {
  everyone: SkillAccessLevel;
  people: {
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: SkillRole;
    level: SkillAccessLevel;
    /** Their own row, rather than the Everyone row. */
    own: boolean;
  }[];
}

/** One person's level for one skill (their profile's Skills tab). */
export interface MemberSkillAccess {
  skillId: string;
  name: string;
  description: string;
  latestVersion: number | null;
  level: SkillAccessLevel;
  own: boolean;
  /** The Everyone row, what "Same as everyone" goes back to. */
  everyone: SkillAccessLevel;
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
