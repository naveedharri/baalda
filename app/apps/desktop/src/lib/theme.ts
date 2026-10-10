// Theme controller. The user cycles light → dark → system; the choice persists
// in localStorage. "system" follows the OS via prefers-color-scheme and updates
// live. We resolve the mode to a concrete theme and stamp `data-theme` on the
// root element so tokens.css only needs :root (light) + [data-theme="dark"].

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "cbk-theme";
const MODES: ThemeMode[] = ["light", "dark", "system"];

const mql = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Resolve a mode to the concrete theme that should be painted. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return mql()?.matches ? "dark" : "light";
  return mode;
}

/** Stamp the resolved theme onto <html> so the token overrides apply. */
function paint(mode: ThemeMode) {
  if (typeof document === "undefined") return; // node tests import the store
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

/** Persist + apply a mode. */
export function setThemeMode(mode: ThemeMode) {
  if (mode === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
  paint(mode);
}

/** Advance to the next mode in the cycle and apply it; returns the new mode. */
export function cycleThemeMode(): ThemeMode {
  const next = MODES[(MODES.indexOf(getThemeMode()) + 1) % MODES.length];
  setThemeMode(next);
  return next;
}

/**
 * Call once at startup: paint the stored mode and keep "system" in sync with the
 * OS. Returns a disposer (unused in practice — app lifetime === process).
 */
/** The EFFECTIVE mode (personal override ?? open vault default ?? system),
 *  pushed by the store whenever any input changes (`lib/appearance.ts`).
 *  Null until the store first applies, so startup paints the stored mode. */
let effectiveMode: ThemeMode | null = null;

/** Paint the effective mode. Does not persist: the personal override lives in
 *  the store's appearance overrides, and a vault default is never stored here. */
export function applyEffectiveTheme(mode: ThemeMode): void {
  effectiveMode = mode;
  paint(mode);
}

export function initTheme(): () => void {
  paint(effectiveMode ?? getThemeMode());
  const m = mql();
  const onChange = () => {
    if ((effectiveMode ?? getThemeMode()) === "system") paint("system");
  };
  m?.addEventListener?.("change", onChange);
  return () => m?.removeEventListener?.("change", onChange);
}
