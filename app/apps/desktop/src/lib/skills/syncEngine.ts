// Team skills → this machine's tool folders (`docs/SKILLS.md` §5.3).
//
// PURE: the planner takes the server's manifest, the device prefs and what Rust
// found on disk, and answers a list of actions; the runner carries them out
// through injected functions. No ipc/api import (types only), so every rule
// below is pinned by `__tests__/syncEngine.test.ts` without a webview.
//
// The rules that keep this safe:
// - A folder is ours only when its `.baalda-managed.json` names THIS server and
//   THIS user (a marker without a user predates per-user markers and counts as
//   ours). Another server's or account's copy, or a folder someone made by
//   hand, is never touched.
// - Nothing is removed unless the manifest fetch succeeded: a failed fetch
//   produces no plan at all, so a flaky network cannot uninstall anything.
// - An edited copy is never overwritten by a run; only "Use team version"
//   (`forceInstallSkill`) does, and Rust backs the edited copy up first.
// - An edited (or kept-mine) copy that is no longer wanted is RELEASED, not
//   deleted: Rust drops only the marker and the folder stays as the user's own.

import type {
  InstalledSkill,
  SkillFilePayload,
  SkillInstallOutcome,
  SkillMarker,
  SkillOwner,
  SkillRemoveMode,
  SkillRemoveOutcome,
  SkillTarget,
  SkillTargetInfo,
} from "../ipc";
import { keepMineKey, normalizeServerUrl, optInKey, type SkillsDevicePrefs } from "./prefs";
import type { ManifestOrg, ManifestSkill, SkillsManifest, SkillVersionWithFiles } from "./types";
import { skillDisplayName } from "./display";

export const SKILL_TARGETS: readonly SkillTarget[] = ["claude", "agents"];

export type RemoveReason = "deleted" | "optedOut" | "lostMembership" | "targetOff";
export type PlanStatus = "conflict" | "edited" | "keptMine" | "upToDate";
/**
 * Why a name is taken: `unmanaged` = a folder of the person's own (no marker
 * of ours; "Use team version" can back it up and replace it, unless it is a
 * symlink), `other_owner` = another skill, vault, server or user holds it.
 */
export type ConflictKind = "unmanaged" | "other_owner";
/** `release` keeps the folder and drops only our marker (an edited or kept copy). */
export type RemoveMode = SkillRemoveMode;

export type SkillAction =
  | { kind: "install"; target: SkillTarget; orgId: string; skill: ManifestSkill; fromVersion: number | null }
  | { kind: "remove"; target: SkillTarget; name: string; owner: SkillOwner; reason: RemoveReason; mode: RemoveMode }
  | { kind: "status"; target: SkillTarget; orgId: string; skillId: string; name: string; status: PlanStatus; conflict?: ConflictKind };

export type SkillsPlan = SkillAction[];

export interface SkillsPlanInput {
  serverUrl: string;
  /** The signed-in user: another user's marker is foreign. */
  userId: string;
  /** null = the manifest fetch failed: plan nothing. */
  manifest: SkillsManifest | null;
  prefs: SkillsDevicePrefs;
  targets: SkillTargetInfo[];
  installed: Record<SkillTarget, InstalledSkill[]>;
  /** Folders that already refused adoption of this version (`conflictKey`), and why: not re-asked. */
  knownConflicts?: ReadonlyMap<string, ConflictKind>;
}

interface Wanted {
  org: ManifestOrg;
  skill: ManifestSkill;
}

/** Is this Optional skill turned on for this device? Required ones always are. */
export function isWanted(serverUrl: string, prefs: SkillsDevicePrefs, orgId: string, skill: ManifestSkill): boolean {
  return skill.delivery === "required" || prefs.optIns[optInKey(serverUrl, orgId, skill.skillId)] === true;
}

function sameServer(a: string, b: string): boolean {
  return normalizeServerUrl(a) === normalizeServerUrl(b);
}

/** This server's and this user's marker. No `userId` = a legacy marker: ours. */
export function isOurMarker(m: SkillMarker | null | undefined, serverUrl: string, userId: string): m is SkillMarker {
  if (!m || !sameServer(m.serverUrl, serverUrl)) return false;
  return !m.userId || m.userId === userId;
}

function byOrgName(a: Wanted, b: Wanted): number {
  const n = a.org.orgName.localeCompare(b.org.orgName);
  return n !== 0 ? n : a.org.orgId < b.org.orgId ? -1 : a.org.orgId > b.org.orgId ? 1 : 0;
}

