// App self-update, backed by the Tauri updater plugin.
//
// The plugin pings the `latest.json` endpoint configured in `tauri.conf.json`
// (a static file published on the GitHub release). If it advertises a version
// newer than the running app — and the bundle's minisign signature verifies
// against our embedded public key — we download, install, and relaunch.
//
// Updates are AUTOMATIC. A check that finds something newer downloads and
// installs it in the background with no prompt, no banner and no wall, then
// restarts the app at the next quiet moment (see `./quietMoment`). Nothing in
// the UI asks permission, because there was never a useful answer: every
// dismissible prompt left part of the fleet on old builds, and old builds are
// where the bugs we just fixed live — one stale client can resurrect deleted
// folders for a whole team.
//
// The full-screen wall (`UpdateGate` in App.tsx) is now the FALLBACK, not the
// happy path: it appears only after the silent path has failed twice, when the
// app is knowingly stale and cannot fix itself without help.
//
// This module is a tiny external store so the wall, the launch poll and the
// Settings → Updates tab observe one shared check/install lifecycle instead of
// each firing their own network request.
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

import { clearRelaunchFocus, recordRelaunchFocus } from "./backgroundRelaunch";
import { bridgeManager } from "./bridge";
import { waitForQuietMoment } from "./quietMoment";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; notes?: string; date?: string }
  | { phase: "downloading"; version: string; downloaded: number; total: number }
  | { phase: "installing"; version: string }
  /** New bytes are in place; we're holding the restart for a quiet moment. */
  | { phase: "ready"; version: string }
  | { phase: "uptodate" }
  | { phase: "error"; message: string }
  /** The silent path gave up (install failed twice). This raises the wall. */
  | { phase: "failed"; version: string; message: string };

/** How long after a failed silent install before the one silent retry. */
export const AUTO_RETRY_DELAY_MS = 30_000;

let pending: Update | null = null;
let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

/** True from the moment a check finds something until relaunch or `failed`. */
let autoInstalling = false;
/** Silent install attempts spent on the current discovery. Budget: 2. */
let autoAttempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

/** The same state outside React, for imperative callers and tests. */
export function updateState(): UpdateState {
  return state;
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

/** Write the open note's debounced buffer to disk. Never throws. */
async function flushOpenNote(): Promise<void> {
  try {
    await bridgeManager.currentBridge()?.flushEgest();
  } catch (e) {
    console.error("flush before update failed", e);
  }
}

/**
 * Download + install the update discovered by `checkForUpdate`, then relaunch
 * into the new version. Progress is reflected in the shared state. Resolves
 * true once the relaunch has been asked for, false if the attempt failed (the
 * caller decides whether that is a retry or the wall).
 *
 * WINDOWS, and why the flush happens BEFORE the download rather than after:
 * on Windows `install` hands the bundle to the NSIS/MSI installer via
 * `ShellExecuteW` and then calls `std::process::exit(0)` — see
 * `tauri-plugin-updater`'s `updater.rs install_inner`. The process is gone
 * before `downloadAndInstall` resolves, so nothing written after that call
 * runs on Windows: not the flush, not the quiet wait, not `relaunch()` (the
 * installer relaunches us instead). Everything that MUST happen — the
 * just-updated stash and the disk flush — therefore happens up front, on every
 * platform, so there is one code path rather than a platform branch. The cost
 * is nil: `flushEgest` is a no-op when nothing is dirty, and macOS/Linux flush
 * a second time right before `relaunch()` to catch edits typed during the
 * download and the quiet wait.
 */
export async function installUpdate(
  options: { waitForQuiet?: boolean } = {},
): Promise<boolean> {
  const update = pending;
  if (!update) return false;
  // Stash the version/notes now — the Update object dies with this process, and
  // the next boot reads the stash back to show the What's New modal.
  try {
    localStorage.setItem(
      JUST_UPDATED_KEY,
      JSON.stringify({ version: update.version, notes: update.body ?? null }),
    );
  } catch {
    // Storage full/blocked: the update still proceeds, only the modal is lost.
  }
  // See the Windows note above: this is the flush that is guaranteed to run.
  await flushOpenNote();
  // Windows restarts from inside `install`, so its focus record is taken now;
  // macOS/Linux take a fresh one right before `relaunch()` below.
  await recordRelaunchFocus();
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
    // Windows never gets here. On macOS/Linux the new bundle is on disk while
    // this process keeps running from the old one, so the only disruptive act
    // left is the restart — hold it until the user pauses.
    setState({ phase: "ready", version: update.version });
    if (options.waitForQuiet !== false) await waitForQuietMoment();
    // Catch anything typed during the download and the wait.
    await flushOpenNote();
    await recordRelaunchFocus();
    await relaunch();
    return true;
  } catch (e) {
    await clearRelaunchFocus();
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * The silent path: install what `checkForUpdate` found, and if that fails give
 * it exactly one more go ~30s later before admitting defeat. Only the second
 * failure lands in `failed`, which is the single state that raises the wall —
 * a flaky download or a network blip should cost the user nothing, not a
 * full-screen interruption.
 */
async function autoInstall(): Promise<void> {
  autoAttempts += 1;
  const version = "version" in state ? state.version : "";
  if (await installUpdate()) return;
  if (autoAttempts >= 2) {
    autoInstalling = false;
    setState({
      phase: "failed",
      version,
      message: state.phase === "error" ? state.message : "",
    });
    return;
  }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void (async () => {
      // Re-discover first: a failed attempt may have died at either stage, and
      // `checkForUpdate` re-arms the pending Update handle.
      if (await checkForUpdate()) {
        await autoInstall();
      } else {
        // Nothing to install any more (or the check itself failed). Either way
        // the app is not knowingly stale, so no wall — the poll will retry.
        autoInstalling = false;
        autoAttempts = 0;
      }
    })();
  }, AUTO_RETRY_DELAY_MS);
}

