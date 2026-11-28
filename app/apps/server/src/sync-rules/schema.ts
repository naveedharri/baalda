// SPDX-License-Identifier: Apache-2.0

/**
 * The vault's sync rules (#401): which paths no device in the vault syncs.
 *
 * One setting per vault, written by owners/admins and applied by every
 * desktop. `patterns` is a gitignore subset the DESKTOP compiles and matches
 * (`src-tauri/src/sync_rules.rs` + `src/lib/syncRules/match.ts`); the server
 * only stores it, so this checks shape and size, never semantics. The caps
 * mirror the desktop's `MAX_PATTERN_BYTES` / `MAX_PATTERN_LINES`, so a list
 * the server accepts is one every desktop will apply whole.
 */
export type SyncRules = {
  /**
   * 1 = the Sync tab's shape: `patterns` plus the type and folder switches,
   * with dot names and build folders hidden unless switched on.
   * 2 = the vault's `.baaldaignore` file: `patterns` is the whole file and
   * says everything (the default file lists the dot and build folders), and
   * the switches are never stored.
   */
  version: 1 | 2;
  /** Gitignore-style lines; empty means "no rules". */
  patterns: string;
  /**
   * Optional file-type groups the vault switches on (the desktop's
   * `formats.ts optIn`): `code` = source code and other plain text, `extra` =
   * fonts, design and older office files. Absent = both off. Stored only when
   * one is on, so "all off" has one spelling.
   */
  types?: { code: boolean; extra: boolean };
  /**
   * Folder switches: `hidden` = names starting with a dot sync (.github,
   * .obsidian…), `build` = build and dependency folders (node_modules, dist…)
   * sync. Absent = both off, which is what every vault did before. Stored
   * only when one is on. Baalda's own data, .git and lock files never sync.
   */
  folders?: { hidden: boolean; build: boolean };
};

export const SYNC_RULES_FEATURE = "sync-rules";
/** This server stores every optional type (`blobs/formats.ts EXT_MIME`) and
 *  accepts `rules.types`. Desktops offer the switches only when it is listed. */
export const MORE_FILE_TYPES_FEATURE = "more-file-types";
/** This server accepts `rules.folders`. */
export const SYNC_FOLDER_SWITCHES_FEATURE = "sync-folder-switches";
/** This server accepts version 2 rules (the vault's `.baaldaignore` file). */
export const BAALDAIGNORE_FEATURE = "baaldaignore";
export const MAX_PATTERN_BYTES = 64 * 1024;
export const MAX_PATTERN_LINES = 500;

export const EMPTY_SYNC_RULES: SyncRules = { version: 1, patterns: "" };

/** Lines that are a rule: not blank and not a `#` comment (`\#` escapes one). */
export function ruleLineCount(patterns: string): number {
  let n = 0;
  for (const raw of patterns.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "!" || /^!?\/*$/.test(line)) continue;
    n++;
  }
  return n;
}

export type SyncRulesParse =
  | { ok: true; rules: SyncRules }
  | { ok: false; error: "invalid_sync_rules"; message: string };

const bad = (message: string): SyncRulesParse => ({ ok: false, error: "invalid_sync_rules", message });

/** Validate a PUT body's `rules`. Unknown keys are refused, never dropped. */
export function parseSyncRules(raw: unknown): SyncRulesParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("rules must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "version" && k !== "patterns" && k !== "types" && k !== "folders") return bad(`unknown key: ${k}`);
  }
  if (o.version !== undefined && o.version !== 1 && o.version !== 2) return bad("unsupported rules version");
  const version: 1 | 2 = o.version === 2 ? 2 : 1;
  if (version === 2 && (o.types != null || o.folders != null)) {
    return bad("version 2 rules carry everything in patterns");
  }
  if (typeof o.patterns !== "string") return bad("patterns must be a string");
  const patterns = o.patterns.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(patterns, "utf8") > MAX_PATTERN_BYTES) {
    return bad("These rules are too long. Keep them under 64 KB.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(patterns)) return bad("patterns contain control characters");
  if (ruleLineCount(patterns) > MAX_PATTERN_LINES) {
    return bad(`There are too many rules. Keep them to ${MAX_PATTERN_LINES} lines.`);
  }
  let types: SyncRules["types"];
  if (o.types !== undefined && o.types !== null) {
    if (typeof o.types !== "object" || Array.isArray(o.types)) return bad("types must be an object");
    const t = o.types as Record<string, unknown>;
    for (const k of Object.keys(t)) {
      if (k !== "code" && k !== "extra") return bad(`unknown file-type group: ${k}`);
      if (typeof t[k] !== "boolean") return bad(`types.${k} must be true or false`);
    }
    if (t.code === true || t.extra === true) types = { code: t.code === true, extra: t.extra === true };
  }
  let folders: SyncRules["folders"];
  if (o.folders !== undefined && o.folders !== null) {
    if (typeof o.folders !== "object" || Array.isArray(o.folders)) return bad("folders must be an object");
    const f = o.folders as Record<string, unknown>;
    for (const k of Object.keys(f)) {
      if (k !== "hidden" && k !== "build") return bad(`unknown folder switch: ${k}`);
      if (typeof f[k] !== "boolean") return bad(`folders.${k} must be true or false`);
    }
    if (f.hidden === true || f.build === true) folders = { hidden: f.hidden === true, build: f.build === true };
  }
  const rules: SyncRules = { version, patterns };
  if (types) rules.types = types;
  if (folders) rules.folders = folders;
  return { ok: true, rules };
}
