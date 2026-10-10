// Vault-level appearance and how it combines with personal choices.
//
// Owners/admins set defaults for everyone in a vault (`GET/PUT
// /api/orgs/:orgId/appearance`, live over the vault channel). Each personal
// setting is either an OVERRIDE (a value this device chose) or INHERIT (absent),
// and the value the app paints is:
//
//     personal override ?? vault value ?? app default
//
// Personal always wins. Pure on purpose: no store, no localStorage, so the
// whole rule is unit-tested in `__tests__/appearanceSettings.test.ts`.

import type { PropertiesMode } from "./editor/frontmatter";
import type { ThemeMode } from "./theme";

export type ContentWidth = number | "full";

/** The six settings a vault can default. A key may be absent on a vault row
 *  saved before every row became concrete; it then means the app default. */
export interface AppearanceSettings {
  theme?: ThemeMode;
  autoColors?: boolean;
  /** Same unit as the personal Content width slider (`EditorMeasure`). */
  contentWidth?: ContentWidth;
  textSize?: number;
  lineNumbers?: boolean;
  properties?: PropertiesMode;
}

export type AppearanceKey = keyof AppearanceSettings;
export type ResolvedAppearance = Required<AppearanceSettings>;

export const APPEARANCE_KEYS: readonly AppearanceKey[] = [
  "theme",
  "autoColors",
  "contentWidth",
  "textSize",
  "lineNumbers",
  "properties",
];

/** What a device that never chose anything, in a vault that set nothing, sees.
 *  Mirrors the readers in `prefs.ts` / `theme.ts`. */
export const APPEARANCE_DEFAULTS: ResolvedAppearance = {
  theme: "system",
  autoColors: true,
  contentWidth: "full",
  textSize: 16,
  lineNumbers: false,
  properties: "visible",
};

const CONTENT_WIDTH_MIN = 60;
const CONTENT_WIDTH_MAX = 120;
const TEXT_SIZE_MIN = 12;
const TEXT_SIZE_MAX = 24;

/** Validate one value for one key; anything unrecognised is `undefined`. */
export function validAppearanceValue<K extends AppearanceKey>(
  key: K,
  v: unknown,
): AppearanceSettings[K] | undefined {
  switch (key) {
    case "theme":
      return (v === "system" || v === "light" || v === "dark" ? v : undefined) as AppearanceSettings[K];
    case "autoColors":
    case "lineNumbers":
      return (typeof v === "boolean" ? v : undefined) as AppearanceSettings[K];
    case "contentWidth":
      if (v === "full") return v as AppearanceSettings[K];
      return (typeof v === "number" && Number.isFinite(v)
        ? Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, Math.round(v)))
        : undefined) as AppearanceSettings[K];
    case "textSize":
      return (typeof v === "number" && Number.isFinite(v)
        ? Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, Math.round(v)))
        : undefined) as AppearanceSettings[K];
    case "properties":
      return (v === "visible" || v === "hidden" || v === "source" ? v : undefined) as AppearanceSettings[K];
    default:
      return undefined;
  }
}

/** Parse a server `settings` object defensively: unknown keys and bad values drop. */
export function parseAppearanceSettings(raw: unknown): AppearanceSettings {
  const out: AppearanceSettings = {};
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const key of APPEARANCE_KEYS) {
    const v = validAppearanceValue(key, o[key]);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** The value the app paints for every key. `vault` is the OPEN vault's
 *  settings only — a theme (or anything else) from a vault you left never applies. */
export function effectiveAppearance(
  personal: AppearanceSettings,
  vault: AppearanceSettings | null | undefined,
  defaults: ResolvedAppearance = APPEARANCE_DEFAULTS,
): ResolvedAppearance {
  const out = { ...defaults } as Record<AppearanceKey, unknown>;
  for (const key of APPEARANCE_KEYS) {
    out[key] = personal[key] ?? vault?.[key] ?? defaults[key];
  }
  return out as unknown as ResolvedAppearance;
}

/** Where the painted value comes from — drives the personal page's tags.
 *  A synced vault always has a value for every key (a missing key is the app
 *  default), so with a vault open a row either inherits it or overrides it. */
export function appearanceSource(
  key: AppearanceKey,
  personal: AppearanceSettings,
  vault: AppearanceSettings | null | undefined,
): "personal" | "vault" | "default" {
  if (personal[key] !== undefined) return "personal";
  if (vault) return "vault";
  return "default";
}

/** The concrete value of every key for a vault: its saved value, else the app default. */
export function vaultAppearanceValues(
  vault: AppearanceSettings | null | undefined,
  defaults: ResolvedAppearance = APPEARANCE_DEFAULTS,
): ResolvedAppearance {
  return effectiveAppearance({}, vault, defaults);
}

/**
 * Upgrade rule for values stored before vault defaults existed. A stored value
 * is an OVERRIDE (nobody's look changes on upgrade) EXCEPT when it equals the
 * app default: that person never meaningfully chose, so it becomes INHERIT and
 * a vault default can reach them. Absent or invalid is INHERIT.
 */
export function migrateStoredAppearance(
  stored: Partial<Record<AppearanceKey, unknown>>,
  defaults: ResolvedAppearance = APPEARANCE_DEFAULTS,
): AppearanceSettings {
  const out: AppearanceSettings = {};
  for (const key of APPEARANCE_KEYS) {
    const v = validAppearanceValue(key, stored[key]);
    if (v === undefined || v === defaults[key]) continue;
    (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Return `s` with `key` set to `value`, or removed when `value` is undefined. */
export function withAppearance<K extends AppearanceKey>(
  s: AppearanceSettings,
  key: K,
  value: AppearanceSettings[K] | undefined,
): AppearanceSettings {
  const next = { ...s };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
