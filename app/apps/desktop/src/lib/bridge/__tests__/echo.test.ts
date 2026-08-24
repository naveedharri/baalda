// Echo-loop: a CRDT edit egests to the file; the resulting watcher event must
// be dropped by the ingest guard, producing zero new Y.Text ops and no further
// writes — the loop closes and the doc goes quiescent (spec 03 §6).

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const SEED = "# Title\n\nhello world\n";

describe("echo-loop suppression", () => {
  it("drops the watcher echo of our own write: no new ops, no further writes", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs, persistence } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // 1. A local editor edit → schedules an egest.
      bridge.edit((t) => t.insert(t.toString().length, "!!!"));
      const opsAfterEdit = bridge.updatesObserved;
      const writesBeforeEgest = fs.writeCount;

      // 2. Egest fires → writes file + sets lastWrittenHash.
      await vi.advanceTimersByTimeAsync(300);
      expect(fs.writeCount).toBe(writesBeforeEgest + 1);
      const content = bridge.serialize();
      expect(fs.get(PATH)).toBe(content);

      const opsAfterEgest = bridge.updatesObserved;
      const logAfterEgest = persistence.logLength("doc-1");
      const writesAfterEgest = fs.writeCount;

      // 3. The watcher fires for OUR write. Ingest must recognize the echo.
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      // Zero new Y.Text ops from the echo.
      expect(bridge.updatesObserved).toBe(opsAfterEgest);
      expect(persistence.logLength("doc-1")).toBe(logAfterEgest);
      // Doc content unchanged.
      expect(bridge.serialize()).toBe(content);
      // No follow-on write triggered.
      expect(fs.writeCount).toBe(writesAfterEgest);

      // 4. Quiescence: advancing more timers produces nothing new.
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.updatesObserved).toBe(opsAfterEgest);
      expect(fs.writeCount).toBe(writesAfterEgest);

      // Sanity: the edit itself did add ops earlier.
      expect(opsAfterEgest).toBeGreaterThan(0);
      expect(opsAfterEdit).toBeGreaterThan(0);

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a burst of watcher events for one write drains as a single dropped ingest", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: SEED });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      bridge.edit((t) => t.insert(0, "X"));
      await vi.advanceTimersByTimeAsync(300);
      const ops = bridge.updatesObserved;
      const reads = fs.readCount;

      // Five rapid watcher events collapse into one debounced drain.
      bridge.ingest();
      bridge.ingest();
      bridge.ingest();
      bridge.ingest();
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      expect(fs.readCount).toBe(reads + 1); // exactly one drained read
      expect(bridge.updatesObserved).toBe(ops); // still an echo → dropped
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ingestNow — the sync layer's immediate ingest", () => {
  const PATH2 = "closed.md";

  it("merges an external edit synchronously and reports the change", async () => {
    const { io, fs } = makeHarness({ [PATH2]: "one two three" });
    const bridge = await NoteBridge.open(io, { docId: "doc-2", path: PATH2 });

    fs.externalWrite(PATH2, "one two three four");
    await expect(bridge.ingestNow()).resolves.toBe(true);
    expect(bridge.serialize()).toBe("one two three four");

    bridge.destroy();
  });

  it("reports no change for our own echo and for an already-converged file", async () => {
    const { io, fs } = makeHarness({ [PATH2]: "steady" });
    const bridge = await NoteBridge.open(io, { docId: "doc-2", path: PATH2 });

    // Nothing changed on disk: converged → false, and no ops.
    const ops = bridge.updatesObserved;
    await expect(bridge.ingestNow()).resolves.toBe(false);
    expect(bridge.updatesObserved).toBe(ops);
    expect(fs.get(PATH2)).toBe("steady");

    bridge.destroy();
  });

  it("supersedes a pending debounced ingest (no double apply afterwards)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs, persistence } = makeHarness({ [PATH2]: "base" });
      const bridge = await NoteBridge.open(io, { docId: "doc-2", path: PATH2 });

      fs.externalWrite(PATH2, "base plus");
      bridge.ingest(); // watcher path arms the 150ms timer…
      await expect(bridge.ingestNow()).resolves.toBe(true); // …sync layer wants it NOW
      expect(bridge.serialize()).toBe("base plus");
      const log = persistence.logLength("doc-2");

      // The armed timer must not fire a second apply.
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.serialize()).toBe("base plus");
      expect(persistence.logLength("doc-2")).toBe(log);

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reopen after an external edit while the doc was closed", () => {
  it("ingests the file's newer content on hydrate (disk is the durable truth)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ "n.md": "original" });
      const first = await NoteBridge.open(io, { docId: "d", path: "n.md" });
      expect(first.serialize()).toBe("original");
      first.destroy();

      // An AI (or any external editor) rewrites the file while no bridge exists —
      // the watcher event it caused had nothing to ingest into.
      fs.externalWrite("n.md", "original, then edited outside the app");

      const second = await NoteBridge.open(io, { docId: "d", path: "n.md" });
      await vi.advanceTimersByTimeAsync(150); // the hydrate-scheduled ingest
      expect(second.serialize()).toBe("original, then edited outside the app");
      second.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spuriously ingest when file and doc already agree", async () => {
    vi.useFakeTimers();
    try {
      const { io, persistence } = makeHarness({ "n.md": "same" });
      const first = await NoteBridge.open(io, { docId: "d", path: "n.md" });
      first.destroy();

      const second = await NoteBridge.open(io, { docId: "d", path: "n.md" });
      const log = persistence.logLength("d");
      await vi.advanceTimersByTimeAsync(1000);
      expect(second.serialize()).toBe("same");
      expect(persistence.logLength("d")).toBe(log); // zero new ops
      second.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
