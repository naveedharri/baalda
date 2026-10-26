// Device-local skill preferences (`docs/SKILLS.md` §5.2): which tool folders
// this machine writes, which Optional skills it opted into, and which edited
// copies the person chose to keep. Per device by design: opting in on a laptop
// says nothing about a desktop.
//
// localStorage can be missing, full, or throw in a locked-down webview; every
// access is guarded and a failure reads as the defaults.

import type { SkillTarget } from "../ipc";

export const SKILLS_PREFS_KEY = "context.skills.device.v1";

export interface SkillsDevicePrefs {
  targets: { claude: boolean; agents: boolean };
  /** key `${serverUrl}|${orgId}|${skillId}` */
  optIns: Record<string, true>;
  /** key `${serverUrl}|${orgId}|${skillId}|${target}` */
  keepMine: Record<string, true>;
  lastRunAt: string | null;
}

export type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

export function defaultSkillsPrefs(): SkillsDevicePrefs {
  return { targets: { claude: true, agents: true }, optIns: {}, keepMine: {}, lastRunAt: null };
}

/** Same normalization as `serverFeatures.ts urlKey`. */
export function normalizeServerUrl(serverUrl: string | null | undefined): string {
  return (serverUrl ?? "").trim().replace(/\/+$/, "");
}

export function optInKey(serverUrl: string, orgId: string, skillId: string): string {
  return `${normalizeServerUrl(serverUrl)}|${orgId}|${skillId}`;
}

export function keepMineKey(serverUrl: string, orgId: string, skillId: string, target: SkillTarget): string {
  return `${optInKey(serverUrl, orgId, skillId)}|${target}`;
}

function trueMap(v: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) if (val === true) out[k] = true;
  return out;
}

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored prefs, with anything missing or malformed replaced by its default. */
export function loadSkillsPrefs(storage: PrefsStorage | null = defaultStorage()): SkillsDevicePrefs {
  const prefs = defaultSkillsPrefs();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SKILLS_PREFS_KEY) ?? null;
  } catch {
    return prefs;
  }
  if (!raw) return prefs;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return prefs;
  }
  if (!v || typeof v !== "object") return prefs;
  const o = v as Record<string, unknown>;
  const t = o.targets as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    if (typeof t.claude === "boolean") prefs.targets.claude = t.claude;
    if (typeof t.agents === "boolean") prefs.targets.agents = t.agents;
  }
  prefs.optIns = trueMap(o.optIns);
  prefs.keepMine = trueMap(o.keepMine);
  if (typeof o.lastRunAt === "string") prefs.lastRunAt = o.lastRunAt;
  return prefs;
}

const listeners = new Set<(prefs: SkillsDevicePrefs) => void>();

/** Persist (best effort) and tell subscribers. Returns what was saved. */
export function saveSkillsPrefs(
  prefs: SkillsDevicePrefs,
  storage: PrefsStorage | null = defaultStorage(),
): SkillsDevicePrefs {
  try {
    storage?.setItem(SKILLS_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* full or blocked: the change still applies for this session */
  }
  for (const l of listeners) l(prefs);
  return prefs;
}

/** Read, change, save. */
export function updateSkillsPrefs(
  change: (prefs: SkillsDevicePrefs) => void,
  storage: PrefsStorage | null = defaultStorage(),
): SkillsDevicePrefs {
  const prefs = loadSkillsPrefs(storage);
  change(prefs);
  return saveSkillsPrefs(prefs, storage);
}

export function onSkillsPrefsChanged(cb: (prefs: SkillsDevicePrefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setSkillOptIn(serverUrl: string, orgId: string, skillId: string, on: boolean): SkillsDevicePrefs {
  return updateSkillsPrefs((p) => {
    const k = optInKey(serverUrl, orgId, skillId);
    if (on) p.optIns[k] = true;
    else delete p.optIns[k];
  });
}

export function setSkillKeepMine(
  serverUrl: string,
  orgId: string,
  skillId: string,
  target: SkillTarget,
  on: boolean,
): SkillsDevicePrefs {
  return updateSkillsPrefs((p) => {
    const k = keepMineKey(serverUrl, orgId, skillId, target);
    if (on) p.keepMine[k] = true;
    else delete p.keepMine[k];
  });
}

export function setSkillTarget(target: SkillTarget, on: boolean): SkillsDevicePrefs {
  return updateSkillsPrefs((p) => {
    p.targets[target] = on;
  });
}
