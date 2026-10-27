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

// ---- "New" chip: for 14 days from its first showing on this computer ---------

// v3: shown for a fixed window rather than until a click (v1: any open of the
// tab, v2: a click of the shortcut), so it shows again for everyone.
const NEW_CHIP_KEY = "context.skills.newChip.v3";
export const NEW_CHIP_MS = 14 * 24 * 60 * 60_000;

/**
 * Should the sidebar row wear its "New" chip? The first call on this computer
 * stamps when it was first shown; it shows until `NEW_CHIP_MS` after that.
 * No storage: shown for the session.
 */
export function showNewChip(now = Date.now()): boolean {
  try {
    const first = Number(localStorage.getItem(NEW_CHIP_KEY));
    if (first > 0) return now - first < NEW_CHIP_MS;
    localStorage.setItem(NEW_CHIP_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}
