// SPDX-License-Identifier: Apache-2.0

/**
 * Vault-level appearance: what owners/admins set for everyone in a vault.
 * Every key is optional; an absent key means the app default. The desktop
 * mirrors this contract, so anything outside it is refused rather than stored.
 */
export type VaultAppearance = {
  theme?: "system" | "light" | "dark";
  autoColors?: boolean;
  /** Character widths, an integer 60..120, or the full editor width. */
  contentWidth?: number | "full";
  /** Pixels, 12..24. */
  textSize?: number;
  lineNumbers?: boolean;
  properties?: "visible" | "hidden" | "source";
};

export const CONTENT_WIDTH_MIN = 60;
export const CONTENT_WIDTH_MAX = 120;
export const TEXT_SIZE_MIN = 12;
export const TEXT_SIZE_MAX = 24;

const THEMES = new Set(["system", "light", "dark"]);
const PROPERTIES = new Set(["visible", "hidden", "source"]);

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

type Check = (v: unknown) => boolean;
const CHECKS: Record<keyof VaultAppearance, Check> = {
  theme: (v) => typeof v === "string" && THEMES.has(v),
  autoColors: (v) => typeof v === "boolean",
  contentWidth: (v) =>
    v === "full" || (Number.isInteger(v) && inRange(v, CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX)),
  textSize: (v) => inRange(v, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
  lineNumbers: (v) => typeof v === "boolean",
  properties: (v) => typeof v === "string" && PROPERTIES.has(v),
};

export type AppearanceParse =
  | { ok: true; settings: VaultAppearance }
  | { ok: false; error: "invalid_appearance"; key?: string };

/**
 * Validate a whole settings object. Unknown keys and bad values are refused
 * (never dropped), so a typo cannot silently reset a setting for everyone.
 * Returns a fresh object holding only the known keys.
 */
export function parseAppearance(input: unknown): AppearanceParse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_appearance" };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(CHECKS, key)) {
      return { ok: false, error: "invalid_appearance", key };
    }
    if (value === undefined) continue;
    if (!CHECKS[key as keyof VaultAppearance](value)) {
      return { ok: false, error: "invalid_appearance", key };
    }
    out[key] = value;
  }
  return { ok: true, settings: out as VaultAppearance };
}
