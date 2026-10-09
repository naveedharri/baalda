/* The account menu's "Check for updates" row: what its right-hand hint says and
   which toast reports a check started from it. Pure, so it is testable without
   the Tauri updater; the texts mirror Account Settings → About, which runs the
   same `checkAndAutoInstall` and shows the same outcomes in its status line. */
import type { UpdateState } from "./updater";
import type { ToastTone } from "./toast";

/** Phases in which About's button is disabled: a check or install is running. */
export function isUpdateBusy(state: UpdateState): boolean {
  return (
    state.phase === "checking" ||
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "installing" ||
    state.phase === "ready"
  );
}

/**
 * The row's hint. The running version (as About prints it) unless the updater
 * has something to say; `null` version means it has not been read yet, shown
 * as "…" like About.
 */
export function updateRowHint(state: UpdateState, version: string | null): string {
  switch (state.phase) {
    case "checking":
      return "Checking…";
    case "available":
    case "downloading":
    case "installing":
      return "Updating…";
    case "pending":
      return "Update on its way";
    case "ready":
      return "Restart to update";
    default:
      return version ?? "…";
  }
}

/**
 * The toast for the first state a menu-started check settles in (anything but
 * `checking`), worded as About's status line. `null` for nothing to say.
 */
export function updateCheckToast(state: UpdateState): { text: string; tone: ToastTone } | null {
  switch (state.phase) {
    case "uptodate":
      return { text: "You're on the latest version.", tone: "success" };
    case "pending":
      return { text: "An update is on its way.", tone: "neutral" };
    case "available":
      return { text: `Version ${state.version} found — starting the download…`, tone: "neutral" };
    case "error":
      return { text: `Couldn't check for updates: ${state.message}`, tone: "error" };
    case "failed":
      return {
        text: `Couldn't install version ${state.version}${state.message ? `: ${state.message}` : ""}`,
        tone: "error",
      };
    default:
      return null;
  }
}
