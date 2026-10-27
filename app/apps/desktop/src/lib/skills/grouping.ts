// The Skills tab's groups (components/skills/SkillsTab.tsx): skills made in the
// vault first, then one group per import source (repo, and plugin when the
// source names one), sorted by name. Pure, pinned by `__tests__/grouping.test.ts`.

import type { SkillSummary } from "./types";

export interface SkillGroup {
  /** "team", or `${repo}|${pluginName}` (repo lowercased). */
  key: string;
  kind: "team" | "source";
  /** "Shared with your team", "anthropics/skills", "owner/repo · plugin". */
  label: string;
  repo: string | null;
  skills: SkillSummary[];
}

export const TEAM_GROUP_LABEL = "Shared with your team";

export function groupSkills(skills: readonly SkillSummary[], filter = ""): SkillGroup[] {
  const needle = filter.trim().toLowerCase();
  const team: SkillGroup = { key: "team", kind: "team", label: TEAM_GROUP_LABEL, repo: null, skills: [] };
  const sources = new Map<string, SkillGroup>();
  for (const s of skills) {
    if (needle && !`${s.name} ${s.description} ${s.source?.repo ?? ""}`.toLowerCase().includes(needle)) continue;
    if (!s.source) {
      team.skills.push(s);
      continue;
    }
    const plugin = s.source.pluginName ?? null;
    const key = `${s.source.repo.toLowerCase()}|${plugin ?? ""}`;
    let g = sources.get(key);
    if (!g) {
      g = { key, kind: "source", label: plugin ? `${s.source.repo} · ${plugin}` : s.source.repo, repo: s.source.repo, skills: [] };
      sources.set(key, g);
    }
    g.skills.push(s);
  }
  const byName = (a: SkillSummary, b: SkillSummary) => a.name.localeCompare(b.name);
  const out = [team, ...[...sources.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))];
  for (const g of out) g.skills.sort(byName);
  return out.filter((g) => g.skills.length > 0);
}
