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

// #255: the launch path decides about an update BEFORE sync starts. The gate's
// promise is what the session restore awaits, so "resolved" here means "sync
// may start now" and "pending" means the old build is still being held back.
describe("the launch gate", () => {
  it("installs a found update and restarts without the quiet wait", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();
    const onUpdating = vi.fn();

    await updater.launchUpdateGate({ onUpdating });

    expect(onUpdating).toHaveBeenCalledWith("0.2.0");
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    // Nobody is typing behind the gate: no quiet-moment wait, and the restart
    // is asked for before the gate lets sync go (in the real app the process
    // is gone by then and the promise never resolves).
    expect(waitForQuietMoment).not.toHaveBeenCalled();
    expect(trace).toEqual(["stash", "flush", "download", "flush", "relaunch"]);
  });

  it("resolves at once when there is no update", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();
    const onUpdating = vi.fn();

    await updater.launchUpdateGate({ onUpdating });

    expect(onUpdating).not.toHaveBeenCalled();
    expect(updater.updateState().phase).toBe("uptodate");
  });

  it("resolves at once when the check fails (offline launch)", async () => {
    check.mockRejectedValue(new Error("error sending request"));
    const updater = await loadUpdater();

    await updater.launchUpdateGate();

    expect(updater.updateState().phase).toBe("error");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
  });

  it("stops holding sync after the time box, and installs a late answer quietly", async () => {
    const update = fakeUpdate("0.2.0");
    let answer: (u: unknown) => void = () => {};
    check.mockImplementation(() => new Promise((r) => (answer = r)));
    const updater = await loadUpdater();

    let resolved = false;
    void updater.launchUpdateGate({ timeoutMs: 1_000 }).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    // The late answer goes down the ordinary background path: sync is running
    // by now, so the restart waits for a quiet moment.
    answer(update);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(waitForQuietMoment).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("lets sync start when the install fails, keeping the one silent retry", async () => {
    const update = fakeUpdate("0.2.0", { fail: true });
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.launchUpdateGate();

    expect(updater.updateState().phase).toBe("error");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
    await vi.advanceTimersByTimeAsync(updater.AUTO_RETRY_DELAY_MS);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
  });

  it("gives up holding a crawling download, which then restarts at a quiet moment", async () => {
    let finish = () => {};
    const update = {
      ...fakeUpdate("0.2.0"),
      downloadAndInstall: vi.fn(
        (onEvent: (e: Record<string, unknown>) => void) =>
          new Promise<void>((r) => {
            onEvent({ event: "Started", data: { contentLength: 200 } });
            finish = () => {
              onEvent({ event: "Finished" });
              r();
            };
          }),
      ),
    };
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    let resolved = false;
    void updater.launchUpdateGate({ holdMs: 5_000 }).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(waitForQuietMoment).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("a server refusing this build (client_outdated, #251)", () => {
  it("installs a found update straight away, with no wall", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updater = await loadUpdater();

    await updater.serverRequiresUpdate();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
  });

  it("raises the wall at once when no newer build can be found", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();

    await updater.serverRequiresUpdate();

    expect(updater.isUpdateBlocking(updater.updateState())).toBe(true);
    // Edits are never touched on this path: nothing is flushed or relaunched.
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("acts once per session however many calls are refused", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();

    await updater.serverRequiresUpdate();
    await updater.serverRequiresUpdate();

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("links the manual download to the releases page", async () => {
    const updater = await loadUpdater();
    expect(updater.RELEASES_PAGE_URL).toMatch(/^https:\/\/github\.com\/naveedharri\/baalda\/releases\//);
  });
});

describe("the server's release hint (#269)", () => {
  it("runs one jittered background check, however many hints arrive", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();

    updater.scheduleHintedUpdateCheck(() => 0.5);
    updater.scheduleHintedUpdateCheck(() => 0.1);
    expect(check).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(updater.UPDATE_HINT_JITTER_MS * 0.5);
    expect(check).toHaveBeenCalledTimes(1);

    // A later hint schedules a fresh one.
    updater.scheduleHintedUpdateCheck(() => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe("a release still being published (server ahead of the feed)", () => {
  const MIN = 60_000;

  it("treats a hinted newer version with no update as in progress: no error, backoff 2/4/8 min", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();

    await updater.onServerReleaseHint("0.1.61", () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(updater.updateState()).toEqual({ phase: "pending", version: "0.1.61" });

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(check).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8 * MIN - 1_000);
    expect(check).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(4);
    // Capped at the regular poll interval.
    await vi.advanceTimersByTimeAsync(updater.UPDATE_POLL_MS);
    expect(check).toHaveBeenCalledTimes(5);
    expect(updater.updateState().phase).toBe("pending");
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("falls back to the regular schedule after the window, still with no error", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();
    await updater.onServerReleaseHint("0.1.61", () => 0);
    await vi.advanceTimersByTimeAsync(updater.RELEASE_PENDING_WINDOW_MS + updater.UPDATE_POLL_MS);
    expect(updater.pendingRelease()).toBeNull();
    expect(updater.updateState().phase).not.toBe("error");
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(updater.UPDATE_POLL_MS * 2);
    expect(check.mock.calls.length).toBe(calls);
  });

  it("treats a half-published feed (no entry for this platform) as in progress", async () => {
    check.mockRejectedValue(
      new Error("None of the fallback platforms `[\"windows-x86_64\"]` were found in the response `platforms` object"),
    );
    const updater = await loadUpdater();
    await updater.onServerReleaseHint("0.1.61", () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.updateState()).toEqual({ phase: "pending", version: "0.1.61" });
  });

  it("installs normally once a later retry finds the release", async () => {
    check.mockResolvedValueOnce(null).mockResolvedValue(fakeUpdate("0.1.61"));
    const updater = await loadUpdater();
    await updater.onServerReleaseHint("0.1.61", () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.updateState().phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(trace).toContain("download");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 on the bundle download as in progress, never the wall", async () => {
    const half = fakeUpdate("0.1.61");
    half.downloadAndInstall.mockRejectedValue(
      new Error("Download request failed with status: 404 Not Found"),
    );
    check.mockResolvedValueOnce(half).mockResolvedValueOnce(half).mockResolvedValue(fakeUpdate("0.1.61"));
    const updater = await loadUpdater();
    await updater.backgroundUpdateCheck();
    expect(updater.updateState()).toEqual({ phase: "pending", version: "0.1.61" });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(updater.updateState().phase).toBe("pending");
    expect(updater.isUpdateBlocking(updater.updateState())).toBe(false);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps the real error for a bad signature", async () => {
    const bad = fakeUpdate("0.1.61");
    bad.downloadAndInstall.mockRejectedValue(new Error("signature verification failed"));
    check.mockResolvedValue(bad);
    const updater = await loadUpdater();
    await updater.onServerReleaseHint("0.1.61", () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.updateState()).toEqual({ phase: "error", message: "signature verification failed" });
    await vi.advanceTimersByTimeAsync(updater.AUTO_RETRY_DELAY_MS);
    expect(updater.updateState().phase).toBe("failed");
  });

  it("ignores a hint for the version already running", async () => {
    check.mockResolvedValue(null);
    const updater = await loadUpdater();
    await updater.onServerReleaseHint("0.1.60", () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.updateState().phase).toBe("uptodate");
    expect(updater.pendingRelease()).toBeNull();
  });

  it("orders versions, staging builds included", async () => {
    const updater = await loadUpdater();
    expect(updater.isNewerVersion("0.1.61", "0.1.60")).toBe(true);
    expect(updater.isNewerVersion("0.1.60", "0.1.60")).toBe(false);
    expect(updater.isNewerVersion("0.1.60-staging.12", "0.1.60-staging.9")).toBe(true);
    expect(updater.isNewerVersion("0.1.60", "0.1.60-staging.9")).toBe(true);
    expect(updater.isReleaseNotReadyError("signature 404")).toBe(false);
  });
});
