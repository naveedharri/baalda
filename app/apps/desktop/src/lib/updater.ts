// App self-update, backed by the Tauri updater plugin.
//
// The plugin pings the `latest.json` endpoint configured in `tauri.conf.json`
// (a static file published on the GitHub release). If it advertises a version
// newer than the running app — and the bundle's minisign signature verifies
// against our embedded public key — we download, install, and relaunch.
//
// This module is a tiny external store so both the launch-time banner and the
// Settings → Updates tab observe one shared check/install lifecycle instead of
// each firing their own network request.
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; notes?: string; date?: string }
  | { phase: "downloading"; version: string; downloaded: number; total: number }
  | { phase: "installing"; version: string }
  | { phase: "uptodate" }
  | { phase: "error"; message: string };

let pending: Update | null = null;
let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

function setState(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return state;
}

/** React hook: current update lifecycle state, shared app-wide. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Ask the endpoint whether a newer version exists. Returns true if one is
 * available (and stashes it for `installUpdate`). Safe to call anywhere — in a
 * non-bundled dev build the updater is unavailable and this resolves to an
 * `error` state rather than throwing.
 */
export async function checkForUpdate(): Promise<boolean> {
  try {
    setState({ phase: "checking" });
    const update = await check();
    if (update) {
      pending = update;
      setState({
        phase: "available",
        version: update.version,
        notes: update.body || undefined,
        date: update.date || undefined,
      });
      return true;
    }
    pending = null;
    setState({ phase: "uptodate" });
    return false;
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Download + install the update discovered by `checkForUpdate`, then relaunch
 * into the new version. Progress is reflected in the shared state.
 */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update) return;
  let total = 0;
  let downloaded = 0;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          downloaded = 0;
          setState({ phase: "downloading", version: update.version, downloaded, total });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          setState({ phase: "downloading", version: update.version, downloaded, total });
          break;
        case "Finished":
          setState({ phase: "installing", version: update.version });
          break;
      }
    });
    // New bytes are in place; restart into them. On macOS this quits and
    // relaunches; on Windows the installer hands off to the new process.
    await relaunch();
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** The running app's version (from tauri.conf.json), for display. */
export function currentVersion(): Promise<string> {
  return getVersion();
}

// ---------------------------------------------------------------------------
// Silent auto-update + the post-restart "Updated to vX" banner.
//
// The handoff problem: by the time the new version is running, the Update
// object (and its release notes) died with the old process. So the stash below
// is written just before download/relaunch, and read back on the next boot —
// if the running version matches the stashed one, the update landed and the
// banner shows its notes; if not (install failed, or a newer hop), it's stale
// and dropped.
// ---------------------------------------------------------------------------

const JUST_UPDATED_KEY = "context.justUpdated";

interface JustUpdated {
  version: string;
  notes: string | null;
}

/**
 * Fully automatic update: check, and when a newer version exists, download +
 * install + relaunch without asking. Callers should treat this as fire-and-
 * forget from launch; every failure lands in the shared state's `error` phase
 * (surfaced only in Settings → Updates — an offline launch is not an event).
 */
export async function autoUpdate(): Promise<void> {
  const found = await checkForUpdate();
  if (!found || !pending) return;
  try {
    localStorage.setItem(
      JUST_UPDATED_KEY,
      JSON.stringify({ version: pending.version, notes: pending.body ?? null }),
    );
  } catch {
    // Storage full/blocked: the update still proceeds, only the banner is lost.
  }
  await installUpdate();
}

/**
 * The update we just restarted into, if that is what happened — else null.
 * Non-destructive: the banner clears the stash on dismiss via
 * {@link clearJustUpdated}, so an un-dismissed banner survives a quit.
 */
export async function justUpdatedTo(): Promise<JustUpdated | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(JUST_UPDATED_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const stash = JSON.parse(raw) as JustUpdated;
    if (!stash?.version) throw new Error("bad stash");
    const running = await getVersion();
    if (running === stash.version) return stash;
    // Stale: the install never landed, or we've since hopped past it.
    clearJustUpdated();
    return null;
  } catch {
    clearJustUpdated();
    return null;
  }
}

/** Forget the just-updated stash (the banner was dismissed). */
export function clearJustUpdated(): void {
  try {
    localStorage.removeItem(JUST_UPDATED_KEY);
  } catch {
    // Nothing to do — worst case the banner shows once more.
  }
}

/**
 * Release notes → the banner's one-liners. Keeps markdown bullet lines (and
 * plain lines) as-is minus the bullet, drops headings/blanks and the historic
 * placeholder body, and caps the list so a long release stays a glance.
 */
export function releaseNoteLines(notes: string | null | undefined, max = 6): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => !line.startsWith("See the assets below"))
    .map((line) => line.replace(/^[-*•]\s+/, ""))
    .slice(0, max);
}
