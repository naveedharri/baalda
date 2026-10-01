import { describe, expect, it, vi } from "vitest";
import {
  createReleaseWatch,
  DEFAULT_RELEASE_MANIFEST_URL,
  manifestVersion,
  releaseWatchConfig,
} from "../src/sync/release-watch.js";

/**
 * #269: the server learns the latest desktop version and hints connected apps
 * only when it CHANGES — never on its first look, never on a failed fetch.
 */

function manifestFetch(versions: Array<string | Error>) {
  let i = 0;
  return (async () => {
    const v = versions[Math.min(i++, versions.length - 1)];
    if (v instanceof Error) throw v;
    return new Response(JSON.stringify({ version: v, platforms: {} }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("release watch", () => {
  it("reads the version out of an updater manifest, strictly", () => {
    expect(manifestVersion({ version: "0.1.80" })).toBe("0.1.80");
    expect(manifestVersion({ version: "v0.1.80" })).toBe("0.1.80");
    expect(manifestVersion({ version: "0.1.80-staging.4" })).toBe("0.1.80-staging.4");
    expect(manifestVersion({ version: "<script>" })).toBeNull();
    expect(manifestVersion({})).toBeNull();
    expect(manifestVersion(null)).toBeNull();
  });

  it("records the first version silently and announces only a change", async () => {
    const onNewVersion = vi.fn();
    const watch = createReleaseWatch({
      manifestUrl: "http://example.invalid/latest.json",
      intervalMs: 0, // driven by hand
      onNewVersion,
      fetchImpl: manifestFetch(["0.1.79", "0.1.79", "0.1.80", "0.1.80"]),
    });
    await watch.poll();
    expect(watch.latest()).toBe("0.1.79");
    await watch.poll();
    expect(onNewVersion).not.toHaveBeenCalled();
    await watch.poll();
    expect(onNewVersion).toHaveBeenCalledWith("0.1.80");
    await watch.poll();
    expect(onNewVersion).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("survives an unreachable manifest (air-gapped host) without announcing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onNewVersion = vi.fn();
    const watch = createReleaseWatch({
      manifestUrl: "http://example.invalid/latest.json",
      intervalMs: 0,
      onNewVersion,
      fetchImpl: manifestFetch([new Error("offline"), new Error("offline")]),
    });
    await watch.poll();
    await watch.poll();
    expect(watch.latest()).toBeNull();
    expect(onNewVersion).not.toHaveBeenCalled();
    // Logged once per outage, not once per poll.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is configurable and can be turned off", () => {
    expect(releaseWatchConfig({})).toEqual({
      manifestUrl: DEFAULT_RELEASE_MANIFEST_URL,
      intervalMs: 5 * 60_000,
    });
    expect(releaseWatchConfig({ RELEASE_MANIFEST_URL: "off" })).toBeNull();
    expect(releaseWatchConfig({ RELEASE_POLL_MINUTES: "0" })).toBeNull();
    expect(
      releaseWatchConfig({ RELEASE_MANIFEST_URL: "https://x.test/m.json", RELEASE_POLL_MINUTES: "2" }),
    ).toEqual({ manifestUrl: "https://x.test/m.json", intervalMs: 120_000 });
  });
});
