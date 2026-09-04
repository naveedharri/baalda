// An egest whose bytes the file ALREADY holds must not write.
//
// Where this bites: a sync run rewrote nearly every file in the vault (measured
// 2026-09-04 — 1,372 of a 1,560-note vault's files inside three minutes), and a
// write is not free. It costs an atomic write, a watcher event, an index pass,
// and a fresh mtime — which is the sidebar's "Recently modified" sort key, so
// every redundant write re-sorted the row the user was pointing at.
//
// `lastWrittenHash` already knows what the file holds: egest sets it once a
// write is confirmed, ingest and the seed paths set it from the file they read.

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const SEED = "# Title\n\nhello world\n";

describe("no-op egest", () => {
  it("does not write when the doc lands back on the bytes already on disk", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });
      const writesBefore = fs.writeCount;

      // The doc churns — two ops, a real update appended to the CRDT log — but
      // it settles on exactly what the file says. This is the shape of a remote
      // update that agrees with disk.
      bridge.edit((t) => t.insert(0, "draft "));
      bridge.edit((t) => t.delete(0, 6));
      expect(bridge.serialize()).toBe(SEED);

      await vi.advanceTimersByTimeAsync(300);
      expect(fs.writeCount).toBe(writesBefore);
      expect(fs.get(PATH)).toBe(SEED);

      // …and the guard is still honest afterwards: a genuine change DOES write.
      bridge.edit((t) => t.insert(t.toString().length, "more\n"));
      await vi.advanceTimersByTimeAsync(300);
      expect(fs.writeCount).toBe(writesBefore + 1);
      expect(fs.get(PATH)).toBe(SEED + "more\n");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retracts a standing write failure when the disk turns out to be right", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ [PATH]: SEED });
      let failing = false;
      const recovered: string[] = [];
      const io = {
        ...h.io,
        writeFileAtomic: async (p: string, c: string) => {
          if (failing) throw new Error("EACCES: permission denied");
          return h.io.writeFileAtomic(p, c);
        },
        onWriteRecovered: (path: string) => recovered.push(path),
      };
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      failing = true;
      bridge.edit((t) => t.insert(t.toString().length, "!!!"));
      await vi.advanceTimersByTimeAsync(300);
      expect(bridge.pendingWriteFailures).toBe(1);

      // The edit is undone before the retry lands, so what the failed write was
      // trying to put on disk is what is already there. Nothing left to retry.
      failing = false;
      bridge.edit((t) => t.delete(t.toString().length - 3, 3));
      await vi.advanceTimersByTimeAsync(2000);
      expect(bridge.pendingWriteFailures).toBe(0);
      expect(recovered).toEqual([PATH]);
      expect(h.fs.get(PATH)).toBe(SEED);

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
