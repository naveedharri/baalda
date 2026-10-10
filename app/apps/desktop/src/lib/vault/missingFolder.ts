// What to do when a synced vault's folder is missing (owner decision 2026-10-09).
//
// The Set-up prompt ("This vault's folder is missing…" with Restore here /
// Locate folder…) is friction for a folder the app itself manages. So:
//   1. `rebind`   — another folder on this machine carries this vault's stamp
//                   (the user renamed or moved it): bind that folder instead.
//   2. `recreate` — the folder lived INSIDE the vaults root and the vault has a
//                   server copy: recreate it at the same path and sync down,
//                   then say so.
//   3. `ask`      — anything else (a folder outside the root, a local-only
//                   vault, an unknown root): today's prompt, unchanged. A
//                   folder outside the root might be an unmounted drive, which
//                   looks exactly like a delete (#228).
//
// Pure: the caller does the disk and stamp lookups.

/** How long a missing folder gets to reappear (a Finder rename settling) before we act. */
export const MISSING_FOLDER_SETTLE_MS = 2_000;

export type MissingFolderPlan =
  | { kind: "rebind"; path: string }
  | { kind: "recreate" }
  | { kind: "ask" };

export interface MissingFolderInput {
  /** The vault's last known folder (absolute). */
  path: string;
  /** The managed vaults root (absolute), or null when unknown or missing. */
  root: string | null;
  /**
   * Another existing folder whose `.context` stamp names this vault (from the
   * rediscovery scan), or null when none matched.
   */
  stampMatches: string | null;
  /** The vault is synced and signed in, so there is a server copy to restore. Default true. */
  canSync?: boolean;
}

/** Trailing separators off, backslashes to slashes, lowercased: macOS and Windows compare case-insensitively. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when `path` sits somewhere below `root` (never the root itself, never a `..` escape). */
export function isInsideVaultsRoot(path: string, root: string | null): boolean {
  if (!root) return false;
  const p = norm(path);
  const r = norm(root);
  if (!r || p === r || !p.startsWith(`${r}/`)) return false;
  return !p.slice(r.length + 1).split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

export function planMissingFolder(input: MissingFolderInput): MissingFolderPlan {
  const { path, root, stampMatches, canSync = true } = input;
  if (stampMatches && norm(stampMatches) !== norm(path)) {
    return { kind: "rebind", path: stampMatches };
  }
  if (!canSync) return { kind: "ask" };
  if (isInsideVaultsRoot(path, root)) return { kind: "recreate" };
  return { kind: "ask" };
}

/** The last path segment, for "moved to <folder>". */
export function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export const autoRestoredNoticeText = (vault: string) =>
  `${vault}'s folder was missing, so Baalda restored it in Baalda Vaults and is syncing it.`;

export const reboundToastText = (vault: string, newPath: string) =>
  `${vault} moved to ${folderName(newPath)}.`;

export const LOCATE_ORIGINAL = "Locate the original instead…";
