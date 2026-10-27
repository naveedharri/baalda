// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { SkillFileInput, SkillOrigin } from "./types.js";

/**
 * Skill name, path, cap and SKILL.md rules (docs/SKILLS.md §1). The desktop's
 * `lib/skills/validate.ts` and Rust's `skills_sync.rs` re-implement the same
 * rules; the server is the one that refuses.
 */

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;

export const MAX_SKILL_FILES = 1_000;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BYTES = 25 * 1024 * 1024;
export const MAX_SKILLS_PER_ORG = 500;
export const MAX_NOTES_CHARS = 2_000;
export const MAX_DESCRIPTION_CHARS = 1_024;
/**
 * HTTP bodies carrying files: 25 MiB decoded is ~33.4 MiB of base64, plus the
 * JSON around up to 1,000 entries. Route-level, never global.
 */
export const SKILL_BODY_LIMIT = 36 * 1024 * 1024;

/** The size refusals, worded for people; the desktop may show `message` as-is. */
export const TOO_MANY_FILES = {
  error: "skill_too_many_files",
  limit: MAX_SKILL_FILES,
  message: "A skill can have at most 1,000 files.",
} as const;
export const FILE_TOO_LARGE = {
  error: "skill_file_too_large",
  limit: MAX_SKILL_FILE_BYTES,
  message: "Each file in a skill can be at most 5 MB.",
} as const;
export const SKILL_TOO_LARGE = {
  error: "skill_too_large",
  limit: MAX_SKILL_BYTES,
  message: "A skill can be at most 25 MB in total.",
} as const;

export const SKILL_MD = "SKILL.md";

const PATH_MAX = 240;
const COMPONENT_MAX = 100;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;
const SHA_RE = /^[0-9a-f]{64}$/;
// One flat character class plus a length check: a grouped `(?:…{4})*` pattern
// overflows the regex stack on a multi-megabyte string.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** §1.1. Windows device names are refused whatever the case. */
export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(name) &&
    !WINDOWS_RESERVED.test(name)
  );
}

/** Characters, not UTF-16 units, so an emoji counts once like Rust's `chars()`. */
function charCount(s: string): number {
  return [...s].length;
}

/**
 * §1.2: why `path` is refused, or null when it is a valid skill-relative path.
 * A leading `/` and `.`/`..` fall out of the empty-component and dotfile rules.
 */
export function skillPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (charCount(path) > PATH_MAX) return "too_long";
  if (FORBIDDEN_CHARS.test(path)) return "forbidden_character";
  for (const part of path.split("/")) {
    if (part.length === 0) return "empty_component";
    if (charCount(part) > COMPONENT_MAX) return "component_too_long";
    if (part.startsWith(".")) return "dotfile";
    if (part.endsWith(" ") || part.endsWith(".")) return "trailing_dot_or_space";
    if (WINDOWS_RESERVED.test(part.split(".")[0])) return "reserved_name";
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * §1.5 bundle hash: files sorted by relPath in UTF-8 byte order, each joined
 * as `path \0 sha \0 exec \n`, hashed as one UTF-8 string.
 */
export function bundleSha256(
  files: ReadonlyArray<{ path: string; sha256: string; executable: boolean }>,
): string {
  const sorted = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );
  const joined = sorted
    .map((f) => `${f.path}\0${f.sha256}\0${f.executable ? "1" : "0"}\n`)
    .join("");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/** A decoded, verified upload ready to store. */
export interface DecodedSkillFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  content: Buffer;
}

/** A refusal the routes return as-is: `status` + JSON body. */
export class SkillError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly body: { error: string } & Record<string, unknown>,
  ) {
    super(body.error);
  }
}

/**
 * Validate and decode an upload list: shape, path rules, strict base64, the
 * optional client sha, the per-file cap and case-insensitive duplicates within
 * the list itself. Caps over the RESULTING set are {@link checkSkillCaps}.
 */
export function decodeSkillFiles(raw: unknown): DecodedSkillFile[] {
  if (!Array.isArray(raw)) throw new SkillError(400, { error: "invalid_request" });
  // More entries than any whole skill may hold: refuse before hashing any of them.
  if (raw.length > MAX_SKILL_FILES) throw new SkillError(400, { ...TOO_MANY_FILES });
  const seen = new Set<string>();
  const out: DecodedSkillFile[] = [];
  for (const item of raw as SkillFileInput[]) {
    if (!item || typeof item !== "object") throw new SkillError(400, { error: "invalid_request" });
    const { path, contentBase64, executable, sha256 } = item;
    const problem = skillPathProblem(path);
    if (problem) throw new SkillError(400, { error: "invalid_path", path: String(path ?? ""), reason: problem });
    const key = path.toLowerCase();
    if (seen.has(key)) throw new SkillError(400, { error: "invalid_path", path, reason: "duplicate" });
    seen.add(key);
    if (executable !== undefined && typeof executable !== "boolean") {
      throw new SkillError(400, { error: "invalid_request" });
    }
    if (typeof contentBase64 !== "string") throw new SkillError(400, { error: "invalid_base64", path });
    // Decoded size from the length alone, so an oversized file is refused
    // before its bytes are scanned or materialised.
    const pad = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
    if (Math.floor(contentBase64.length / 4) * 3 - pad > MAX_SKILL_FILE_BYTES) {
      throw new SkillError(413, { ...FILE_TOO_LARGE, path });
    }
    if (contentBase64.length % 4 !== 0 || !BASE64_RE.test(contentBase64)) {
      throw new SkillError(400, { error: "invalid_base64", path });
    }
    const content = Buffer.from(contentBase64, "base64");
    const sha = sha256Hex(content);
    if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA_RE.test(sha256) || sha256 !== sha)) {
      throw new SkillError(400, { error: "sha_mismatch", path });
    }
    out.push({ path, sha256: sha, size: content.length, executable: executable ?? false, content });
  }
  return out;
}

