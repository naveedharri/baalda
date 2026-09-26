import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The auto-update lifecycle: a check that finds something newer downloads,
// installs and restarts with nothing asked of the user, and only a second
// consecutive INSTALL failure raises the full-screen wall. The Tauri surfaces
// (updater, process, app) and the bridge are mocked; the quiet-moment wait has
// its own suite, so here it is stubbed to resolve at once.

const check = vi.fn();
const relaunch = vi.fn(async () => {});
const flushEgest = vi.fn(async () => {});
const waitForQuietMoment = vi.fn(async () => {});

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => check(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunch(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "0.1.60",
}));
vi.mock("../bridge", () => ({
  bridgeManager: { currentBridge: () => ({ flushEgest }) },
}));
vi.mock("../backgroundRelaunch", () => ({
  recordRelaunchFocus: async () => {},
  clearRelaunchFocus: async () => {},
}));
vi.mock("../quietMoment", () => ({
  waitForQuietMoment: () => waitForQuietMoment(),
}));

/** The order in which the module reached each side effect. */
let trace: string[] = [];

/** A stand-in for the plugin's `Update` handle. */
function fakeUpdate(version: string, opts: { fail?: boolean } = {}) {
  return {
    version,
    body: `- Something new in ${version}`,
    date: "2026-09-16",
    downloadAndInstall: vi.fn(
      async (onEvent: (e: Record<string, unknown>) => void) => {
        trace.push("download");
        onEvent({ event: "Started", data: { contentLength: 200 } });
        onEvent({ event: "Progress", data: { chunkLength: 200 } });
        if (opts.fail) throw new Error("connection reset");
        onEvent({ event: "Finished" });
      },
    ),
  };
}

/** A fresh module instance — the store is module-level mutable state. */
async function loadUpdater() {
  vi.resetModules();
  return import("../updater");
}

let store: Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  trace = [];
  check.mockReset();
  relaunch.mockReset();
  relaunch.mockImplementation(async () => {
    trace.push("relaunch");
  });
  flushEgest.mockReset();
  flushEgest.mockImplementation(async () => {
    trace.push("flush");
  });
  waitForQuietMoment.mockReset();
  waitForQuietMoment.mockImplementation(async () => {
    trace.push("quiet");
  });
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      trace.push("stash");
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the silent path", () => {
  it("downloads, installs, flushes and restarts with nothing asked", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    // Nothing about this run is blocking — no wall, ever.
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
  });

  it("stashes the version and flushes the note BEFORE the download", async () => {
    // Both matter on Windows, where the NSIS installer takes over and the
    // process exits inside downloadAndInstall — nothing after it ever runs.
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();

    expect(trace.indexOf("stash")).toBeLessThan(trace.indexOf("download"));
    expect(trace.indexOf("flush")).toBeLessThan(trace.indexOf("download"));
    expect(JSON.parse(store["context.justUpdated"])).toMatchObject({
      version: "0.2.0",
    });
  });

  it("holds the restart for a quiet moment, then flushes again", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();

    // download → quiet wait → a second flush for anything typed meanwhile →
    // relaunch. The trace starts with the pre-download stash and flush.
    expect(trace).toEqual(["stash", "flush", "download", "quiet", "flush", "relaunch"]);
  });

  it("parks in `ready` while it waits, so Settings can offer Restart now", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    let phaseWhileWaiting = "";
    waitForQuietMoment.mockImplementation(async () => {
      phaseWhileWaiting = updater.updateState().phase;
    });

    await updater.backgroundUpdateCheck();

    expect(phaseWhileWaiting).toBe("ready");
  });

  it("skips the restart wait when the caller is the wall", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.checkForUpdate();
    await updater.installUpdate({ waitForQuiet: false });

    expect(waitForQuietMoment).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("failures", () => {
  it("retries once silently, and only then raises the wall", async () => {
    const update = fakeUpdate("0.2.0", { fail: true });
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();

    // First failure: silent. The user is still working in the old version and
    // has been told nothing, because a blip should cost them nothing.
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.updateState().phase).toBe("error");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);

    await vi.advanceTimersByTimeAsync(updater.AUTO_RETRY_DELAY_MS);

    // Second failure: the app is knowingly stale and cannot fix itself.
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(updater.updateState()).toMatchObject({
      phase: "failed",
      version: "0.2.0",
    });
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("lets the silent retry succeed without ever showing the wall", async () => {
    const failing = fakeUpdate("0.2.0", { fail: true });
    const working = fakeUpdate("0.2.0");
    check.mockResolvedValueOnce(failing).mockResolvedValue(working);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();
    await vi.advanceTimersByTimeAsync(updater.AUTO_RETRY_DELAY_MS);

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
  });

  it("never blocks on a failed CHECK — offline launches are not events", async () => {
    check.mockRejectedValue(new Error("error sending request"));
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(updater.updateState().phase).toBe("error");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("stands down when the retry finds nothing to install after all", async () => {
    const failing = fakeUpdate("0.2.0", { fail: true });
    check.mockResolvedValueOnce(failing).mockResolvedValue(null);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();
    await vi.advanceTimersByTimeAsync(updater.AUTO_RETRY_DELAY_MS);

    // The release was pulled, or we already hopped past it. Not a wall.
    expect(updater.updateState().phase).toBe("uptodate");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
  });
});

describe("the poll", () => {
  it("does nothing while an install is already under way", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    // Park the run in the quiet wait, then let the 15-minute poll tick.
    let release = () => {};
    waitForQuietMoment.mockImplementation(
      () => new Promise<void>((r) => (release = r)),
    );
    const run = updater.backgroundUpdateCheck();
    // Let the check → download chain settle right up to the parked wait.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    await updater.backgroundUpdateCheck();
    expect(check).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

    release();
    await run;
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("checks again once an earlier check came back up to date", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();

    await updater.backgroundUpdateCheck();
    await updater.backgroundUpdateCheck();

    expect(check).toHaveBeenCalledTimes(2);
  });
});