/** §5.3. Removals come first so a name freed by one skill can be taken by another. */
export function planSkillsSync(input: SkillsPlanInput): SkillsPlan {
  const { serverUrl, userId, manifest, prefs } = input;
  const ours = (m: SkillMarker | null | undefined): m is SkillMarker => isOurMarker(m, serverUrl, userId);
  if (!manifest) return [];
  const removes: SkillAction[] = [];
  const rest: SkillAction[] = [];
  const orgs = new Map(manifest.orgs.map((o) => [o.orgId, o]));
  const available = new Set(input.targets.map((t) => t.target));

  for (const target of SKILL_TARGETS) {
    if (!available.has(target)) continue;
    const on = prefs.targets[target];
    const installed = input.installed[target] ?? [];
    const byName = new Map(installed.map((e) => [e.name.toLowerCase(), e]));

    // Wanted per name, then one winner per name.
    const wantedByName = new Map<string, Wanted[]>();
    if (on) {
      for (const org of manifest.orgs) {
        for (const skill of org.skills) {
          if (!isWanted(serverUrl, prefs, org.orgId, skill)) continue;
          const k = skill.name.toLowerCase();
          wantedByName.set(k, [...(wantedByName.get(k) ?? []), { org, skill }]);
        }
      }
    }
    const winners = new Map<string, Wanted>();
    for (const [k, list] of wantedByName) {
      const marker = byName.get(k)?.marker;
      const holder =
        ours(marker)
          ? list.find((w) => w.skill.skillId === marker.skillId && w.org.orgId === marker.orgId)
          : undefined;
      const winner = holder ?? [...list].sort(byOrgName)[0];
      winners.set(k, winner);
      for (const w of list) {
        if (w === winner) continue;
        rest.push({ kind: "status", target, orgId: w.org.orgId, skillId: w.skill.skillId, name: w.skill.name, status: "conflict", conflict: "other_owner" });
      }
    }

    // Owned and no longer wanted here ⇒ remove.
    for (const entry of installed) {
      const m = entry.marker;
      if (entry.status === "unmanaged" || !ours(m)) continue;
      const keeper = winners.get(entry.name.toLowerCase());
      if (keeper && keeper.skill.skillId === m.skillId && keeper.org.orgId === m.orgId) continue;
      const owner: SkillOwner = { skillId: m.skillId, orgId: m.orgId, serverUrl: m.serverUrl, userId };
      const org = orgs.get(m.orgId);
      let reason: RemoveReason;
      if (!on) reason = "targetOff";
      else if (!org) reason = "lostMembership";
      else {
        const skill = org.skills.find((s) => s.skillId === m.skillId);
        if (!skill) reason = "deleted";
        else if (!isWanted(serverUrl, prefs, org.orgId, skill)) reason = "optedOut";
        // Wanted but lost its name to another org's skill: leave it in place.
        else continue;
      }
      // An edited or kept copy stays as the user's own skill; a clean one goes.
      const kept = prefs.keepMine[keepMineKey(serverUrl, m.orgId, m.skillId, target)] === true;
      const mode: RemoveMode = entry.status === "edited" || kept ? "release" : "delete";
      removes.push({ kind: "remove", target, name: entry.name, owner, reason, mode });
    }

    // Each winner: install, or say why not.
    for (const [k, { org, skill }] of winners) {
      const entry = byName.get(k);
      const status = (s: PlanStatus, conflict?: ConflictKind): SkillAction => ({
        kind: "status", target, orgId: org.orgId, skillId: skill.skillId, name: skill.name, status: s,
        ...(conflict ? { conflict } : {}),
      });
      if (!entry) {
        rest.push({ kind: "install", target, orgId: org.orgId, skill, fromVersion: null });
        continue;
      }
      const m = entry.marker;
      if (entry.status === "unmanaged") {
        // A folder of our name with no marker: offer it to Rust once, which
        // adopts it when its files are exactly this version's (writing only
        // the marker) and otherwise answers conflict, touching nothing. A
        // folder that already said conflict for this version isn't re-asked,
        // and one the person chose to keep ("Keep my own") is left alone.
        if (prefs.keepMine[keepMineKey(serverUrl, org.orgId, skill.skillId, target)] === true) rest.push(status("keptMine"));
        else {
          const known = input.knownConflicts?.get(conflictKey(target, skill));
          if (known) rest.push(status("conflict", known));
          else rest.push({ kind: "install", target, orgId: org.orgId, skill, fromVersion: null });
        }
        continue;
      }
      if (!ours(m)) {
        rest.push(status("conflict", "other_owner"));
        continue;
      }
      if (m.skillId !== skill.skillId || m.orgId !== org.orgId) {
        // The holder is another of our skills that is not wanted: it is
        // removed above, then this one takes the folder.
        rest.push({ kind: "install", target, orgId: org.orgId, skill, fromVersion: null });
        continue;
      }
      if (entry.status === "edited") {
        const kept = prefs.keepMine[keepMineKey(serverUrl, org.orgId, skill.skillId, target)] === true;
        rest.push(status(kept ? "keptMine" : "edited"));
        continue;
      }
      if (m.version !== skill.version || m.bundleSha256 !== skill.bundleSha256) {
        rest.push({ kind: "install", target, orgId: org.orgId, skill, fromVersion: m.version });
        continue;
      }
      rest.push(status("upToDate"));
    }
  }
  return [...removes, ...rest];
}

