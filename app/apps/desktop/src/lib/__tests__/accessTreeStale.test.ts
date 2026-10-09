import { describe, expect, it, vi } from "vitest";
import {
  createStaleReloader,
  markAccessTreeStale,
  onAccessTreeStale,
  sameAccessTreeItems,
} from "../accessTreeStale";
import type { AccessTreeResponse } from "../api";

const tree = (files: Array<{ id: string; path: string }> = [], folders: AccessTreeResponse["folders"] = []): AccessTreeResponse =>
  ({ folders, notes: [{ id: "n1", relPath: "a.md" }], files }) as AccessTreeResponse;

describe("access tree stale signal", () => {
  it("reaches every subscriber until it unsubscribes", () => {
    const a = vi.fn();
    const off = onAccessTreeStale(a);
    markAccessTreeStale();
    off();
    markAccessTreeStale();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("debounces a burst into one reload, with a ceiling for a storm", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const r = createStaleReloader(run, { delayMs: 1000, maxWaitMs: 5000 });
      r.poke();
      vi.advanceTimersByTime(500);
      r.poke();
      vi.advanceTimersByTime(999);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
      // A steady stream every 500 ms still reloads within the ceiling.
      for (let i = 0; i < 10; i++) {
        r.poke();
        vi.advanceTimersByTime(500);
      }
      expect(run).toHaveBeenCalledTimes(2);
      r.poke();
      r.dispose();
      vi.advanceTimersByTime(2000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a new standalone file or folder as a changed tree", () => {
    const before = tree();
    expect(sameAccessTreeItems(before, tree())).toBe(true);
    expect(sameAccessTreeItems(before, tree([{ id: "f1", path: "doc.pdf" }]))).toBe(false);
    expect(sameAccessTreeItems(before, tree([], [{ id: "d1", path: "New", color: null }]))).toBe(false);
    // A move with the same ids is a change too.
    expect(
      sameAccessTreeItems(tree([{ id: "f1", path: "a.pdf" }]), tree([{ id: "f1", path: "x/a.pdf" }])),
    ).toBe(false);
    expect(sameAccessTreeItems(null, before)).toBe(false);
  });
});