/** §1.3 caps over a whole draft/version. */
export function checkSkillCaps(files: ReadonlyArray<{ size: number }>): void {
  if (files.length > MAX_SKILL_FILES) throw new SkillError(400, { ...TOO_MANY_FILES });
  let total = 0;
  for (const f of files) {
    if (f.size > MAX_SKILL_FILE_BYTES) throw new SkillError(413, { ...FILE_TOO_LARGE });
    total += f.size;
  }
  if (total > MAX_SKILL_BYTES) throw new SkillError(413, { ...SKILL_TOO_LARGE });
}

export type FrontmatterResult =
  | { ok: true; name: unknown; description: string }
  | { ok: false; reason: "no_frontmatter" | "bad_yaml" | "name_mismatch" | "description" };

/**
 * §1.4: the text between a first line `---` and the next line `---` must be a
 * YAML mapping with a non-empty `description` (≤1,024 chars). With
 * `expectedName`, `name` must equal it. Other keys are ignored.
 */
export function parseSkillFrontmatter(text: string, expectedName?: string): FrontmatterResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { ok: false, reason: "no_frontmatter" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { ok: false, reason: "no_frontmatter" };
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return { ok: false, reason: "bad_yaml" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "bad_yaml" };
  const map = data as Record<string, unknown>;
  if (expectedName !== undefined && map.name !== expectedName) return { ok: false, reason: "name_mismatch" };
  const description = map.description;
  if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: "description" };
  }
  return { ok: true, name: map.name, description };
}

/** The draft's description, best effort: '' when SKILL.md is absent or invalid. */
export function draftDescription(skillMd: Buffer | null | undefined): string {
  if (!skillMd) return "";
  const parsed = parseSkillFrontmatter(skillMd.toString("utf8"));
  return parsed.ok ? parsed.description : "";
}

// ---- marketplace import (Addendum — Marketplace import) ----

export const SKILL_SOURCE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SKILL_SOURCE_REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;
export const SKILL_SOURCE_REPO_MAX = 200;
export const SKILL_SOURCE_LABEL_MAX = 100;
export const MAX_SKILL_SOURCES_PER_ORG = 100;
const GIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ORIGIN_PATH_MAX = 500;
// eslint-disable-next-line no-control-regex
const ORIGIN_PATH_BAD = /[\u0000-\u001f\u007f\\]/;
const ORIGIN_KEYS = new Set(["repo", "ref", "path", "commitSha", "treeSha", "pluginName"]);

export function isValidSourceRepo(repo: unknown): repo is string {
  return typeof repo === "string" && repo.length <= SKILL_SOURCE_REPO_MAX && SKILL_SOURCE_REPO_RE.test(repo);
}

/**
 * A skill's `source`: null clears it, otherwise a small object of exactly the
 * {@link SkillOrigin} keys. Anything else is 400 `invalid_source` with the
 * offending key, so the stored JSON stays small and predictable.
 */
export function parseSkillOrigin(raw: unknown): SkillOrigin | null {
  if (raw === null) return null;
  const bad = (key: string) => new SkillError(400, { error: "invalid_source", key });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("source");
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!ORIGIN_KEYS.has(key)) throw bad(key);
  if (!isValidSourceRepo(o.repo)) throw bad("repo");
  const ref = o.ref ?? null;
  if (ref !== null && (typeof ref !== "string" || !SKILL_SOURCE_REF_RE.test(ref))) throw bad("ref");
  // A repo path, not a skill relPath: dotted folders such as `.claude/skills/x`
  // are normal in marketplaces, so only escapes and control characters are refused.
  if (
    typeof o.path !== "string" ||
    o.path.length > ORIGIN_PATH_MAX ||
    ORIGIN_PATH_BAD.test(o.path) ||
    o.path.split("/").some((part, _i, all) => part === ".." || part === "." || (part === "" && all.length > 1))
  ) {
    throw bad("path");
  }
  if (typeof o.commitSha !== "string" || !GIT_SHA_RE.test(o.commitSha)) throw bad("commitSha");
  if (typeof o.treeSha !== "string" || !GIT_SHA_RE.test(o.treeSha)) throw bad("treeSha");
  const out: SkillOrigin = { repo: o.repo, ref, path: o.path, commitSha: o.commitSha, treeSha: o.treeSha };
  if (o.pluginName !== undefined) {
    const p = o.pluginName;
    if (p !== null && (typeof p !== "string" || p.length === 0 || p.length > SKILL_SOURCE_LABEL_MAX)) {
      throw bad("pluginName");
    }
    out.pluginName = p;
  }
  return out;
}
