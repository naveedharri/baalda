// Skill rules shared with the server (`docs/SKILLS.md` §1): names, file paths,
// caps, SKILL.md frontmatter and the bundle hash. The server is the authority;
// this copy exists so the editor can say what is wrong BEFORE a save or publish
// is refused, and so "draft differs from latest" needs no round trip.
//
// Rust re-implements the name and path rules in `skills_sync.rs`, because it
// never trusts the webview. Keep all three in step.

import type { SkillFileMeta } from "./types";

// ---- Caps (§1.3) -----------------------------------------------------------

export const SKILL_MAX_FILES = 1000;
export const SKILL_MAX_FILE_BYTES = 5 * 1_048_576;
export const SKILL_MAX_TOTAL_BYTES = 25 * 1_048_576;
export const SKILL_MAX_NOTES_CHARS = 2_000;
export const SKILL_MAX_DESCRIPTION_CHARS = 1_024;

export type SkillCapError = "skill_too_many_files" | "skill_file_too_large" | "skill_too_large";

/** A cap as a rule ("Each file can be up to 5 MB."), for editors and refusals. */
export const CAP_RULE_TEXT: Record<SkillCapError, string> = {
  skill_too_many_files: `A skill can hold up to ${SKILL_MAX_FILES} files.`,
  skill_file_too_large: `Each file can be up to ${SKILL_MAX_FILE_BYTES / 1_048_576} MB.`,
  skill_too_large: `A skill can be up to ${SKILL_MAX_TOTAL_BYTES / 1_048_576} MB in total.`,
};

/** A cap as a fact about one skill ("Has a file over 5 MB."), for listing rows. */
export const CAP_FACT_TEXT: Record<SkillCapError, string> = {
  skill_too_many_files: `Has over ${SKILL_MAX_FILES} files.`,
  skill_file_too_large: `Has a file over ${SKILL_MAX_FILE_BYTES / 1_048_576} MB.`,
  skill_too_large: `Is over ${SKILL_MAX_TOTAL_BYTES / 1_048_576} MB in total.`,
};

/**
 * Why a skill couldn't go up, in plain words with what to do, from either a
 * server code (`skill_too_many_files`) or Rust's reader message
 * (`too many files (max 1000)`, `file too large: <path> (max 5 MiB)`,
 * `skill too large (max 25 MiB)`). Null when it isn't a size limit.
 */
export function limitProblemText(raw: string): string | null {
  const mb = (n: number) => `${n / 1_048_576} MB`;
  if (raw === "skill_too_many_files" || /too many files/i.test(raw)) {
    return `it has more than ${SKILL_MAX_FILES} files. Remove build or media folders and try again.`;
  }
  const file = /file too large: (.+?) \(max/i.exec(raw);
  if (file) return `${file[1]} is over ${mb(SKILL_MAX_FILE_BYTES)}. Remove it or make it smaller and try again.`;
  if (raw === "skill_file_too_large") return `a file is over ${mb(SKILL_MAX_FILE_BYTES)}. Remove it or make it smaller and try again.`;
  if (raw === "skill_too_large" || /skill too large/i.test(raw)) {
    return `it's over ${mb(SKILL_MAX_TOTAL_BYTES)} in total. Remove build or media folders and try again.`;
  }
  return null;
}

/** First cap a file set breaks, or null. Sizes are decoded bytes. */
export function checkSkillCaps(files: readonly { size: number }[]): SkillCapError | null {
  if (files.length > SKILL_MAX_FILES) return "skill_too_many_files";
  let total = 0;
  for (const f of files) {
    if (f.size > SKILL_MAX_FILE_BYTES) return "skill_file_too_large";
    total += f.size;
  }
  return total > SKILL_MAX_TOTAL_BYTES ? "skill_too_large" : null;
}

// ---- Names (§1.1) ----------------------------------------------------------

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME_RE.test(name) && !RESERVED.test(name);
}

/** claude.ai's own upload refuses these names; the GitHub bridge may too. */
export function skillNameNeedsWarning(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("claude") || n.includes("anthropic");
}

/** A folder or zip name turned into a candidate skill name (lowercase, `-` runs). */
export function suggestSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

// ---- Paths (§1.2) ----------------------------------------------------------

