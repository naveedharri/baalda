// Shared contract for the Graph View's tunable settings. Every graph module
// imports the types + defaults from here so the simulation, renderer, color
// assignment, and controls panel all agree on one shape.
//
// Settings persist to localStorage under SETTINGS_STORAGE_KEY so a user's tuned
// physics/visual preferences survive app restarts.

/** How node fill colors are derived. */
export type ColorMode = "folder" | "degree" | "uniform";

/**
 * What the graph draws. **Pinned to `global`** — the graph is the whole vault.
 *
 * The `local` mode (the open note's neighborhood, N hops out) is gone from the
 * UI: two scopes meant the view could show two different things under the same
 * name, and the one people actually wanted was always the whole vault. The union
 * type survives so the renderer's non-WebGL fallback branch (which is written
 * against `scope`) keeps type-checking; nothing sets it to `"local"` any more.
 */
export type GraphScope = "local" | "global";

export interface GraphSettings {
  // ---- Scope ----
  /** Draw the open note's local neighborhood, or the whole vault. */
  scope: GraphScope;
  /** Vestigial: local scope has no UI. Retained so persisted blobs still parse. */
  localDepth: number;

  // ---- Forces (physics) ----
  /** Many-body repulsion. More negative = stronger push-apart. */
  charge: number;
  /** Rest length of link springs, in world units. */
  linkDistance: number;
  /** Link spring stiffness, 0..1. */
  linkStrength: number;
  /** Pull toward the center of gravity, 0..0.5. Higher = tighter circle. */
  gravity: number;

  // ---- Visual ----
  /** Multiplier on every node's base radius. */
  nodeSize: number;
  /** Multiplier on edge line width. */
  edgeThickness: number;
  /** Multiplier on the zoom level at which labels fade in (higher = labels sooner). */
  labelScale: number;
  /** Node fill color strategy. */
  colorMode: ColorMode;

  // ---- Filter ----
  /** Case-insensitive title substring; non-matches are dimmed (empty = no filter). */
  search: string;
  /** Hide nodes whose degree (linkCount) is below this. */
  minDegree: number;
  /** Hide nodes with zero links. */
  hideOrphans: boolean;
}

// Tuned by hand against a real ~3.4k-note vault rather than derived: long links
// with a soft spring and light gravity let the hubs separate into distinct
// clusters instead of packing into one ball, and small nodes with `minDegree: 1`
// keep the field readable at that size. These are the values the graph is
// actually designed to look right at, so they are the defaults.
export const DEFAULT_SETTINGS: GraphSettings = {
  scope: "global",
  localDepth: 1, // vestigial; `scope` is pinned to global
  charge: -10.8,
  linkDistance: 337,
  linkStrength: 0.44,
  gravity: 0.21,
  nodeSize: 0.4,
  edgeThickness: 1.3,
  labelScale: 0.25,
  colorMode: "degree",
  search: "",
  minDegree: 1,
  hideOrphans: true,
};

/** Inclusive slider ranges + step for the numeric controls, keyed by setting. */
export const SETTING_RANGES = {
  charge: { min: -1500, max: -1, step: 0.2 },
  linkDistance: { min: 1, max: 400, step: 0.5 },
  linkStrength: { min: 0, max: 1, step: 0.02 },
  gravity: { min: 0, max: 1, step: 0.01 },
  nodeSize: { min: 0.4, max: 4, step: 0.1 },
  edgeThickness: { min: 0.4, max: 4, step: 0.1 },
  labelScale: { min: 0, max: 2, step: 0.05 },
  minDegree: { min: 0, max: 20, step: 1 },
} as const;

// Bumped to v5 so the new physics/appearance defaults take effect over any saved
// values — a persisted v4 blob would otherwise pin every existing install to the
// old look, which is precisely what re-tuning the defaults is meant to fix.
export const SETTINGS_STORAGE_KEY = "context.graph.settings.v5";

/** Load persisted settings, merged over defaults (tolerant of missing/old keys). */
export function loadSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    // `scope` is forced regardless of what was stored: local mode no longer has
    // a control, so a saved `"local"` would strand someone in a scope they can't
    // see the toggle for and can't get out of.
    return { ...DEFAULT_SETTINGS, ...parsed, scope: "global" };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings (best-effort; ignores quota/serialization errors). */
export function saveSettings(settings: GraphSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
