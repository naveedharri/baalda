// The Free note-limit upgrade strip — the one part of the removed "N notes
// didn't sync" banner that survives, because it is an offer, not a failure.

import { describe, expect, it } from "vitest";
import { noteLimitBanner } from "../NoteLimitBanner";
import type { SyncProgress } from "../../lib/sync/vaultScope";

const run = (p: Partial<SyncProgress>): SyncProgress => ({
  phase: "error",
  done: 500,
  total: 500,
  failed: 12,
  ...p,
});

const args = (over: Partial<Parameters<typeof noteLimitBanner>[0]> = {}) => ({
  syncEnabled: true,
  progress: run({}),
  noteLimit: true,
  runToken: 1,
  dismissedRunToken: null,
  ...over,
});

describe("noteLimitBanner", () => {
  it("is up when a finished run left notes behind at the Free note cap", () => {
    expect(noteLimitBanner(args())).toBe(true);
  });

  it("never speaks for ordinary per-note failures (those are Health's)", () => {
    expect(noteLimitBanner(args({ noteLimit: false }))).toBe(false);
  });

  it("stays down with sync off, while a run moves, or with nothing left behind", () => {
    expect(noteLimitBanner(args({ syncEnabled: false }))).toBe(false);
    for (const phase of ["idle", "registering", "uploading", "downloading", "done"] as const) {
      expect(noteLimitBanner(args({ progress: run({ phase }) }))).toBe(false);
    }
    expect(noteLimitBanner(args({ progress: run({ failed: 0 }) }))).toBe(false);
    expect(noteLimitBanner(args({ progress: null }))).toBe(false);
  });

  it("stays down for the dismissed run and comes back for the next", () => {
    expect(noteLimitBanner(args({ dismissedRunToken: 1 }))).toBe(false);
    expect(noteLimitBanner(args({ dismissedRunToken: 1, runToken: 2 }))).toBe(true);
  });
});
