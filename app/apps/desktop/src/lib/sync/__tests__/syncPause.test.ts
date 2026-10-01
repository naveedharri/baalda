import { describe, expect, it } from "vitest";
import { parseServerControl } from "../vaultProtocol";
import {
  FALLBACK_HOLD_MS,
  SyncPauseTracker,
  syncPauseRemaining,
  syncPauseText,
  type SyncPause,
} from "../syncPause";

// "Sync paused: many notes were emptied at once" (#252): how this device learns
// the server's shrink burst brake holds its writes, and when it stops saying so.

function harness(start = 1_000_000) {
  let now = start;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 0;
  const changes: Array<{ next: SyncPause | null; reason: string }> = [];
  const t = new SyncPauseTracker({
    onChange: (next, _prev, reason) => changes.push({ next, reason }),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const x of [...timers]) {
      if (x.at <= now) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
    }
  };
  return { t, changes, advance, now: () => now };
}

describe("parseServerControl — brake frame", () => {
  it("parses a pause with until and count", () => {
    expect(parseServerControl(JSON.stringify({ t: "brake", held: true, until: 5, count: 10 }))).toEqual({
      t: "brake",
      held: true,
      until: 5,
      count: 10,
    });
  });

  it("parses a lift and drops fields that only belong to a pause", () => {
    expect(parseServerControl(JSON.stringify({ t: "brake", held: false, until: 5 }))).toEqual({
      t: "brake",
      held: false,
    });
  });

  it("ignores a malformed frame and bad numbers", () => {
    expect(parseServerControl(JSON.stringify({ t: "brake" }))).toBeNull();
    expect(parseServerControl(JSON.stringify({ t: "brake", held: "yes" }))).toBeNull();
    expect(parseServerControl(JSON.stringify({ t: "brake", held: true, until: "soon", count: -1 }))).toEqual({
      t: "brake",
      held: true,
    });
  });
});

describe("SyncPauseTracker", () => {
  it("a channel pause lasts until the server says it lifted", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() + 600_000, count: 10 });
    expect(h.t.current()).toMatchObject({ count: 10, until: h.now() + 600_000 });
    // A batch write being accepted does not end a pause the server described.
    h.t.writeAccepted();
    expect(h.t.current()).not.toBeNull();
    h.t.channel({ held: false });
    expect(h.t.current()).toBeNull();
    expect(h.changes.map((c) => c.reason)).toEqual(["set", "lifted"]);
  });

  it("ends at `until` when the lift frame never arrives", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() + 60_000, count: 3 });
    h.advance(59_000);
    expect(h.t.current()).not.toBeNull();
    h.advance(2_000);
    expect(h.t.current()).toBeNull();
    expect(h.changes[h.changes.length - 1]?.reason).toBe("lifted");
  });

  it("keeps `since` across a re-announcement, so a dismissed banner stays dismissed", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() + 600_000, count: 10 });
    const since = h.t.current()!.since;
    h.advance(1_000);
    h.t.channel({ held: true, until: h.now() + 599_000, count: 10 });
    expect(h.t.current()!.since).toBe(since);
  });

  it("a stale pause frame is not a pause", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() - 1, count: 10 });
    expect(h.t.current()).toBeNull();
    expect(h.changes).toEqual([]);
  });

  it("a batch refusal pauses with no until, and the next accepted write ends it", () => {
    const h = harness();
    h.t.batchHeld();
    expect(h.t.current()).toMatchObject({ until: null, count: null });
    h.t.batchHeld(); // repeats change nothing
    expect(h.changes).toHaveLength(1);
    h.t.writeAccepted();
    expect(h.t.current()).toBeNull();
    expect(h.changes[h.changes.length - 1]?.reason).toBe("lifted");
  });

  it("a batch-only pause still ends after the fallback hold", () => {
    const h = harness();
    h.t.batchHeld();
    h.advance(FALLBACK_HOLD_MS + 1_000);
    expect(h.t.current()).toBeNull();
  });

  it("a batch refusal never shortens a pause the channel described", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() + 600_000, count: 10 });
    h.t.batchHeld();
    h.t.writeAccepted();
    expect(h.t.current()).toMatchObject({ count: 10 });
  });

  it("leaving the vault reports `reset`, not a lift", () => {
    const h = harness();
    h.t.channel({ held: true, until: h.now() + 600_000, count: 10 });
    h.t.reset();
    expect(h.t.current()).toBeNull();
    expect(h.changes[h.changes.length - 1]?.reason).toBe("reset");
    h.t.reset(); // nothing to report twice
    expect(h.changes).toHaveLength(2);
  });

  it("says the count when known, and the time left", () => {
    expect(syncPauseText({ count: 12 })).toBe("Sync paused: 12 notes were emptied at once");
    expect(syncPauseText({ count: null })).toBe("Sync paused: many notes were emptied at once");
    expect(syncPauseRemaining({ until: 10 * 60_000 }, 0)).toBe("about 10 min");
    expect(syncPauseRemaining({ until: null }, 0)).toBeNull();
    expect(syncPauseRemaining({ until: 5 }, 10)).toBeNull();
  });
});
