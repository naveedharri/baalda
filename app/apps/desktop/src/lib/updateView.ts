import type { UpdateState } from "./updater";

/**
 * One reading of the updater's state for every surface that shows it: the
 * About card, the sidebar line above the account row, and the account menu's
 * update row. They differ in size, never in what they say.
 */
export interface UpdateView {
  /** `ok` up to date, `busy` working, `ready` restart pending, `wait` on its way, `error`. */
  tone: "idle" | "ok" | "busy" | "ready" | "wait" | "error";
  /** "Baalda 0.1.98", "Updating to 0.1.99", "0.1.99 is ready". */
  title: string;
  /** The second line, or "". */
  sub: string;
  /** 0 to 100 while bytes are moving, else null. */
  percent: number | null;
  /** What the button does, or null for no button. */
  action: "check" | "restart" | "retry" | null;
}

export function updateView(state: UpdateState, current: string | null): UpdateView {
  const here = current ?? "…";
  switch (state.phase) {
    case "checking":
      return { tone: "busy", title: `Baalda ${here}`, sub: "Checking for updates…", percent: null, action: null };
    case "available":
      return { tone: "busy", title: `Updating to ${state.version}`, sub: "Starting the download…", percent: 0, action: null };
    case "downloading": {
      const percent = state.total > 0 ? Math.round((state.downloaded / state.total) * 100) : null;
      return {
        tone: "busy",
        title: `Updating to ${state.version}`,
        sub: percent === null ? "Downloading…" : `Downloading · ${percent}%`,
        percent: percent ?? 0,
        action: null,
      };
    }
    case "installing":
      return { tone: "busy", title: `Installing ${state.version}`, sub: "This takes a few seconds", percent: 100, action: null };
    case "ready":
      return { tone: "ready", title: `${state.version} is ready`, sub: "Restart to finish", percent: null, action: "restart" };
    case "uptodate":
      return { tone: "ok", title: `Baalda ${here}`, sub: "You're on the latest version", percent: null, action: "check" };
    case "pending":
      return { tone: "wait", title: "An update is on its way", sub: "Baalda checks again on its own", percent: null, action: null };
    case "error":
      return { tone: "error", title: `Baalda ${here}`, sub: `Couldn't check for updates: ${state.message}`, percent: null, action: "retry" };
    case "failed":
      return {
        tone: "error",
        title: `Couldn't install ${state.version}`,
        sub: state.message || "The download was interrupted",
        percent: null,
        action: "retry",
      };
    default:
      return { tone: "idle", title: `Baalda ${here}`, sub: "", percent: null, action: "check" };
  }
}

/** The sidebar line shows only while something is happening or waiting on you. */
export function showsSidebarUpdateLine(view: UpdateView): boolean {
  return view.tone === "busy" || view.tone === "ready" || view.tone === "error" || view.tone === "wait";
}
