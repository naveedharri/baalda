import type { ReactElement } from "react";
import type { ThemeMode } from "../lib/theme";
import { useStore } from "../store";

const CYCLE: ThemeMode[] = ["light", "dark", "system"];

const ICONS: Record<ThemeMode, ReactElement> = {
  light: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
};

const LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Small pill that cycles the theme (light → dark → system). It shows the
 *  EFFECTIVE mode and records a personal override (`appearanceOverrides`). */
export function ThemeToggle() {
  const mode = useStore((s) => s.themeMode);
  const setMode = (next: ThemeMode) => useStore.getState().setAppearanceOverride("theme", next);
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setMode(CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length])}
      title={`Theme: ${LABELS[mode]} (click to change)`}
      aria-label={`Theme: ${LABELS[mode]}. Click to change.`}
    >
      <span className="theme-toggle-icon">{ICONS[mode]}</span>
      <span className="theme-toggle-label">{LABELS[mode]}</span>
    </button>
  );
}
