// Account-level, device-local preferences that follow the app rather than any
// one vault: the user's activity status and the mention chime. Persisted in
// localStorage (device-local, like the theme). Profile fields (display name,
// avatar) are NOT here — those are server-backed via Better Auth so they follow
// the account across devices; see `ApiClient.updateUser`.

import type { ServerChoice } from "./auth/serverChoice";
import type { PropertiesMode } from "./editor/frontmatter";
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

// ---- Which server this device's account lives on -----------------------------

const SERVER_CHOICE_KEY = "context.serverChoice";

/**
 * The answer to "managed service, or your own server?" — asked once, on the
 * first sign-in this device ever sees (see `lib/auth/serverChoice.ts`).
 *
 * Device-local like the theme, and deliberately NOT the server URL itself: that
 * lives in the Rust app config, because the auth manager needs it before any
 * localStorage-backed UI exists. This only records whether the question has
 * been answered, so the step stops appearing once it has.
 *
 * An absent or corrupted value reads as `null` — "never asked" — which is the
 * safe direction: the worst case is asking a question again, never silently
 * signing someone up on the wrong server.
 */
export function readServerChoice(): ServerChoice | null {
  try {
    const v = localStorage.getItem(SERVER_CHOICE_KEY);
    return v === "managed" || v === "custom" ? v : null;
  } catch {
    return null;
  }
}

export function writeServerChoice(choice: ServerChoice): void {
  try {
    localStorage.setItem(SERVER_CHOICE_KEY, choice);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
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

// ---- Properties in document -------------------------------------------------

const PROPERTIES_MODE_KEY = "context.propertiesMode";

/**
 * How YAML frontmatter is drawn in the editor: as a Properties panel, as plain
 * source, or not at all. Device-local like the theme — it describes how the
 * editor draws, not what a vault contains, so it must not flip as you switch
 * vaults. Defaults to the panel, which is the point of the feature.
 */
export function readPropertiesMode(): PropertiesMode {
  try {
    const v = localStorage.getItem(PROPERTIES_MODE_KEY);
    return v === "visible" || v === "hidden" || v === "source" ? v : "visible";
  } catch {
    return "visible";
  }
}

export function writePropertiesMode(mode: PropertiesMode): void {
  try {
    localStorage.setItem(PROPERTIES_MODE_KEY, mode);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

export const PROPERTIES_MODES: ReadonlyArray<{
  id: PropertiesMode;
  label: string;
  hint: string;
}> = [
  { id: "visible", label: "Visible", hint: "Shown as a panel above the note" },
  { id: "hidden", label: "Hidden", hint: "Not shown; still in the file" },
  { id: "source", label: "Source", hint: "Shown as plain YAML" },
];

// ---- Editor layout ----------------------------------------------------------

const EDITOR_MEASURE_KEY = "context.editorMeasure";
/** The key this replaced: a two-state "Readable line length" switch. Read once,
 *  to migrate a device that still has it, and never written again. */
const LEGACY_READABLE_LINE_LENGTH_KEY = "context.readableLineLength";
const LINE_NUMBERS_KEY = "context.lineNumbers";

/**
 * How wide the editor's prose column runs: a measure in `ch` — the unit
 * `--editor-measure` is already expressed in — or `"full"`, the whole pane
 * minus its gutters.
 */
export type EditorMeasure = number | "full";

/** 88ch is the readable measure: past roughly ninety characters the eye loses
 *  the start of the next line, which is where every typographic rule of thumb
 *  (and Obsidian's own default) lands. */
export const EDITOR_MEASURE_DEFAULT = 88;
/** Below ~60ch prose starts to hyphenate badly; above ~120ch the measure has
 *  already stopped being readable and "full" is the honest choice. */
export const EDITOR_MEASURE_MIN = 60;
export const EDITOR_MEASURE_MAX = 120;
/** The slider's granularity. Four characters is the smallest step whose effect
 *  is actually visible as you drag. */
export const EDITOR_MEASURE_STEP = 4;

/** Snap to the step and clamp to the usable range. NaN — a corrupted stored
 *  value, or a garbage slider reading — falls back to the default rather than
 *  collapsing the column to nothing. ±Infinity clamps to the bounds like any
 *  other out-of-range number; a clamp that answered "88" to "as wide as
 *  possible" would be lying. */
export function clampEditorMeasure(ch: number): number {
  if (Number.isNaN(ch)) return EDITOR_MEASURE_DEFAULT;
  const snapped = Math.round(ch / EDITOR_MEASURE_STEP) * EDITOR_MEASURE_STEP;
  return Math.min(EDITOR_MEASURE_MAX, Math.max(EDITOR_MEASURE_MIN, snapped));
}

/**
 * The chosen column width. Device-local like the theme — it describes how the
 * editor draws, not what a vault contains.
 *
 * Migration: this replaced a two-state "Readable line length" switch. With no
 * value of its own the old key still decides — "off" meant the column filled
 * the window, which is exactly what `"full"` means now, and anything else meant
 * the readable measure, which is the default. The legacy key is never written
 * again, so the first drag of the slider settles it for good.
 */
export function readEditorMeasure(): EditorMeasure {
  try {
    const raw = localStorage.getItem(EDITOR_MEASURE_KEY);
    if (raw === null) {
      return localStorage.getItem(LEGACY_READABLE_LINE_LENGTH_KEY) === "off"
        ? "full"
        : EDITOR_MEASURE_DEFAULT;
    }
    if (raw === "full") return "full";
    // `Number("")` is 0 — finite, so it would survive the clamp as the MINIMUM
    // measure. An empty or blank value is a corrupted write, not a request for
    // the narrowest column.
    return raw.trim() === "" ? EDITOR_MEASURE_DEFAULT : clampEditorMeasure(Number(raw));
  } catch {
    return EDITOR_MEASURE_DEFAULT;
  }
}

export function writeEditorMeasure(measure: EditorMeasure): void {
  try {
    localStorage.setItem(EDITOR_MEASURE_KEY, measure === "full" ? "full" : String(measure));
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

/**
 * Show the line-number gutter. OFF by default, unlike everything else here: the
 * gutter takes real width from the prose column, and a second brain is a place
 * you write prose, not a place you cite line 42.
 */
export function readLineNumbers(): boolean {
  try {
    return localStorage.getItem(LINE_NUMBERS_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeLineNumbers(on: boolean): void {
  try {
    localStorage.setItem(LINE_NUMBERS_KEY, on ? "on" : "off");
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
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
