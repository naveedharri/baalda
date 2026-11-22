// The vault's sync rules (#401): a gitignore subset naming paths the vault
// never syncs. One setting per vault, written by owners/admins, the same on
// every device.
//
// ONE CONTRACT with Rust's `src-tauri/src/sync_rules.rs`: both compile each
// line to the same regular expression, and both run `fixtures.json` in their
// tests. Change one, change both.
//
// The language:
//   - blank lines and `#` comments are skipped; `\#` / `\!` escape them;
//   - `!` re-includes, and the LAST matching line wins;
//   - a trailing `/` matches folders only;
//   - a `/` anywhere but the end anchors the pattern to the vault root (a
//     leading `/` is dropped); without one it matches a name at any depth;
//   - `*` = any run inside one folder name, `?` = one character, `**` = any depth;
//   - case is ignored, like every path comparison in sync.
// A path is excluded when it, or any folder above it, is excluded: as in git,
// a file inside an excluded folder cannot be re-included.
//
// One exception to "case is ignored": a line that is exactly one of the
// default build folders (`node_modules/`, `build/`… — {@link BUILD_DIRS},
// lowercase, folder-only) matches that exact name, as those folders always
// have. A notes folder called "Build" or "Target" kept syncing before
// `.baaldaignore` existed, and the default file must not hide it now.

/** Caps, mirrored by Rust and by the server's `sync-rules/schema.ts`. */
import { BUILD_DIRS, NO_FOLDERS, normalizeFolders, type SyncFolders } from "./folders";
export const MAX_PATTERN_BYTES = 64 * 1024;
export const MAX_PATTERN_LINES = 500;

interface Rule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly re: RegExp;
}

/** Characters escaped in the regex body: the same set as Rust's `REGEX_SPECIAL`. */
const REGEX_SPECIAL = new Set("\\.+()|[]{}^$#&-~".split(""));

/** Mirrors Rust `glob_to_regex`. */
export function globToRegex(glob: string): string {
  const chars = [...glob];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "*" && chars[i + 1] === "*") {
      const atSegStart = i === 0 || chars[i - 1] === "/";
      if (atSegStart && chars[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (REGEX_SPECIAL.has(c)) out += "\\" + c;
    else out += c;
    i += 1;
  }
  return out;
}

/** One line → a rule, or null for a blank or a comment. Mirrors Rust `compile_line`. */
export function compileLine(raw: string): Rule | null {
  let line = raw.replace(/[\r \t]+$/, "").replace(/^[ \t]+/, "");
  if (line === "" || line.startsWith("#")) return null;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  const dirOnly = line.endsWith("/");
  line = line.replace(/\/+$/, "");
  if (line === "") return null;
  const anchored = line.includes("/");
  line = line.replace(/^\/+/, "");
  if (line === "") return null;
  const body = globToRegex(line);
  const src = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  const exactCase = dirOnly && !anchored && BUILD_DIRS.includes(line);
  try {
    return { negate, dirOnly, re: new RegExp(src, exactCase ? "" : "i") };
  } catch {
    return null;
  }
}

/** Why a pattern list cannot be used, or null when it can. */
export function patternsProblem(patterns: string): string | null {
  if (new TextEncoder().encode(patterns).length > MAX_PATTERN_BYTES) {
    return "These rules are too long. Keep them under 64 KB.";
  }
  const count = patterns.split("\n").filter((l) => compileLine(l) != null).length;
  if (count > MAX_PATTERN_LINES) {
    return `There are too many rules. Keep them to ${MAX_PATTERN_LINES} lines.`;
  }
  return null;
}

/** The optional file-type groups a vault can switch on (formats.ts `optIn`). */
export interface SyncTypes {
  /** Source code, config and other plain text ("Code and text files"). */
  code: boolean;
  /** Fonts, design files, older Office formats, more media ("More file types"). */
  extra: boolean;
}
export const NO_TYPES: SyncTypes = { code: false, extra: false };

/** Read a `types` object from the wire or the cache: unknown keys and
 *  non-boolean values count as off. */
export function normalizeTypes(raw: unknown): SyncTypes {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { code: t.code === true, extra: t.extra === true };
}

export { NO_FOLDERS, normalizeFolders, type SyncFolders } from "./folders";

/** Compiled rules for one vault. */
export class SyncRuleSet {
  private readonly rules: readonly Rule[];
  /** The text it was compiled from (what Rust was handed too). */
  readonly source: string;
  /** Which optional file-type groups sync in this vault. */
  readonly types: SyncTypes;
  /** Whether dot folders and build folders sync in this vault. */
  readonly folders: SyncFolders;

  constructor(patterns: string, types: SyncTypes = NO_TYPES, folders: SyncFolders = NO_FOLDERS) {
    this.source = patterns;
    this.types = { code: types.code, extra: types.extra };
    this.folders = { hidden: folders.hidden, build: folders.build };
    this.rules = patterns
      .split("\n")
      .map(compileLine)
      .filter((r): r is Rule => r != null);
  }

  /** No path patterns (the type switches aside). */
  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /** Equal patterns and equal switches: applying `other` would change nothing. */
  sameAs(other: { patterns: string; types?: unknown; folders?: unknown }): boolean {
    const t = normalizeTypes(other.types);
    const f = normalizeFolders(other.folders);
    return (
      other.patterns === this.source &&
      t.code === this.types.code &&
      t.extra === this.types.extra &&
      f.hidden === this.folders.hidden &&
      f.build === this.folders.build
    );
  }

  /** The verdict for this path ALONE, ignoring the folders above it. */
  excludesEntry(rel: string, isDir: boolean): boolean {
    if (this.rules.length === 0) return false;
    const path = rel.replace(/^\/+|\/+$/g, "");
    if (path === "") return false;
    let excluded = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(path)) excluded = !rule.negate;
    }
    return excluded;
  }

  /** Is this vault-relative path excluded, itself or through a folder above it? */
  excludes(rel: string, isDir: boolean): boolean {
    if (this.rules.length === 0) return false;
    const path = rel.replace(/^\/+|\/+$/g, "");
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
      if (this.excludesEntry(path.slice(0, i), true)) return true;
    }
    return this.excludesEntry(path, isDir);
  }
}

/** Shared empty set: no rules, nothing excluded. */
export const NO_RULES = new SyncRuleSet("");
