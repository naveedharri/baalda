// A failed egest (CRDT → disk) must never be silent, and must never move the
// echo guard onto bytes that are not on disk (#81). The .md is the durable
// source of truth, so a lost write is a data-safety event: the bridge keeps the
// text in the CRDT, tells the UI, and retries with backoff until it lands.

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness, sha256Hex } from "./helpers";

const PATH = "note.md";
const SEED = "# Title\n\nhello world\n";

function failingIo(seed: Record<string, string>) {
  const h = makeHarness(seed);
  let failing = false;
  const failed: Array<{ path: string; attempt: number }> = [];
  const recovered: string[] = [];
  const io = {
    ...h.io,
    writeFileAtomic: async (p: string, c: string) => {
      if (failing) throw new Error("ENOSPC: no space left on device");
      return h.io.writeFileAtomic(p, c);
    },
    onWriteFailed: (path: string, _err: unknown, attempt: number) => {
      failed.push({ path, attempt });
    },
    onWriteRecovered: (path: string) => {
      recovered.push(path);
    },
  };
  return { ...h, io, failed, recovered, setFailing: (v: boolean) => (failing = v) };
}

describe("egest write failure", () => {
  it("keeps the echo guard on the bytes actually on disk, reports, and retries until it lands", async () => {
    vi.useFakeTimers();
    try {
      const r = failingIo({ [PATH]: SEED });
      const bridge = await NoteBridge.open(r.io, { docId: "doc-1", path: PATH });
      r.setFailing(true);

      bridge.edit((t) => t.insert(t.toString().length, "!!!"));
      await vi.advanceTimersByTimeAsync(300); // the egest fires and FAILS

      // Nothing landed, and the guard still describes the file as it is — not
      // the bytes that never made it.
      expect(r.fs.get(PATH)).toBe(SEED);
      expect(bridge.lastHash).toBe(sha256Hex(SEED));
      expect(bridge.pendingWriteFailures).toBe(1);
      expect(r.failed).toEqual([{ path: PATH, attempt: 1 }]);
      expect(r.recovered).toEqual([]);

      // A watcher read of the (unchanged) file in the meantime is a no-op: the
      // file matches the guard, so no bogus "external edit" is diffed back into
      // the doc and the user's text survives.
      const opsBefore = bridge.updatesObserved;
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);
      expect(bridge.updatesObserved).toBe(opsBefore);
      expect(bridge.serialize()).toBe(SEED + "!!!");

      // Retry #1 at 1s — still failing. Backoff doubles.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(r.failed).toHaveLength(2);
      expect(bridge.pendingWriteFailures).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000); // 1s into the 2s wait: nothing yet
      expect(r.failed).toHaveLength(2);

      // The disk comes back. The next retry lands, the guard moves to the new
      // bytes, and the UI is told the note is safe again.
      r.setFailing(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(r.fs.get(PATH)).toBe(SEED + "!!!");
      expect(bridge.lastHash).toBe(sha256Hex(SEED + "!!!"));
      expect(bridge.pendingWriteFailures).toBe(0);
      expect(r.recovered).toEqual([PATH]);

      // And the echo of that write is dropped as usual.
      const ops = bridge.updatesObserved;
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);
      expect(bridge.updatesObserved).toBe(ops);
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushEgest on close forces an immediate retry instead of waiting out the backoff", async () => {
    vi.useFakeTimers();
    try {
      const r = failingIo({ [PATH]: SEED });
      const bridge = await NoteBridge.open(r.io, { docId: "doc-2", path: PATH });
      r.setFailing(true);
      bridge.edit((t) => t.insert(0, "x"));
      await vi.advanceTimersByTimeAsync(300);
      expect(r.fs.get(PATH)).toBe(SEED);

      r.setFailing(false);
      await bridge.flushEgest(); // close/save path
      expect(r.fs.get(PATH)).toBe("x" + SEED);
      expect(r.recovered).toEqual([PATH]);
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful write still sets the guard exactly once, after the bytes land", async () => {
    vi.useFakeTimers();
    try {
      const r = failingIo({ [PATH]: SEED });
      const bridge = await NoteBridge.open(r.io, { docId: "doc-3", path: PATH });
      bridge.edit((t) => t.insert(0, "y"));
      await vi.advanceTimersByTimeAsync(300);
      expect(r.fs.get(PATH)).toBe("y" + SEED);
      expect(bridge.lastHash).toBe(sha256Hex("y" + SEED));
      expect(r.failed).toEqual([]);
      expect(r.recovered).toEqual([]); // no failure, so no recovery cue either
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