// ---- Runner -----------------------------------------------------------------

export interface SkillsRunDeps {
  serverUrl: string;
  /** Stamped into every marker this device writes. */
  userId: string;
  fetchVersion: (orgId: string, skillId: string, version: number) => Promise<SkillVersionWithFiles>;
  install: (
    target: SkillTarget,
    name: string,
    marker: SkillMarker,
    files: SkillFilePayload[],
    force: boolean,
    replaceUnmanaged?: boolean,
  ) => Promise<SkillInstallOutcome>;
  remove: (target: SkillTarget, name: string, owner: SkillOwner, mode: RemoveMode) => Promise<SkillRemoveOutcome>;
  /** Checked between actions: a stopped host (sign-out, server switch) runs nothing more. */
  shouldStop?: () => boolean;
}

/** Per target, what the device shows for one skill. */
export type SkillTargetState = "upToDate" | "updating" | "edited" | "keptMine" | "conflict" | "failed";

export interface SkillTargetResult {
  orgId: string;
  skillId: string;
  name: string;
  target: SkillTarget;
  state: SkillTargetState;
  /** Set when a run changed the installed version. */
  fromVersion?: number | null;
  version?: number;
  backupPath?: string | null;
  error?: string;
  /** With `state: "conflict"`: whose folder holds the name. */
  conflict?: ConflictKind;
}

export interface SkillsRunResult {
  results: SkillTargetResult[];
  removed: { target: SkillTarget; name: string; reason: RemoveReason; mode: RemoveMode; backupPath: string | null }[];
  /** One entry per skill whose installed version changed (not per target). */
  updated: { skillId: string; name: string; from: number; to: number; codex: boolean }[];
  /** Skills installed for the first time on this device. `codex`: it reached
   *  ~/.agents/skills, which Codex only reads when a chat starts. */
  added: { skillId: string; name: string; version: number; codex: boolean }[];
  errors: string[];
}

function payloadOf(v: SkillVersionWithFiles): SkillFilePayload[] {
  return v.files.map((f) => ({ path: f.path, contentBase64: f.contentBase64, sha256: f.sha256, executable: f.executable }));
}

