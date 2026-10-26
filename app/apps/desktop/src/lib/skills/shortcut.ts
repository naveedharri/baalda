// The sidebar Skills shortcut's attention dot: is there something about team
// skills on THIS computer worth a look? Pure, pinned by `__tests__/shortcut.test.ts`.

import type { SkillTargetResult } from "./syncEngine";
import type { SkillSummary } from "./types";

const NEW_WINDOW_MS = 7 * 24 * 60 * 60_000;
const UPDATE_WINDOW_MS = 24 * 60 * 60_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Null when nothing needs attention; else one tooltip line naming what does. */
export function shortcutAttention(input: {
  orgId: string;
  skills: readonly SkillSummary[] | null;
  results: readonly SkillTargetResult[];
  recentUpdates: readonly { orgId: string; skillId: string; at: string }[];
  isOn: (skillId: string) => boolean;
  now?: number;
}): string | null {
  const now = input.now ?? Date.now();
  const parts: string[] = [];
  const broken = new Set(
    input.results.filter((r) => r.orgId === input.orgId && (r.state === "edited" || r.state === "failed")).map((r) => r.skillId),
  );
  if (broken.size) parts.push(`${plural(broken.size, "skill needs", "skills need")} a look on this computer`);
  const fresh = (input.skills ?? []).filter(
    (s) =>
      s.delivery === "optional" &&
      s.latestVersion === 1 &&
      s.latestPublishedAt !== null &&
      now - Date.parse(s.latestPublishedAt) < NEW_WINDOW_MS &&
      !input.isOn(s.id),
  ).length;
  if (fresh) parts.push(`${plural(fresh, "new team skill", "new team skills")} to install`);
  const updated = new Set(
    input.recentUpdates.filter((u) => u.orgId === input.orgId && now - Date.parse(u.at) < UPDATE_WINDOW_MS).map((u) => u.skillId),
  ).size;
  if (updated) parts.push(`${plural(updated, "skill", "skills")} just updated`);
  return parts.length ? parts.join(" · ") : null;
}

// ---- "New" chip: until the shortcut itself is clicked on this computer -------

// v2: the chip now clears only on a click of the shortcut (v1 cleared on any
// open of the Skills tab), so it shows again once for everyone.
const SEEN_KEY = "context.skills.shortcutSeen.v2";
const seenListeners = new Set<() => void>();

/** Has this person clicked the sidebar Skills shortcut on this computer? */
export function shortcutSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // no storage: never nag
  }
}

/** The shortcut was clicked: it drops its "New" chip (other routes to the tab don't count). */
export function markShortcutSeen(): void {
  if (shortcutSeen()) return;
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* storage unavailable */ }
  for (const l of seenListeners) l();
}

export function onShortcutSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}
