// SPDX-License-Identifier: Apache-2.0
/**
 * The vault's `.baaldaignore` (#401): ONE file at the vault root that lists
 * what the vault doesn't sync, in the `.gitignore` style `match.ts` reads.
 *
 * It is the on-disk face of the vault's one sync setting, never a per-device
 * rule. The rules travel through the server (`GET|PUT sync-rules`, version 2:
 * `patterns` is the whole file), so every device applies the same set before
 * its first pull. The sync layer keeps the file equal to them: an owner's or
 * admin's edit becomes the vault's rules; a member's edit is put back.
 *
 * The file itself is a floor name (`folders.ts isFloorName`, Rust
 * `is_floor_name`): never synced as a file and never in the sidebar.
 */
import type { SyncRulesDoc } from "../ipc";
import { BUILD_DIRS } from "./folders";

export const RULES_FILE = ".baaldaignore";
/** The server stores every optional file type (`blobs/formats.ts EXT_MIME`). */
export const MORE_FILE_TYPES_FEATURE = "more-file-types";
/** The server stores version 2 rules (a `.baaldaignore` text). */
export const BAALDAIGNORE_FEATURE = "baaldaignore";

/** What every vault ignored before the file existed: names starting with a
 *  dot and the build folders. Code and other file types now sync by default. */
export const DEFAULT_BAALDAIGNORE = `# .baaldaignore: what this vault doesn't sync.
#
# One pattern per line, the way .gitignore works:
#   folder/       a folder with this name, anywhere in the vault
#   /folder/      only the folder at the top of the vault
#   a/b/          the folder b inside a
#   *.psd         every file of this type
#   !keep/        sync this after all (the last matching line wins)
#
# Owners and admins can change this file, and everyone's Baalda follows it.
# Nothing is deleted: ignored files stay on each computer as they are.
# Baalda's own data (.context), .git, lock files and system files never sync.

# Hidden files and folders (names starting with a dot)
.*

# Build and dependency folders
${BUILD_DIRS.map((d) => `${d}/`).join("\n")}

# Files that often hold passwords
*.tfvars
`;

/** The pre-file switches a version 1 rule set may carry. */
interface V1Like {
  version?: number;
  patterns: string;
  folders?: { hidden?: boolean; build?: boolean };
}

/**
 * The file text a stored rule set means. Version 2 IS the file. Version 1 (the
 * Sync tab, or no rules saved yet) hid dot names and build folders unless
 * switched on, then applied its own lines: the same thing, written out.
 */
export function rulesTextOf(rules: V1Like | null | undefined): string {
  if (rules?.version === 2) return rules.patterns;
  const folders = rules?.folders ?? {};
  const own = (rules?.patterns ?? "").replace(/\r\n?/g, "\n").trim();
  let text = DEFAULT_BAALDAIGNORE;
  // A switch that was on: its lines stay, commented out, ready to put back.
  if (folders.hidden === true) text = text.replace("\n.*\n", "\n# .*\n");
  if (folders.build === true) {
    for (const d of BUILD_DIRS) text = text.replace(`\n${d}/\n`, `\n# ${d}/\n`);
  }
  return own ? `${text}\n# Set in Vault Settings before this file existed\n${own}\n` : text;
}

/** Equal for every purpose: line endings and trailing blank space aside. */
export function sameRulesText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return norm(a) === norm(b);
}

/** A file that says nothing at all is read as missing, never as "ignore
 *  nothing" (a half-saved or truncated file must not start syncing
 *  node_modules). A file holding only comments does mean "ignore nothing". */
export function isUsableRulesFile(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim() !== "";
}

/**
 * What Rust walks with for this text. The file says everything, so the old
 * name-level switches are on (its `.*` and build lines do that hiding now)
 * and the optional file types sync wherever the server stores them.
 */
export function rulesDocFor(text: string, revision: number | null, typesOn: boolean): SyncRulesDoc {
  return {
    version: 2,
    patterns: text,
    types: { code: typesOn, extra: typesOn },
    folders: { hidden: true, build: true },
    revision,
  };
}
