// Account-level, device-local preferences that follow the app rather than any
// one vault: the user's activity status and the mention chime. Persisted in
// localStorage (device-local, like the theme). Profile fields (display name,
// avatar) are NOT here — those are server-backed via Better Auth so they follow
// the account across devices; see `ApiClient.updateUser`.

import type { TreeSort } from "./tree/sort";

export type ActivityStatus = "online" | "away" | "busy" | "invisible";

export const ACTIVITY_STATUSES: Array<{
  id: ActivityStatus;
  label: string;
  hint: string;
}> = [
  { id: "online", label: "Online", hint: "Active and available" },
  { id: "away", label: "Away", hint: "Not at the keyboard right now" },
  { id: "busy", label: "Busy", hint: "Please do not disturb" },
  { id: "invisible", label: "Invisible", hint: "Appear offline to teammates" },
];

const STATUS_KEY = "context.activityStatus";
const MENTION_SOUND_KEY = "context.mentionSound";

function isActivityStatus(v: unknown): v is ActivityStatus {
  return v === "online" || v === "away" || v === "busy" || v === "invisible";
}

export function readActivityStatus(): ActivityStatus {
  try {
    const v = localStorage.getItem(STATUS_KEY);
    return isActivityStatus(v) ? v : "online";
  } catch {
    return "online";
  }
}

export function writeActivityStatus(status: ActivityStatus): void {
  try {
    localStorage.setItem(STATUS_KEY, status);
  } catch {
    /* localStorage unavailable — status stays in-memory only */
  }
}

/** The mention chime is on by default; only an explicit opt-out disables it. */
export function readMentionSound(): boolean {
  try {
    return localStorage.getItem(MENTION_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeMentionSound(enabled: boolean): void {
  try {
    localStorage.setItem(MENTION_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* localStorage unavailable — preference stays in-memory only */
  }
}

// ---- Sidebar sort -----------------------------------------------------------

const TREE_SORT_KEY = "context.treeSort";

/**
 * How the sidebar arranges what the user hasn't arranged by hand. Device-level
 * rather than per-vault (unlike item order/colors, which describe one vault's
 * contents): this is a habit about how you read a sidebar, and having it flip
 * as you switch vaults would be its own surprise.
 *
 * Defaults to "recent" — a second brain is mostly read from the top, and the
 * note you want is nearly always one you touched lately.
 */
export function readTreeSort(): TreeSort {
  try {
    const v = localStorage.getItem(TREE_SORT_KEY);
    return v === "name" || v === "recent" ? v : "recent";
  } catch {
    return "recent";
  }
}

export function writeTreeSort(sort: TreeSort): void {
  try {
    localStorage.setItem(TREE_SORT_KEY, sort);
  } catch {
    /* localStorage unavailable — the sort stays in-memory only */
  }
}

// ---- Sidebar width ----------------------------------------------------------

const SIDEBAR_WIDTH_KEY = "context.sidebarWidth";

/** The width the sidebar starts at, and what a double-click on the divider
 *  restores. */
export const SIDEBAR_WIDTH_DEFAULT = 264;
/** The default is also the floor: the resizer only ever widens the sidebar.
 *  Narrower than this and the tree header's toolbar runs out of room and pushes
 *  its last button out past the edge — so there is nothing to be gained below
 *  the width the layout was designed at. */
export const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;
export const SIDEBAR_WIDTH_MAX = 560;

/** Clamp a width to the usable range, also refusing to eat the whole window on
 *  a small screen. NaN (a corrupted stored value) falls back to the default. */
export function clampSidebarWidth(px: number, viewport = 1200): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  // Always leave room for the editor, even when the window is narrower than the
  // nominal maximum.
  const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, viewport - 320));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(Number(raw), window.innerWidth);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* localStorage unavailable — the width stays in-memory only */
  }
}
