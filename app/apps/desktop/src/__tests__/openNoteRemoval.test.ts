// The open note's "was removed" banner waits for the disk-delete drain's
// grace window instead of firing on the watcher's raw `removed` (which a
// rename also produces). See `lib/openNoteRemoval.ts`.

import { describe, expect, it, vi } from "vitest";
import { runOpenNoteRemovedCheck, scheduleOpenNoteRemovedCheck } from "../lib/openNoteRemoval";

function harness(opts: { open: string | null; exists: boolean | Error }) {
  const state = { open: opts.open };
  const setRemoved = vi.fn();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const deps = {
    delayMs: 3_000,
    currentPath: () => state.open,
    exists: vi.fn(async () => {
      if (opts.exists instanceof Error) throw opts.exists;
      return opts.exists;
    }),
    setRemoved,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  return { state, deps, setRemoved, timers };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("open-note removal check", () => {
  it("does nothing until the grace window has passed", async () => {
    const h = harness({ open: "a.md", exists: false });
    scheduleOpenNoteRemovedCheck("a.md", h.deps);
    expect(h.setRemoved).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(3_000);
    h.timers[0].fn();
    await flush();
    expect(h.setRemoved).toHaveBeenCalledTimes(1);
  });

  it("a rename that re-pointed the open note within the window shows nothing", async () => {
    const h = harness({ open: "a.md", exists: false });
    scheduleOpenNoteRemovedCheck("a.md", h.deps);
    h.state.open = "b.md"; // followNoteRename / applyDiskRename ran
    h.timers[0].fn();
    await flush();
    expect(h.setRemoved).not.toHaveBeenCalled();
    expect(h.deps.exists).not.toHaveBeenCalled();
  });

  it("a file that came back within the window (rename-back, atomic save) shows nothing", async () => {
    const h = harness({ open: "a.md", exists: true });
    await runOpenNoteRemovedCheck("a.md", h.deps);
    expect(h.setRemoved).not.toHaveBeenCalled();
  });

  it("never assumes a delete it could not confirm", async () => {
    const h = harness({ open: "a.md", exists: new Error("ipc down") });
    await runOpenNoteRemovedCheck("a.md", h.deps);
    expect(h.setRemoved).not.toHaveBeenCalled();
  });

  it("a burst of events for one path schedules one check", () => {
    const h = harness({ open: "c.md", exists: false });
    scheduleOpenNoteRemovedCheck("c.md", h.deps);
    scheduleOpenNoteRemovedCheck("c.md", h.deps);
    expect(h.timers).toHaveLength(1);
    h.timers[0].fn(); // clears the slot
  });
});