/**
 * Take the held restart now, rather than waiting for the quiet moment — the
 * Settings → Updates "Restart now" button, for someone who has finished a
 * thought and would rather not be interrupted later.
 */
export async function relaunchForUpdate(): Promise<void> {
  await flushOpenNote();
  // A deliberate click: the restart may come back to the front.
  await clearRelaunchFocus();
  await relaunch();
}

/**
 * Check, and install whatever is found — the entry point for the launch check,
 * the background poll and the Settings → Updates button alike. Fire-and-forget:
 * a failed CHECK (offline, dev build) lands in `error` and blocks nothing.
 */
export async function checkAndAutoInstall(): Promise<void> {
  if (autoInstalling) return;
  autoInstalling = true;
  autoAttempts = 0;
  if (await checkForUpdate()) {
    await autoInstall();
  } else {
    autoInstalling = false;
  }
}

/** The running app's version (from tauri.conf.json), for display. */
export function currentVersion(): Promise<string> {
  return getVersion();
}

/**
 * Updates are REQUIRED: is the app currently blocked behind one?
 *
 * Only `failed` — the silent path downloaded, installed and restarted without
 * ever asking, so discovery, download, install and the held restart are all
 * invisible and none of them block anything. The wall is what is left when the
 * app cannot update itself: two attempts spent, a version we know is stale, and
 * a user who has to point us at a working network.
 *
 * The `error` phase is deliberately NOT blocking: a failed background CHECK
 * (offline launch, dev build without the updater) must never wall off the app,
 * and neither should the FIRST install failure — that one buys a silent retry
 * ({@link AUTO_RETRY_DELAY_MS}) instead. The gate component latches on `failed`
 * so the wall stays put through a manual retry and its progress.
 */
export function isUpdateBlocking(state: UpdateState): boolean {
  return state.phase === "failed";
}

// ---------------------------------------------------------------------------
// The post-restart "Updated to vX" banner.
//
// The handoff problem: by the time the new version is running, the Update
// object (and its release notes) died with the old process. So installUpdate
// writes the stash just before download/relaunch, and it's read back on the
// next boot — if the running version matches the stashed one, the update
// landed and the banner shows its notes; if not (install failed, or a newer
// hop), it's stale and dropped.
// ---------------------------------------------------------------------------

const JUST_UPDATED_KEY = "context.justUpdated";

interface JustUpdated {
  version: string;
  notes: string | null;
}

/**
 * Background check AND install: when a newer version exists the bytes come down
 * and go in with no prompt, and the app restarts itself at the next pause in
 * typing. Nothing is surfaced on the way — the user learns about it from the
 * What's New modal after the restart.
 *
 * Callers treat this as fire-and-forget from launch AND from the poll; every
 * failure lands in the `error` phase (surfaced only in Settings → Updates — an
 * offline launch is not an event), and only a second consecutive INSTALL
 * failure escalates to `failed` and the wall.
 */
export async function backgroundUpdateCheck(): Promise<void> {
  // Skip a tick that fires while a check or an install is already in flight —
  // including the held restart, where the bytes are already in place.
  if (autoInstalling || state.phase === "checking") return;
  await checkAndAutoInstall();
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
