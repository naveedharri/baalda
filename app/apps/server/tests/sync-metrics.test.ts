import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countBucket,
  flushSyncMetrics,
  inc,
  observeCount,
  resetSyncMetrics,
  snapshot,
  takeDelta,
} from "../src/metrics/sync-metrics.js";

// Pure in-process counters: no database, no network.
describe("sync-metrics", () => {
  afterEach(() => {
    resetSyncMetrics();
    vi.restoreAllMocks();
  });

  it("increments counters and snapshots running totals", () => {
    inc("seed.applied");
    inc("seed.applied", 2);
    inc("seed.appliedBytes", 512);
    inc("seed.conflict", 0); // zero is ignored
    inc("seed.refused", Number.NaN); // non-finite is ignored
    expect(snapshot()).toEqual({ "seed.applied": 3, "seed.appliedBytes": 512 });
  });

  it("buckets per-connect list sizes", () => {
    expect(countBucket(0)).toBe("0");
    expect(countBucket(-3)).toBe("0");
    expect(countBucket(Number.NaN)).toBe("0");
    expect(countBucket(1)).toBe("1-10");
    expect(countBucket(10)).toBe("1-10");
    expect(countBucket(11)).toBe("11-100");
    expect(countBucket(100)).toBe("11-100");
    expect(countBucket(101)).toBe("101-2000");
    expect(countBucket(2000)).toBe("101-2000");
    expect(countBucket(50_000)).toBe("101-2000");
  });

  it("observeCount records connects, a capped total and the bucket", () => {
    observeCount("ready.empty.count", 0);
    observeCount("ready.empty.count", 7);
    observeCount("ready.empty.count", 5000);
    expect(snapshot()).toEqual({
      "ready.empty.count": 7 + 2000,
      "ready.empty.count.connects": 3,
      "ready.empty.count.bucket.0": 1,
      "ready.empty.count.bucket.1-10": 1,
      "ready.empty.count.bucket.101-2000": 1,
    });
  });

  it("flushes only the delta, and nothing when nothing changed", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    inc("checkpoint.docs.text", 4);
    const first = flushSyncMetrics(Date.now());
    expect(first).toMatch(/^\[sync-metrics\] /);
    expect(JSON.parse(first!.slice("[sync-metrics] ".length)).counters).toEqual({
      "checkpoint.docs.text": 4,
    });
    expect(flushSyncMetrics(Date.now())).toBeNull();
    inc("checkpoint.docs.text");
    expect(takeDelta()).toEqual({ "checkpoint.docs.text": 1 });
    expect(takeDelta()).toBeNull();
    // Totals keep running across flushes.
    expect(snapshot()["checkpoint.docs.text"]).toBe(5);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
