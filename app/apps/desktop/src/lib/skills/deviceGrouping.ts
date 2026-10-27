// "On this device" (Skills tab): every skill folder Rust's `skills_scan_device`
// found, folded so one skill shows once, then grouped by where it lives. Pure,
// pinned by `__tests__/deviceGrouping.test.ts`.
//
// One skill shows once:
// - a Baalda team copy is one card however many tool folders hold it (Baalda
//   writes a real copy into each, so their folders differ): merged by `skillId`;
// - a personal skill found in several folders is merged when it is the SAME
//   skill: same name and same description (a symlink trivially qualifies);
// - anything else stays apart. Two different "/frontend-design" skills are two
//   cards, each with a `hint` saying where it lives.

import type { DeviceSkill, SkillLocation, SkillMarker } from "../ipc";
import { AI_TOOL_NAME, AI_TOOLS, type ToolAvailability } from "./installState";

export type DeviceGroupKind = "team" | "personal" | "claudePlugin" | "codexPlugin" | "claudeOrg" | "codexSystem";

/** The AI tools a skill can be available in. */
export type DeviceTool = "claude" | "codex" | "cursor" | "gemini";

/**
 * Which skill folders each tool reads. Cursor's list follows its documented
 * folders (all three personal ones); Gemini CLI reads ~/.agents/skills.
 */
export const TOOL_LOCATIONS: Record<DeviceTool, readonly SkillLocation[]> = {
  claude: ["claudePersonal", "claudeSynced", "claudePlugin"],
  codex: ["agentsPersonal", "codexPersonal", "codexSystem", "codexPlugin"],
  cursor: ["agentsPersonal", "claudePersonal", "codexPersonal"],
  gemini: ["agentsPersonal"],
};

export const DEVICE_TOOLS: readonly DeviceTool[] = ["claude", "codex", "cursor", "gemini"];

/** Can `tool` use this skill? */
export function visibleTo(item: Pick<DeviceItem, "locations">, tool: DeviceTool): boolean {
  return item.locations.some((l) => TOOL_LOCATIONS[tool].includes(l));
}

/** "Claude · Codex": the main tools that use it, for a card's meta line. */
export function usedByText(item: Pick<DeviceItem, "locations">): string {
  const names = [visibleTo(item, "claude") ? "Claude" : null, visibleTo(item, "codex") ? "Codex" : null].filter(Boolean);
  return names.join(" · ");
}

const LOCATION_HINT: Record<SkillLocation, string> = {
  claudePersonal: "~/.claude/skills",
  claudeSynced: "claude.ai org",
  claudePlugin: "Claude plugin",
  agentsPersonal: "~/.agents/skills",
  codexPersonal: "~/.codex/skills",
  codexSystem: "Codex built-in",
  codexPlugin: "Codex plugin",
};

export interface DeviceItem {
  /** The resolved folder: one item per real folder. */
  realPath: string;
  name: string;
  description: string;
  fileCount: number;
  truncated: boolean;
  /** Every path it was found at (a symlinked skill has several). */
  paths: string[];
  locations: SkillLocation[];
  managed: SkillMarker | null;
  /** Where it lives, set only when another listed skill has the same name. */
  hint: string | null;
  /** false: a Claude plugin switched off in Claude's settings; null: not a plugin, or unknown. */
  enabled: boolean | null;
  pluginName: string | null;
  marketplace: string | null;
  pluginVersion: string | null;
}

export interface DeviceGroup {
  key: string;
  kind: DeviceGroupKind;
  label: string;
  items: DeviceItem[];
}

const PERSONAL: ReadonlySet<SkillLocation> = new Set(["claudePersonal", "agentsPersonal", "codexPersonal"]);
const KIND_ORDER: DeviceGroupKind[] = ["team", "personal", "claudePlugin", "codexPlugin", "claudeOrg", "codexSystem"];

function groupOf(item: DeviceItem): { key: string; kind: DeviceGroupKind; label: string } {
  if (item.managed) return { key: "team", kind: "team", label: "From your team" };
  if (item.locations.some((l) => PERSONAL.has(l))) return { key: "personal", kind: "personal", label: "Your skills" };
  if (item.locations.includes("claudePlugin") || item.locations.includes("codexPlugin")) {
    const kind = item.locations.includes("claudePlugin") ? "claudePlugin" : "codexPlugin";
    const plugin = item.pluginName ?? "plugin";
    const label = item.marketplace ? `${plugin} · ${item.marketplace}` : plugin;
    return { key: `${kind}|${plugin}|${item.marketplace ?? ""}`, kind, label };
  }
  if (item.locations.includes("claudeSynced")) return { key: "claudeOrg", kind: "claudeOrg", label: "Claude org (claude.ai)" };
  return { key: "codexSystem", kind: "codexSystem", label: "Codex built-in" };
}