const BAD_CHARS = /[<>:"|?*\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `path` is refused, or null when it is a valid skill relPath. */
export function skillPathProblem(path: string): string | null {
  if (path.length < 1 || path.length > 240) return "must be 1 to 240 characters";
  if (path.startsWith("/")) return "must be relative";
  if (CONTROL.test(path)) return "contains a control character";
  if (BAD_CHARS.test(path)) return 'contains one of \\ < > : " | ? *';
  for (const part of path.split("/")) {
    if (part.length === 0) return "has an empty folder name";
    if (part.length > 100) return "has a name longer than 100 characters";
    if (part === "." || part === "..") return "uses . or ..";
    if (part.startsWith(".")) return "starts with a dot";
    if (part.endsWith(".") || part.endsWith(" ")) return "ends with a dot or space";
    const stem = part.split(".")[0];
    if (RESERVED.test(stem)) return "uses a name Windows reserves";
  }
  return null;
}

export function isValidSkillPath(path: string): boolean {
  return skillPathProblem(path) === null;
}

/** The first path that collides with an earlier one ignoring case, or null. */
export function caseDuplicate(paths: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const p of paths) {
    const k = p.toLowerCase();
    if (seen.has(k)) return p;
    seen.add(k);
  }
  return null;
}

// ---- SKILL.md frontmatter (§1.4) --------------------------------------------

export type SkillMdReason = "missing_skill_md" | "no_frontmatter" | "bad_yaml" | "name_mismatch" | "description";

export type SkillMdResult =
  | { ok: true; name: string; description: string }
  | { ok: false; reason: SkillMdReason };

type Scalar = { kind: "string"; value: string } | { kind: "other" };

const NON_STRING_PLAIN = /^(~|null|true|false|yes|no|on|off|[-+]?(\d[\d_]*)(\.\d*)?([eE][-+]?\d+)?|[-+]?\.(inf|nan)|0x[0-9a-f]+|0o[0-7]+)$/i;

