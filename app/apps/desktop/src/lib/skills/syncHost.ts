// Wires the pure skills engine (`syncEngine.ts`) to Rust, the server, toasts
// and timers (`docs/SKILLS.md` §5.4).
//
// One host runs while a user is signed in to a server that advertises
// `skills`. A run fetches the manifest of EVERY vault the user belongs to on
// that server (not only the open one), so a teammate's publish in another vault
// still lands; the open vault's `skills-changed` frame only makes it sooner,
// and the 15-minute poll covers the rest.
//
// The device view lives here as a module-level store, like `toast.ts`: AI tools
// is its only reader and the Zustand store is a vault mirror, not this.

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api";
import * as ipc from "../ipc";
import type { SkillTarget, SkillTargetInfo } from "../ipc";
import { serverFeatures } from "../serverFeatures";
import { toast } from "../toast";
import {
  keepMineKey,
  loadSkillsPrefs,
  normalizeServerUrl,
  optInKey,
  setSkillKeepMine,
  setSkillOptIn,
  setSkillTarget,
  updateSkillsPrefs,
} from "./prefs";
import {
  conflictKey,
  conflictKindOf,
  type ConflictKind,
  forceInstallSkill,
  impliedOptIns,
  replaceUnmanagedSkill,
  pendingStates,
  planSkillsSync,
  runSkillsPlan,
  runToasts,
  type SkillsRunDeps,
  type SkillTargetResult,
} from "./syncEngine";
import type { ManifestSkill, SkillDelivery, SkillsManifest } from "./types";
import { skillDisplayName } from "./display";

export const SKILLS_FEATURE = "skills";
export const SKILLS_POLL_MS = 15 * 60 * 1000;
export const SKILLS_FRAME_DEBOUNCE_MS = 500;
/** Open pages coalesce a burst of frames (a marketplace import) into one reload. */
export const SKILLS_VIEW_DEBOUNCE_MS = 150;

export interface SkillsDeviceState {
  /** A host is running for a signed-in user. */
  active: boolean;
  /** The server answered and lacks `skills`. */
  unsupported: boolean;
  running: boolean;
  serverUrl: string | null;
  targets: SkillTargetInfo[];
  manifest: SkillsManifest | null;
  /** Latest state per (vault, skill, target). */
  results: SkillTargetResult[];
  lastRunAt: string | null;
  /** Why the last run planned nothing (manifest or folder check failed). */
  lastError: string | null;
  /** Skills a run updated on this computer this session (for the sidebar dot). */
  recentUpdates: { orgId: string; skillId: string; at: string }[];
}

const IDLE: SkillsDeviceState = {
  active: false,
  unsupported: false,
  running: false,
  serverUrl: null,
  targets: [],
  manifest: null,
  results: [],
  lastRunAt: null,
  lastError: null,
  recentUpdates: [],
};

let state: SkillsDeviceState = IDLE;
const listeners = new Set<(s: SkillsDeviceState) => void>();

