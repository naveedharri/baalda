// SPDX-License-Identifier: Apache-2.0
import { McpToolError, type McpContext } from "./service.js";
import { orgRole } from "../permissions/lookup.js";
import type { SkillViewer } from "../skills/access.js";
import { asSkillRole, listPublishedSkills, readPublishedVersion } from "../skills/store.js";
import { SKILL_MD } from "../skills/validate.js";

/**
 * Read-only MCP access to the token vault's team skills (docs/SKILLS.md §3.5).
 * Only live skills with a published effective version are visible; drafts
 * never reach MCP. A member sees only skills shared with them (migration 062);
 * owners and admins see every one. Membership is already proven by the token
 * (`verifyMcpToken` re-checks it on every call).
 */

const READ_SKILL_FILE_DEFAULT_CHARS = 50_000;
const READ_SKILL_FILE_MAX_CHARS = 200_000;

/** UTF-8 text, or null for bytes that are not valid UTF-8. */
function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function versionArg(version: number | undefined): number | undefined {
  if (version === undefined) return undefined;
  if (!Number.isInteger(version) || version < 1) {
    throw new McpToolError(`Version ${version} not found`, "version_not_found");
  }
  return version;
}

/** The token's person, with their current role in its vault. */
async function viewerOf(ctx: McpContext): Promise<SkillViewer> {
  const role = await orgRole(ctx.auth.organizationId, ctx.auth.userId);
  return { userId: ctx.auth.userId, role: asSkillRole(role ?? "member") };
}

async function published(ctx: McpContext, name: string, version: number | undefined) {
  const found = await readPublishedVersion(ctx.auth.organizationId, name, versionArg(version), await viewerOf(ctx));
  if (found === "skill_not_found") throw new McpToolError(`Skill not found: ${name}`, "skill_not_found");
  if (found === "version_not_found") {
    throw new McpToolError(`Version ${version} of ${name} not found`, "version_not_found");
  }
  return found;
}

export async function listSkillsTool(ctx: McpContext) {
  const skills = await listPublishedSkills(ctx.auth.organizationId, await viewerOf(ctx));
  return {
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.effectiveVersion,
      required: s.delivery === "required",
      latestVersion: s.latestVersion,
      pinned: s.pinnedVersion !== null,
    })),
  };
}

export async function getSkillTool(ctx: McpContext, name: string, version?: number) {
  const { version: v, files } = await published(ctx, name, version);
  const skillMd = files.find((f) => f.path === SKILL_MD);
  return {
    name,
    description: v.description,
    version: v.version,
    notes: v.notes,
    publishedAt: v.published_at.toISOString(),
    skillMd: skillMd ? (utf8(skillMd.content) ?? "") : "",
    files: files.map((f) => ({ path: f.path, size: f.size, text: utf8(f.content) !== null })),
  };
}

export async function readSkillFileTool(
  ctx: McpContext,
  name: string,
  path: string,
  version?: number,
  maxChars?: number,
) {
  const { version: v, files } = await published(ctx, name, version);
  const file =
    files.find((f) => f.path === path) ?? files.find((f) => f.path.toLowerCase() === path.toLowerCase());
  if (!file) throw new McpToolError(`File not found in ${name} v${v.version}: ${path}`, "file_not_found");
  const cap = Number.isFinite(maxChars) && (maxChars as number) > 0
    ? Math.min(Math.trunc(maxChars as number), READ_SKILL_FILE_MAX_CHARS)
    : READ_SKILL_FILE_DEFAULT_CHARS;
  const text = utf8(file.content);
  if (text === null) return { path: file.path, version: v.version, text: null, binary: true, truncated: false };
  return {
    path: file.path,
    version: v.version,
    text: text.length > cap ? text.slice(0, cap) : text,
    binary: false,
    truncated: text.length > cap,
  };
}
