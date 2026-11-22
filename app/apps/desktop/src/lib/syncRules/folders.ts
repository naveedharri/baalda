// SPDX-License-Identifier: Apache-2.0
/**
 * Which folder and file NAMES sync (#401): the fixed floor, plus dot names and
 * build folders when the open vault switched them on. One contract with Rust
 * `vault.rs is_floor_name` / `is_ignored_name_with` (pinned by
 * `formatsLockstep.test.ts`). Every check that judges a server-supplied path
 * (`inbound.ts segmentsOk`, `attachments.ts isSafeTreeBinaryRelPath`) asks
 * here, so a path one device uploads is one every device will write.
 */

/** The vault's folder switches. Both off = what every vault did before. */
export interface SyncFolders {
  /** Names starting with a dot (.github, .obsidian…). */
  hidden: boolean;
  /** Build and dependency folders ({@link BUILD_DIRS}). */
  build: boolean;
}
export const NO_FOLDERS: SyncFolders = { hidden: false, build: false };

export function normalizeFolders(raw: unknown): SyncFolders {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { hidden: f.hidden === true, build: f.build === true };
}

/** Mirrors `DENIED_DIRS` in src-tauri/src/vault.rs. */
export const BUILD_DIRS = ["node_modules", "dist", "build", "target", "vendor", "__pycache__", "venv"];

/** Mirrors `OS_JUNK` in src-tauri/src/vault.rs. */
const OS_JUNK = [
  ".ds_store",
  ".trashes",
  ".trash",
  ".spotlight-v100",
  ".fseventsd",
  ".temporaryitems",
  ".documentrevisions-v100",
  "thumbs.db",
  "desktop.ini",
];

/**
 * Never synced, whatever the switches or rules say: Baalda's own data, a Git
 * repository's internals, app lock files, Baalda's own save-in-progress temp
 * files and operating-system bookkeeping. Each is a design problem, not a
 * preference. (Office `~$` lock files are judged by `isTransientPath`.)
 */
export function isFloorName(name: string): boolean {
  if (name === ".context" || name === ".git") return true;
  if (name.startsWith(".~lock.") || name.startsWith("._")) return true;
  const lower = name.toLowerCase();
  if (OS_JUNK.includes(lower)) return true;
  return name.startsWith(".") && lower.endsWith(".tmp");
}

let current: SyncFolders = NO_FOLDERS;

/** The open vault's switches (`registry.setSyncRules`). */
export function setFolderSwitches(f: SyncFolders): void {
  current = { hidden: f.hidden, build: f.build };
}

export function folderSwitches(): SyncFolders {
  return current;
}

/** Is this one path segment kept out of sync, under these switches? */
export function isHiddenName(name: string, f: SyncFolders = current): boolean {
  if (isFloorName(name)) return true;
  if (name.startsWith(".") && !f.hidden) return true;
  return !f.build && BUILD_DIRS.includes(name);
}

/** Does any segment of this vault-relative path keep it out of sync? */
export function hasHiddenSegment(rel: string, f: SyncFolders = current): boolean {
  return rel.split("/").some((seg) => seg !== "" && isHiddenName(seg, f));
}