function stripComment(s: string): string {
  const i = s.search(/\s#/);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/** A one-line or continued scalar after `key:`, with its indented block lines. */
function scalarOf(rest: string, block: string[]): Scalar | null {
  const head = rest.trim();
  if (head.startsWith("|") || head.startsWith(">")) {
    if (!/^[|>][+-]?\d?\s*(#.*)?$/.test(head)) return null;
    const lines = block.map((l) => l.replace(/\r$/, ""));
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    const indent = Math.min(...nonEmpty.map((l) => l.length - l.trimStart().length));
    const body = lines.map((l) => l.slice(Math.min(indent, l.length)));
    const value = head.startsWith("|")
      ? body.join("\n")
      : body.reduce((acc, l) => (l === "" ? `${acc}\n` : acc === "" || acc.endsWith("\n") ? acc + l : `${acc} ${l}`), "");
    return { kind: "string", value: value.replace(/\n+$/, "") };
  }
  if (head.startsWith('"')) {
    const joined = [head, ...block.map((l) => l.trim())].join(" ");
    const end = joined.lastIndexOf('"');
    if (end <= 0) return null;
    try {
      return { kind: "string", value: JSON.parse(joined.slice(0, end + 1)) as string };
    } catch {
      return null;
    }
  }
  if (head.startsWith("'")) {
    const joined = [head, ...block.map((l) => l.trim())].join(" ");
    const end = joined.lastIndexOf("'");
    if (end <= 0) return null;
    return { kind: "string", value: joined.slice(1, end).replace(/''/g, "'") };
  }
  if (head.startsWith("[") || head.startsWith("{") || head.startsWith("&") || head.startsWith("*") || head.startsWith("!")) {
    return { kind: "other" };
  }
  // `key:` with nothing on its line is null, a nested list/mapping below it, or
  // a plain scalar continued on the indented lines.
  if (stripComment(head) === "") {
    const nested = block.some((l) => /^\s*-(\s|$)/.test(l) || /^\s*[^\s#"'][^:]*:(\s|$)/.test(l));
    if (nested || block.every((l) => l.trim() === "")) return { kind: "other" };
  }
  const parts = [stripComment(head), ...block.map((l) => stripComment(l))].filter((p) => p !== "");
  // A plain scalar may not hold `: ` (YAML reads a nested mapping and fails);
  // the usual SKILL.md mistake, so it is caught here rather than at publish.
  if (parts.some((p) => /:(\s|$)/.test(p))) return null;
  const value = parts.join(" ");
  if (parts.length === 1 && NON_STRING_PLAIN.test(value)) return { kind: "other" };
  return { kind: "string", value };
}

/**
 * Read `name` and `description` out of a SKILL.md, the way the server's YAML
 * parser would for the shapes skills actually use: plain, quoted and block
 * scalars at the top level. Other keys are kept by the server and ignored here;
 * only their structure is checked (a top-level line that is not `key: …`, or a
 * repeated key, is `bad_yaml`). The server's full parser has the final word.
 */
export function parseSkillFrontmatter(text: string): SkillMdResult {
  const fields = readFrontmatterFields(text);
  if ("reason" in fields) return { ok: false, reason: fields.reason };
  const { name, description: desc } = fields;
  if (name === null) return { ok: false, reason: "name_mismatch" };
  if (desc === null || desc.trim() === "" || desc.length > SKILL_MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: "description" };
  }
  return { ok: true, name, description: desc };
}

/**
 * The structural half of {@link parseSkillFrontmatter}: the frontmatter read,
 * and `name` / `description` as strings (null when absent or not a string),
 * without judging them. The draft editor's header shows a too-long or empty
 * description rather than hiding it.
 */
export function readFrontmatterFields(
  text: string,
): { name: string | null; description: string | null } | { reason: "no_frontmatter" | "bad_yaml" } {
  const lines = text.replace(/^\uFEFF/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== "---") return { reason: "no_frontmatter" };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { reason: "no_frontmatter" };
  const body = lines.slice(1, close);

  const keys = new Map<string, { rest: string; block: string[] }>();
  let current: { rest: string; block: string[] } | null = null;
  for (const line of body) {
    if (line.trim() === "" || /^\s*#/.test(line)) {
      current?.block.push("");
      continue;
    }
    if (/^\s/.test(line)) {
      if (!current) return { reason: "bad_yaml" };
      current.block.push(line);
      continue;
    }
    const m = /^("[^"]*"|'[^']*'|[^\s#:][^:]*?)\s*:(?:\s+(.*)|$)/.exec(line);
    if (!m) return { reason: "bad_yaml" };
    const key = m[1].replace(/^["']|["']$/g, "");
    if (keys.has(key)) return { reason: "bad_yaml" };
    current = { rest: m[2] ?? "", block: [] };
    keys.set(key, current);
  }
  for (const entry of keys.values()) {
    while (entry.block.length > 0 && entry.block[entry.block.length - 1] === "") entry.block.pop();
  }
  if (keys.size === 0) return { reason: "bad_yaml" };

  const nameEntry = keys.get("name");
  const name = nameEntry ? scalarOf(nameEntry.rest, nameEntry.block) : { kind: "other" as const };
  if (name === null) return { reason: "bad_yaml" };
  const descEntry = keys.get("description");
  const desc = descEntry ? scalarOf(descEntry.rest, descEntry.block) : { kind: "other" as const };
  if (desc === null) return { reason: "bad_yaml" };
  return {
    name: name.kind === "string" ? name.value : null,
    description: desc.kind === "string" ? desc.value : null,
  };
}

/** §1.4 against a skill: `null` when `skillMd` would publish under `skillName`. */
export function validateSkillMd(skillMd: string | null, skillName: string): SkillMdReason | null {
  if (skillMd === null) return "missing_skill_md";
  const r = parseSkillFrontmatter(skillMd);
  if (!r.ok) return r.reason;
  return r.name === skillName ? null : "name_mismatch";
}

/** Plain-words line for a §1.4 refusal, for the editor and the publish dialog. */
export function skillMdProblemText(reason: SkillMdReason, skillName: string): string {
  switch (reason) {
    case "missing_skill_md":
      return "Add a SKILL.md file at the top of the skill.";
    case "no_frontmatter":
      return "SKILL.md must start with a --- block holding name and description.";
    case "bad_yaml":
      return "The --- block at the top of SKILL.md can't be read. Check its indentation and quotes.";
    case "name_mismatch":
      return `The name in SKILL.md must be "${skillName}".`;
    case "description":
      return `SKILL.md needs a description of 1 to ${SKILL_MAX_DESCRIPTION_CHARS} characters.`;
  }
}

/** The default SKILL.md the server seeds a new skill with (§3.3 #3). */
export function seedSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n`;
}

// ---- Bytes, base64 and hashes (§1.5) ----------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** The file as text when it is valid UTF-8, else null (binary). */
export function base64ToText(b64: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(b64));
  } catch {
    return null;
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // A fresh ArrayBuffer: `digest` refuses a view over a SharedArrayBuffer type.
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

export function sha256OfBase64(b64: string): Promise<string> {
  return sha256Hex(base64ToBytes(b64));
}

/** §1.5: files sorted by relPath (byte order), `path\0sha\0exec\n` joined, hashed. */
export function bundleSha256(files: readonly Pick<SkillFileMeta, "path" | "sha256" | "executable">[]): Promise<string> {
  const enc = new TextEncoder();
  const sorted = [...files].sort((a, b) => compareBytes(enc.encode(a.path), enc.encode(b.path)));
  const text = sorted.map((f) => `${f.path}\0${f.sha256}\0${f.executable ? "1" : "0"}\n`).join("");
  return sha256Hex(enc.encode(text));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
