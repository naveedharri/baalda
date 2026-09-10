// When the CRDT log is replaced by a snapshot.
//
// The trigger used to be "more than `compactThreshold` rows, checked once at
// load". On the 5,933-note vault measured in September 2026 it had never fired:
// the busiest doc held 58 updates against a threshold of 64 — while 28
// individual updates were over a megabyte each. So the thing that costs time on
// every open (bytes to read and apply) was the thing nothing was counting.
//
// Now both measures fire, and both fire LIVE as well as at load.

import { describe, expect, it } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const DOC = "doc-1";

/** Wait for the append→compact chain (each hop is a resolved promise). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("compaction triggers", () => {
  it("compacts on bytes, well before the row count would fire", async () => {
    const h = makeHarness({ [PATH]: "" });
    const bridge = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      // 8 KB of pending updates is "large" here; the row threshold stays high
      // so only the byte trigger can explain a snapshot.
      config: { compactBytes: 8 * 1024, compactThreshold: 1000 },
    });

    // One paste-sized edit: a single update, far above the byte budget.
    bridge.text.insert(0, "x".repeat(20_000));
    await settle();

    expect(h.persistence.snapshotOf(DOC)).not.toBeNull();
    expect(h.persistence.logLength(DOC)).toBe(0);
    expect(bridge.pendingLogBytes).toBe(0);
    // The text survived the truncation — that is the whole contract.
    expect(bridge.serialize().length).toBe(20_000);

    bridge.destroy();
  });

  it("still compacts on the row count for many small edits", async () => {
    const h = makeHarness({ [PATH]: "" });
    const bridge = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 5, compactBytes: 10 * 1024 * 1024 },
    });

    for (let i = 0; i < 8; i++) bridge.text.insert(bridge.text.length, `${i}`);
    await settle();

    expect(h.persistence.snapshotOf(DOC)).not.toBeNull();
    expect(bridge.serialize()).toBe("01234567");

    bridge.destroy();
  });

  it("leaves a small log alone", async () => {
    const h = makeHarness({ [PATH]: "" });
    const bridge = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 1000, compactBytes: 1024 * 1024 },
    });

    bridge.text.insert(0, "hello");
    await settle();

    expect(h.persistence.snapshotOf(DOC)).toBeNull();
    expect(h.persistence.logLength(DOC)).toBe(1);

    bridge.destroy();
  });

  it("compacts at LOAD when the persisted log is big in bytes", async () => {
    // The reason this matters on a launch: every doc the vault channel or the
    // editor opens replays this log first.
    const h = makeHarness({ [PATH]: "" });
    const first = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      // Compaction off while we build the log up.
      config: { compactThreshold: 1_000_000, compactBytes: 0 },
    });
    first.text.insert(0, "y".repeat(30_000));
    await settle();
    first.destroy();
    expect(h.persistence.snapshotOf(DOC)).toBeNull();
    expect(h.persistence.logLength(DOC)).toBeGreaterThan(0);

    const reopened = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 1_000_000, compactBytes: 8 * 1024 },
    });

    expect(h.persistence.snapshotOf(DOC)).not.toBeNull();
    expect(h.persistence.logLength(DOC)).toBe(0);
    expect(reopened.serialize().length).toBe(30_000);

    reopened.destroy();
  });
});
