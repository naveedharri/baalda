// The two primitives the bulk sync run is built from: the throttled progress
// reporter (so 500 notes don't become 1,000 React renders) and the coalesced
// single-writer checkpointer (so a kill -9 loses at most one batch).

import { describe, expect, it, vi } from "vitest";
import { Checkpointer, checkpointBatchFor } from "../checkpoint";
import { SyncProgressReporter } from "../progress";
import { runPool, withRetry } from "../pool";
import type { DocSyncState, SyncProgress } from "../vaultScope";

/** A manual clock + timer queue, so throttling is asserted deterministically. */
function fakeClock() {
  let now = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeoutImpl: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutImpl: (h: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((t) => t.id === (h as unknown as number));
      if (i !== -1) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const t of due) {
        const i = timers.indexOf(t);
        if (i !== -1) timers.splice(i, 1);
        t.fn();
      }
    },
    pending: () => timers.length,
  };
}

describe("SyncProgressReporter", () => {
  it("coalesces a burst of items into ~one emission per throttle window", () => {
    const clock = fakeClock();
    const progress: SyncProgress[] = [];
    const r = new SyncProgressReporter({
      onProgress: (p) => {
        if (p) progress.push(p);
      },
      onDocState: () => {},
      throttleMs: 100,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });

    r.phase("uploading", 500);
    expect(progress).toHaveLength(1); // a phase change is never throttled away

    for (let i = 0; i < 200; i++) r.item("ok");
    // 200 notes finished inside one window ⇒ still only the leading emission.
    expect(progress).toHaveLength(1);
    clock.advance(100);
    expect(progress).toHaveLength(2);
    expect(progress[1]).toEqual({ phase: "uploading", done: 200, total: 500, failed: 0 });

    for (let i = 0; i < 300; i++) r.item(i % 3 === 0 ? "failed" : "ok");
    clock.advance(100);
    expect(progress).toHaveLength(3);
    expect(progress[2].done).toBe(500);
    expect(progress[2].failed).toBe(100);
    // 500 items ⇒ 3 store writes, not 500.
    expect(progress.length).toBeLessThanOrEqual(4);
  });

  it("batches per-doc transitions, last-state-wins inside a window", () => {
    const clock = fakeClock();
    const patches: Array<Record<string, DocSyncState | null>> = [];
    const r = new SyncProgressReporter({
      onProgress: () => {},
      onDocState: (p) => patches.push(p),
      throttleMs: 100,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });

    r.doc("a", "queued"); // leading edge
    expect(patches).toEqual([{ a: "queued" }]);
    r.doc("a", "syncing");
    r.doc("a", "synced");
    r.doc("b", "queued");
    r.doc("b", "error");
    clock.advance(100);
    expect(patches[1]).toEqual({ a: "synced", b: "error" });
  });

  it("keeps the counters when only the phase changes (an honest terminal report)", () => {
    const clock = fakeClock();
    const progress: SyncProgress[] = [];
    const r = new SyncProgressReporter({
      onProgress: (p) => {
        if (p) progress.push(p);
      },
      onDocState: () => {},
      throttleMs: 0,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    r.phase("uploading", 10);
    for (let i = 0; i < 10; i++) r.item(i < 8 ? "ok" : "failed");
    r.phase("error");
    const last = progress[progress.length - 1];
    expect(last).toEqual({ phase: "error", done: 10, total: 10, failed: 2 });
  });

  it("dispose() nulls the store's progress and silences later emissions", () => {
    const clock = fakeClock();
    const seen: Array<SyncProgress | null> = [];
    const r = new SyncProgressReporter({
      onProgress: (p) => seen.push(p),
      onDocState: () => {},
      throttleMs: 100,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    r.phase("registering", 5);
    r.item("ok");
    r.dispose();
    expect(seen[seen.length - 1]).toBeNull(); // no half-finished count on screen

    const after = seen.length;
    r.item("ok");
    r.doc("x", "synced");
    r.flush();
    clock.advance(1000);
    expect(seen).toHaveLength(after);
    expect(clock.pending()).toBe(0);
  });
});

describe("Checkpointer", () => {
  it("flushes when the batch fills, and again when the window closes", async () => {
    const clock = fakeClock();
    const written: number[] = [];
    let counter = 0;
    const cp = new Checkpointer<number>({
      write: async (v) => {
        written.push(v);
      },
      snapshot: () => counter,
      everyItems: 25,
      everyMs: 750,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });

    for (let i = 0; i < 24; i++) {
      counter++;
      cp.touch();
    }
    await Promise.resolve();
    expect(written).toHaveLength(0); // batch not full yet
    counter++;
    cp.touch(); // 25th ⇒ flush
    await cp.flush();
    expect(written).toEqual([25]);

    counter++;
    cp.touch(); // one straggler: the time window covers it
    clock.advance(750);
    await cp.flush();
    expect(written).toEqual([25, 26]);
  });

  it("is a single writer, and every write carries the newest snapshot", async () => {
    const clock = fakeClock();
    const written: number[] = [];
    let counter = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const cp = new Checkpointer<number>({
      write: async (v) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (first) {
          first = false;
          await gate; // hold the first write open across the whole burst
        }
        written.push(v);
        inFlight--;
      },
      snapshot: () => counter,
      everyItems: 1,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });

    counter = 1;
    cp.touch(); // queues write #1
    counter = 2;
    cp.touch();
    counter = 3;
    cp.touch();
    counter = 42;
    const done = cp.flush();
    release();
    await done;

    // Never two writers: a torn config.json is exactly what that would produce.
    expect(maxInFlight).toBe(1);
    // The snapshot is taken INSIDE the chain, so no write persists a value that
    // was already superseded before it ran.
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(written)).toEqual(new Set([42]));
  });

  it("dispose() is synchronous and drops every pending write", async () => {
    const clock = fakeClock();
    const written: number[] = [];
    const cp = new Checkpointer<number>({
      write: async (v) => {
        written.push(v);
      },
      snapshot: () => 7,
      everyItems: 10,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    cp.touch();
    cp.dispose(); // vault switch
    clock.advance(10_000);
    await cp.flush();
    expect(written).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("keeps the dirty flag when a write fails, so the next window retries", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const cp = new Checkpointer<number>({
      write: async () => {
        attempts++;
        if (attempts === 1) throw new Error("disk full");
      },
      snapshot: () => 1,
      everyItems: 1,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    cp.touch();
    await cp.flush();
    expect(cp.isDirty).toBe(true);
    await cp.flush();
    expect(attempts).toBe(2);
    expect(cp.isDirty).toBe(false);
  });
});

// ── config.json write volume ────────────────────────────────────────────────
// The file is rewritten WHOLE on every flush and carries three entries per note,
// so on a big vault the batch size decides how many megabytes a backfill writes.

describe("checkpointBatchFor", () => {
  it("never drops below 25, so a small vault still checkpoints often", () => {
    expect(checkpointBatchFor(0)).toBe(25);
    expect(checkpointBatchFor(60)).toBe(25);
    expect(checkpointBatchFor(1250)).toBe(25);
  });

  it("scales with the vault, keeping the write COUNT flat as the file grows", () => {
    // 5,000 notes: ~50 writes of a big file, not ~200.
    expect(checkpointBatchFor(5_000)).toBe(100);
    expect(5_000 / checkpointBatchFor(5_000)).toBe(50);
    expect(20_000 / checkpointBatchFor(20_000)).toBe(50);
  });
});

describe("Checkpointer.setEveryItems", () => {
  it("retunes the batch after the caller learns the vault's size", async () => {
    const clock = fakeClock();
    const written: number[] = [];
    let counter = 0;
    const cp = new Checkpointer<number>({
      write: async (v) => {
        written.push(v);
      },
      snapshot: () => counter,
      everyItems: 25,
      everyMs: 750,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    cp.setEveryItems(checkpointBatchFor(5_000)); // 100

    for (let i = 0; i < 99; i++) {
      counter++;
      cp.touch();
    }
    await Promise.resolve();
    expect(written).toHaveLength(0); // the old 25-item batch would have fired 3×
    counter++;
    cp.touch();
    await cp.flush();
    expect(written).toEqual([100]);
  });

  it("flushes immediately when the new batch is already full", async () => {
    const clock = fakeClock();
    const written: number[] = [];
    let counter = 0;
    const cp = new Checkpointer<number>({
      write: async (v) => {
        written.push(v);
      },
      snapshot: () => counter,
      everyItems: 100,
      everyMs: 750,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    for (let i = 0; i < 30; i++) {
      counter++;
      cp.touch();
    }
    // Lowering the batch under what is already pending must not leave the write
    // owed until the next touch.
    cp.setEveryItems(10);
    await cp.flush();
    expect(written).toEqual([30]);
  });
});

describe("runPool / withRetry", () => {
  it("never exceeds the concurrency bound and visits every item", async () => {
    let inFlight = 0;
    let max = 0;
    const seen: number[] = [];
    await runPool(
      Array.from({ length: 50 }, (_, i) => i),
      async (i) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        seen.push(i);
        inFlight--;
      },
      { concurrency: 5 },
    );
    expect(seen).toHaveLength(50);
    expect(max).toBe(5);
  });

  it("abandons the remainder as soon as shouldStop goes true", async () => {
    let stop = false;
    const seen: number[] = [];
    await runPool(
      Array.from({ length: 100 }, (_, i) => i),
      async (i) => {
        await new Promise((r) => setTimeout(r, 0));
        seen.push(i);
        if (seen.length === 10) stop = true;
      },
      { concurrency: 4, shouldStop: () => stop },
    );
    expect(seen.length).toBeLessThan(100);
    expect(seen.length).toBeLessThanOrEqual(10 + 4);
  });

  it("one throwing item never abandons the pool", async () => {
    const seen: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      async (i) => {
        if (i === 2) throw new Error("nope");
        seen.push(i);
      },
      { concurrency: 1 },
    );
    expect(seen).toEqual([1, 3, 4]);
  });

  it("withRetry backs off, then reports terminal failure instead of throwing", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        throw new Error("flaky");
      },
      {
        attempts: 3,
        baseMs: 100,
        random: () => 1,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]); // exponential
    expect(out).toMatchObject({ ok: false, terminal: true, attempts: 3 });
  });

  it("withRetry stops immediately on a terminal error", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const out = await withRetry(
      async () => {
        calls++;
        throw new Error("403");
      },
      { attempts: 5, isTerminal: () => true, sleep },
    );
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, terminal: true });
  });
});