function setState(patch: Partial<SkillsDeviceState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function getSkillsDeviceState(): SkillsDeviceState {
  return state;
}

export function useSkillsDeviceState(): SkillsDeviceState {
  const [s, set] = useState(state);
  useEffect(() => {
    set(state);
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Host {
  serverUrl: string;
  api: ApiClient;
  deps: SkillsRunDeps;
  request: () => void;
  /** While a server switch is under way no run starts, plans or acts. */
  setPaused: (paused: boolean) => void;
}

let host: Host | null = null;
/** The running host's debounced `skills-changed` reaction. */
let frameHandler: (() => void) | null = null;

/**
 * Start syncing team skills for the signed-in user. Returns the stop function;
 * a server switch is a stop followed by a start with the new URL.
 */
export function startSkillsSync({
  api,
  getServerUrl,
  userId,
}: {
  api: ApiClient;
  getServerUrl: () => string;
  /** The signed-in user, stamped into every marker; another user's copies are foreign. */
  userId: string;
}): () => void {
  const serverUrl = normalizeServerUrl(getServerUrl());
  let stopped = false;
  let paused = false;
  // The API client is shared and a server switch repoints it before this host
  // is stopped: a run that would read another server's manifest plans nothing.
  const halted = () => stopped || paused || normalizeServerUrl(api.getBaseUrl()) !== serverUrl;
  let running = false;
  let queued = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;

  const deps: SkillsRunDeps = {
    serverUrl,
    userId,
    fetchVersion: (orgId, skillId, version) => api.getSkillVersion(orgId, skillId, version),
    install: ipc.skillsInstall,
    remove: ipc.skillsRemove,
    shouldStop: halted,
  };

  const knownConflicts = new Map<string, ConflictKind>();

  const runOnce = async () => {
    if (halted()) return;
    const features = await serverFeatures(serverUrl, () => api.getHealth(serverUrl));
    if (halted()) return;
    if (!features.has(SKILLS_FEATURE)) {
      // An empty set is also "unknown" (unreachable): only say unsupported
      // when the server answered with features at all.
      setState({ unsupported: features.size > 0 });
      return;
    }
    setState({ unsupported: false, running: true });
    let targets: SkillTargetInfo[];
    let manifest: SkillsManifest;
    try {
      targets = await ipc.skillsTargets();
      manifest = await api.getSkillsManifest();
    } catch (e) {
      // No manifest, no plan: nothing is installed or removed on a failure.
      if (!stopped) setState({ running: false, lastError: message(e) });
      return;
    }
    // Fetched through a client that may have moved to another server since
    // this host started: that manifest says nothing about our markers.
    if (halted()) {
      if (!stopped) setState({ running: false });
      return;
    }
    // A folder that could not be read is left out of this run entirely.
    const installed = { claude: [], agents: [] } as Record<SkillTarget, ipc.InstalledSkill[]>;
    const scanned: SkillTargetInfo[] = [];
    for (const t of targets) {
      try {
        installed[t.target] = await ipc.skillsScan(t.target);
        scanned.push(t);
      } catch {
        /* skipped this run */
      }
    }
    if (halted()) {
      if (!stopped) setState({ running: false });
      return;
    }
    // A skill switched to Optional stays where it is already installed.
    const implied = impliedOptIns(serverUrl, userId, manifest, loadSkillsPrefs(), installed);
    if (implied.length > 0) {
      updateSkillsPrefs((p) => {
        for (const k of implied) p.optIns[k] = true;
      });
    }
    const prefs = loadSkillsPrefs();
    const plan = planSkillsSync({ serverUrl, userId, manifest, prefs, targets: scanned, installed, knownConflicts });
    setState({ targets, manifest, results: pendingStates(plan), lastError: null });
    const result = await runSkillsPlan(plan, deps);
    // A folder of ours by name that refused adoption: don't fetch and ask again
    // for the same version this session.
    for (const a of plan) {
      if (a.kind !== "install" || a.fromVersion !== null) continue;
      const r = result.results.find((x) => x.skillId === a.skill.skillId && x.target === a.target);
      if (r?.state === "conflict") knownConflicts.set(conflictKey(a.target, a.skill), r.conflict ?? "other_owner");
    }
    if (stopped) return;
    if (halted()) {
      setState({ running: false });
      return;
    }
    const at = new Date().toISOString();
    updateSkillsPrefs((p) => {
      p.lastRunAt = at;
    });
    const byId = new Map(manifest.orgs.flatMap((o) => o.skills.map((k) => [k.skillId, o.orgId] as const)));
    const landed = result.updated.map((u) => ({ orgId: byId.get(u.skillId) ?? "", skillId: u.skillId, at }));
    setState({
      running: false,
      results: result.results,
      lastRunAt: at,
      recentUpdates: [...state.recentUpdates.filter((r) => !landed.some((l) => l.skillId === r.skillId)), ...landed],
    });
    // A skill installed from its page announces itself there ("Installed /x ·
    // ready in …"); the run doesn't add a second "Added /x v1".
    const added = result.added.filter((a) => !quietAdds.delete(a.skillId));
    for (const line of runToasts({ ...result, added })) toast(line);
  };

  const request = () => {
    if (stopped || paused) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    void runOnce()
      .catch((e) => {
        if (!stopped) setState({ running: false, lastError: message(e) });
      })
      .finally(() => {
        running = false;
        if (queued && !stopped) {
          queued = false;
          request();
        }
      });
  };

  const self: Host = {
    serverUrl,
    api,
    deps,
    request,
    setPaused: (p) => {
      paused = p;
    },
  };
  host = self;
  setState({ ...IDLE, active: true, serverUrl, lastRunAt: loadSkillsPrefs().lastRunAt });
  frameHandler = () => {
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = setTimeout(() => {
      frameTimer = null;
      request();
    }, SKILLS_FRAME_DEBOUNCE_MS);
  };
  const poll = setInterval(request, SKILLS_POLL_MS);
  request();

  return () => {
    stopped = true;
    clearInterval(poll);
    if (frameTimer) clearTimeout(frameTimer);
    frameHandler = null;
    if (host === self) {
      host = null;
      setState(IDLE);
    }
  };
}

/**
 * Hold the running host for a server switch (`store.setServerUrl`): nothing
 * starts, plans or acts until the returned resume is called. A switch that
 * lands restarts the host for the new server (App's effect), so the caller
 * resumes only when it did not.
 */
export function pauseSkillsSync(): () => void {
  const h = host;
  if (!h) return () => {};
  h.setPaused(true);
  return () => {
    if (host !== h) return;
    h.setPaused(false);
    // A request dropped while paused (poll, frame, a switch) runs now.
    h.request();
  };
}

const viewListeners = new Set<(orgId: string) => void>();
const viewTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The vault channel's `skills-changed` frame (any vault): refetch, debounced. */
export function notifySkillsChanged(orgId: string): void {
  frameHandler?.();
  clearTimeout(viewTimers.get(orgId));
  viewTimers.set(
    orgId,
    setTimeout(() => {
      viewTimers.delete(orgId);
      for (const l of viewListeners) l(orgId);
    }, SKILLS_VIEW_DEBOUNCE_MS),
  );
}

/** Run `onChange` when a teammate changes this vault's skills, so an open page reloads live. */
export function useSkillsChanged(orgId: string | null, onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!orgId) return;
    const l = (changed: string) => {
      if (changed === orgId) ref.current();
    };
    viewListeners.add(l);
    return () => {
      viewListeners.delete(l);
    };
  }, [orgId]);
}

/** Non-React subscription to {@link useSkillsChanged}'s signal. */
export function onSkillsChanged(listener: (orgId: string) => void): () => void {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

const quietAdds = new Set<string>();

/** The next run's "Added" toast for this skill is left to the caller. */
export function quietNextAdd(skillId: string): void {
  quietAdds.add(skillId);
}

/** "Check now" in AI tools. */
export function checkSkillsNow(): void {
  host?.request();
}

function manifestSkill(orgId: string, skillId: string): ManifestSkill | null {
  const org = state.manifest?.orgs.find((o) => o.orgId === orgId);
  return org?.skills.find((s) => s.skillId === skillId) ?? null;
}

/** Leave this device's edited copy, or its own folder holding the name, alone from now on. */
export function keepMySkill(orgId: string, skillId: string, target: SkillTarget): void {
  if (!host) return;
  setSkillKeepMine(host.serverUrl, orgId, skillId, target, true);
  setState({
    results: state.results.map((r) =>
      r.orgId === orgId && r.skillId === skillId && r.target === target && (r.state === "edited" || r.state === "conflict")
        ? { ...r, state: "keptMine" }
        : r,
    ),
  });
}

/** Replace this device's edited copy with the team version (backed up first). */
export async function applyTeamSkillVersion(orgId: string, skillId: string, target: SkillTarget): Promise<void> {
  const h = host;
  const skill = manifestSkill(orgId, skillId);
  if (!h || !skill) return;
  const outcome = await forceInstallSkill(h.deps, target, orgId, skill);
  if (outcome.status === "installed" || outcome.status === "unchanged") {
    updateSkillsPrefs((p) => {
      delete p.keepMine[keepMineKey(h.serverUrl, orgId, skillId, target)];
    });
    setState({
      results: state.results.map((r) =>
        r.orgId === orgId && r.skillId === skillId && r.target === target
          ? { ...r, state: "upToDate", version: skill.version, backupPath: outcome.backupPath }
          : r,
      ),
    });
    toast(outcome.backupPath ? `Using the team version of ${skillDisplayName(skill.name)}. Your copy was backed up.` : `Using the team version of ${skillDisplayName(skill.name)}.`);
  } else if (outcome.status === "conflict") {
    toast(`Couldn't replace ${skillDisplayName(skill.name)}: another skill uses that folder.`, "error");
  }
}

/**
 * "Use team version" on a name taken by the person's own folder (no marker):
 * Rust backs that folder up, then installs the team version in its place.
 */
export async function replaceNameTakenSkill(orgId: string, skillId: string, target: SkillTarget): Promise<void> {
  const h = host;
  const skill = manifestSkill(orgId, skillId);
  if (!h || !skill) return;
  const name = skillDisplayName(skill.name);
  let outcome: ipc.SkillInstallOutcome;
  try {
    outcome = await replaceUnmanagedSkill(h.deps, target, orgId, skill);
  } catch (e) {
    toast(`Couldn't use the team version of ${name}: ${message(e)}`, "error");
    return;
  }
  if (outcome.status === "conflict") {
    const kind = conflictKindOf(outcome.detail);
    setState({
      results: state.results.map((r) =>
        r.orgId === orgId && r.skillId === skillId && r.target === target ? { ...r, conflict: kind } : r,
      ),
    });
    // With the flag, Rust still refuses a symlinked folder ("unmanaged") and
    // anyone else's marker ("other_owner"); neither is touched.
    toast(
      kind === "unmanaged"
        ? `Couldn't replace ${name}: that folder is a link to another place, so it was left as it is.`
        : `Couldn't replace ${name}: another skill uses that folder.`,
      "error",
    );
    return;
  }
  updateSkillsPrefs((p) => {
    delete p.keepMine[keepMineKey(h.serverUrl, orgId, skillId, target)];
  });
  setState({
    results: state.results.map((r) =>
      r.orgId === orgId && r.skillId === skillId && r.target === target
        ? { ...r, state: "upToDate", version: skill.version, backupPath: outcome.backupPath, conflict: undefined }
        : r,
    ),
  });
  toast(
    outcome.backupPath
      ? `Using the team version of ${name}. Your copy was saved to the skill backups folder (AI tools → Open backups folder).`
      : `Using the team version of ${name}.`,
  );
}

/** Optional skill switch ("Use on this device"). Runs at once. */
export function setSkillOnThisDevice(orgId: string, skillId: string, on: boolean): void {
  const serverUrl = host?.serverUrl ?? state.serverUrl;
  if (!serverUrl) return;
  setSkillOptIn(serverUrl, orgId, skillId, on);
  host?.request();
}

/**
 * Show a delivery change at once, ahead of the server and the next run: the
 * device view's manifest flips now, and a skill made Optional from this
 * computer stays on it (opted in). Returns an undo for a refused PATCH.
 */
export function showDeliveryNow(orgId: string, skillId: string, delivery: SkillDelivery): () => void {
  const before = state.manifest;
  const serverUrl = host?.serverUrl ?? state.serverUrl;
  if (delivery === "optional" && serverUrl) setSkillOptIn(serverUrl, orgId, skillId, true);
  if (!before) return () => {};
  const shown: SkillsManifest = {
    ...before,
    orgs: before.orgs.map((o) =>
      o.orgId !== orgId ? o : { ...o, skills: o.skills.map((k) => (k.skillId === skillId ? { ...k, delivery } : k)) },
    ),
  };
  setState({ manifest: shown });
  return () => {
    // A run since then already shows the server's answer.
    if (state.manifest === shown) setState({ manifest: before });
  };
}

/** A tool folder switch in AI tools. Runs at once (turning one off removes our copies). */
export function setSkillTargetEnabled(target: SkillTarget, on: boolean): void {
  setSkillTarget(target, on);
  host?.request();
}

/** Is this Optional skill on for this device (by the current server's prefs)? */
export function isSkillOnThisDevice(serverUrl: string, orgId: string, skillId: string): boolean {
  return loadSkillsPrefs().optIns[optInKey(serverUrl, orgId, skillId)] === true;
}