function markerOf(deps: SkillsRunDeps, orgId: string, skill: ManifestSkill, v: SkillVersionWithFiles): SkillMarker {
  const files: Record<string, string> = {};
  for (const f of v.files) files[f.path] = f.sha256;
  return {
    skillId: skill.skillId,
    orgId,
    serverUrl: normalizeServerUrl(deps.serverUrl),
    userId: deps.userId,
    name: skill.name,
    version: skill.version,
    bundleSha256: skill.bundleSha256,
    files,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const STATE_OF: Record<SkillInstallOutcome["status"], SkillTargetState> = {
  installed: "upToDate",
  adopted: "upToDate",
  unchanged: "upToDate",
  conflict: "conflict",
  edited: "edited",
};

/** Carry out a plan. One version fetch per skill version, shared by both targets. */
export async function runSkillsPlan(plan: SkillsPlan, deps: SkillsRunDeps): Promise<SkillsRunResult> {
  const out: SkillsRunResult = { results: [], removed: [], updated: [], added: [], errors: [] };
  const versions = new Map<string, Promise<SkillVersionWithFiles>>();
  const fetchOnce = (orgId: string, skill: ManifestSkill) => {
    const k = `${orgId}|${skill.skillId}|${skill.version}`;
    let p = versions.get(k);
    if (!p) {
      p = deps.fetchVersion(orgId, skill.skillId, skill.version);
      versions.set(k, p);
    }
    return p;
  };

  // Skills this device already had (any target) do not count as "added".
  const hadBefore = new Set<string>();
  for (const a of plan) {
    if (a.kind === "status" && a.status !== "conflict") hadBefore.add(a.skillId);
    if (a.kind === "install" && a.fromVersion !== null) hadBefore.add(a.skill.skillId);
  }
  const updated = new Map<string, SkillsRunResult["updated"][number]>();
  const added = new Map<string, SkillsRunResult["added"][number]>();

  for (const a of plan) {
    if (deps.shouldStop?.()) break;
    if (a.kind === "status") {
      out.results.push({
        orgId: a.orgId, skillId: a.skillId, name: a.name, target: a.target, state: a.status,
        ...(a.conflict ? { conflict: a.conflict } : {}),
      });
      continue;
    }
    if (a.kind === "remove") {
      try {
        const r = await deps.remove(a.target, a.name, a.owner, a.mode);
        if (r.status === "removed" || r.status === "released") {
          out.removed.push({ target: a.target, name: a.name, reason: a.reason, mode: a.mode, backupPath: r.backupPath });
        }
      } catch (e) {
        out.errors.push(`${a.name}: ${message(e)}`);
      }
      continue;
    }
    const { target, orgId, skill } = a;
    const base = { orgId, skillId: skill.skillId, name: skill.name, target };
    try {
      const v = await fetchOnce(orgId, skill);
      const r = await deps.install(target, skill.name, markerOf(deps, orgId, skill, v), payloadOf(v), false);
      out.results.push({
        ...base, state: STATE_OF[r.status], fromVersion: a.fromVersion, version: skill.version, backupPath: r.backupPath,
        ...(r.status === "conflict" ? { conflict: conflictKindOf(r.detail) } : {}),
      });
      if (r.status !== "installed") continue;
      if (a.fromVersion !== null && a.fromVersion !== skill.version) {
        const codex = (updated.get(skill.skillId)?.codex ?? false) || target === "agents";
        updated.set(skill.skillId, { skillId: skill.skillId, name: skill.name, from: a.fromVersion, to: skill.version, codex });
      } else if (a.fromVersion === null && !hadBefore.has(skill.skillId)) {
        const codex = (added.get(skill.skillId)?.codex ?? false) || target === "agents";
        added.set(skill.skillId, { skillId: skill.skillId, name: skill.name, version: skill.version, codex });
      }
    } catch (e) {
      out.results.push({ ...base, state: "failed", error: message(e) });
      out.errors.push(`${skill.name}: ${message(e)}`);
    }
  }
  out.updated = [...updated.values()];
  out.added = [...added.values()];
  return out;
}

/** Rust's conflict `detail`; anything but `unmanaged` is someone else's folder. */
export function conflictKindOf(detail: string | null | undefined): ConflictKind {
  return detail === "unmanaged" ? "unmanaged" : "other_owner";
}

/** Key for a folder that refused this version (see `knownConflicts`). */
export function conflictKey(target: SkillTarget, skill: Pick<ManifestSkill, "name" | "bundleSha256">): string {
  return `${target}|${skill.name.toLowerCase()}|${skill.bundleSha256}`;
}

/** "Use team version" on a name taken by the person's own folder: back it up, then install. */
export async function replaceUnmanagedSkill(
  deps: SkillsRunDeps,
  target: SkillTarget,
  orgId: string,
  skill: ManifestSkill,
): Promise<SkillInstallOutcome> {
  const v = await deps.fetchVersion(orgId, skill.skillId, skill.version);
  return deps.install(target, skill.name, markerOf(deps, orgId, skill, v), payloadOf(v), false, true);
}

/** "Use team version": overwrite an edited copy (Rust backs it up first). */
export async function forceInstallSkill(
  deps: SkillsRunDeps,
  target: SkillTarget,
  orgId: string,
  skill: ManifestSkill,
): Promise<SkillInstallOutcome> {
  const v = await deps.fetchVersion(orgId, skill.skillId, skill.version);
  return deps.install(target, skill.name, markerOf(deps, orgId, skill, v), payloadOf(v), true);
}

/** The toast lines for one run (§5.4). Removals and conflicts stay silent. */
/** Codex lists a new or changed skill only in a chat started after it lands. */
export const CODEX_NEW_CHAT_HINT = "Start a new Codex chat to see it";

export function runToasts(result: Pick<SkillsRunResult, "updated" | "added">): string[] {
  const hint = (codex: boolean) => (codex ? `. ${CODEX_NEW_CHAT_HINT}` : "");
  const lines = result.updated.map((u) => `Updated ${skillDisplayName(u.name)} v${u.from} → v${u.to}${hint(u.codex)}`);
  if (result.added.length === 1) {
    const a = result.added[0];
    lines.push(`Added ${skillDisplayName(a.name)} v${a.version}${hint(a.codex)}`);
  } else if (result.added.length > 1) {
    lines.push(`Added ${result.added.length} team skills${hint(result.added.some((a) => a.codex))}`);
  }
  return lines;
}

/** Plan statuses as device states, with installs shown as in progress. */
export function pendingStates(plan: SkillsPlan): SkillTargetResult[] {
  const out: SkillTargetResult[] = [];
  for (const a of plan) {
    if (a.kind === "status") {
      out.push({
        orgId: a.orgId, skillId: a.skillId, name: a.name, target: a.target, state: a.status,
        ...(a.conflict ? { conflict: a.conflict } : {}),
      });
    } else if (a.kind === "install") {
      out.push({
        orgId: a.orgId, skillId: a.skill.skillId, name: a.skill.name, target: a.target,
        state: "updating", fromVersion: a.fromVersion, version: a.skill.version,
      });
    }
  }
  return out;
}