/** The identity two entries share when they are the same skill (see the module note). */
function mergeKey(e: DeviceSkill): string {
  if (e.managed) return `team\0${e.managed.serverUrl}\0${e.managed.skillId}`;
  if (PERSONAL.has(e.location)) return `personal\0${e.name}\0${e.description}`;
  return `real\0${e.realPath}`;
}

/** Every distinct skill, merged as the module note says. */
export function deviceItems(entries: readonly DeviceSkill[]): DeviceItem[] {
  const byKey = new Map<string, DeviceItem>();
  // A symlinked folder found twice is one skill even before the name check.
  const keyOfReal = new Map<string, string>();
  for (const e of entries) {
    const key = keyOfReal.get(e.realPath) ?? mergeKey(e);
    keyOfReal.set(e.realPath, key);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        realPath: e.realPath,
        name: e.name,
        description: e.description,
        fileCount: e.fileCount,
        truncated: e.truncated,
        paths: [e.path],
        locations: [e.location],
        managed: e.managed,
        hint: null,
        enabled: e.enabled,
        pluginName: e.pluginName,
        marketplace: e.marketplace,
        pluginVersion: e.pluginVersion,
      });
      continue;
    }
    if (!existing.paths.includes(e.path)) existing.paths.push(e.path);
    if (!existing.locations.includes(e.location)) existing.locations.push(e.location);
    existing.managed ??= e.managed;
    if (e.enabled === true || existing.enabled === null) existing.enabled = e.enabled ?? existing.enabled;
    existing.pluginName ??= e.pluginName;
    existing.marketplace ??= e.marketplace;
    existing.pluginVersion ??= e.pluginVersion;
    if (!existing.description && e.description) existing.description = e.description;
  }
  const items = [...byKey.values()];
  const named = new Map<string, number>();
  for (const i of items) named.set(i.name, (named.get(i.name) ?? 0) + 1);
  for (const i of items) {
    if ((named.get(i.name) ?? 0) > 1) i.hint = i.locations.map((l) => LOCATION_HINT[l]).join(", ");
  }
  return items;
}

/** A plugin switched off in Claude: hidden unless asked for, never counted. */
export function isDisabled(item: Pick<DeviceItem, "enabled">): boolean {
  return item.enabled === false;
}

/**
 * How many skills "On this device" lists: disabled plugins don't count, and
 * neither do Baalda's copies of team skills (the Team tab shows those).
 */
export function countLive(items: readonly DeviceItem[]): number {
  return items.filter((i) => !isDisabled(i) && !i.managed).length;
}

/**
 * Group merged skills; `filter` matches name or description, and disabled
 * plugins are left out unless `showDisabled`.
 */
export function groupDeviceSkills(entries: readonly DeviceSkill[], filter = "", showDisabled = false): DeviceGroup[] {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, DeviceGroup>();
  for (const item of deviceItems(entries)) {
    if (!showDisabled && isDisabled(item)) continue;
    // Team skills live on the Team tab; this view is everything else here.
    if (item.managed) continue;
    if (needle && !`${item.name} ${item.description}`.toLowerCase().includes(needle)) continue;
    const g = groupOf(item);
    let group = groups.get(g.key);
    if (!group) {
      group = { ...g, items: [] };
      groups.set(g.key, group);
    }
    group.items.push(item);
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => a.name.localeCompare(b.name) || (a.hint ?? "").localeCompare(b.hint ?? ""));
  return out.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

/** "~/.claude/skills/x" for display, given the home folder when known. */
export function tildePath(path: string, home: string | null): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A device skill per AI tool: can that tool read one of the folders it's in? */
export function deviceAvailability(
  item: Pick<DeviceItem, "locations" | "enabled">,
  detected: Record<DeviceTool, boolean>,
): ToolAvailability[] {
  return AI_TOOLS.map((tool) => {
    if (!detected[tool]) return { tool, on: false, reason: `${AI_TOOL_NAME[tool]} isn't installed` };
    if (!visibleTo(item, tool)) return { tool, on: false, reason: `Not in a folder ${AI_TOOL_NAME[tool]} reads` };
    if (tool === "claude" && isDisabled(item)) return { tool, on: false, reason: "Plugin is off in Claude" };
    return { tool, on: true, reason: null };
  });
}
