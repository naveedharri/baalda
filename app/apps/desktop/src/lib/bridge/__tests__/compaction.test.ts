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
import { BridgeManager } from "../adapter";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const DOC = "doc-1";

/** Wait for the append→compact chain (each hop is a resolved promise). The
 *  chain is one `whenPersisted()` deep per compaction — the watermark makes it
 *  flush every issued append before it encodes — so give it plenty of turns. */
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
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

/**
 * Compaction truncates the log it snapshotted — and NOTHING newer.
 *
 * `compact()` encodes the doc, then awaits the store. Typing carries on inside
 * that await (the row trigger fires at 64 rows, i.e. mid-session), and those
 * appends are not in the snapshot. A blanket `DELETE FROM yjs_updates WHERE
 * doc_id = ?` took them anyway, and the doc then loaded SHORT: Yjs parks the
 * surviving later updates as pending against the missing one's items and never
 * integrates them. The watermark (`upTo` = the highest row id the bridge has
 * been told about, taken after `whenPersisted()`) is exactly the set the
 * snapshot covers.
 */
describe("compaction watermark", () => {
  it("keeps an update appended while the snapshot was being saved", async () => {
    const h = makeHarness({ [PATH]: "" });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const store = h.persistence;
    let bridge: NoteBridge | null = null;
    const io = {
      ...h.io,
      persistence: {
        loadState: (id: string) => store.loadState(id),
        appendUpdate: (id: string, u: Uint8Array) => store.appendUpdate(id, u),
        saveSnapshot: async (
          id: string,
          snap: Uint8Array,
          sv: Uint8Array,
          upTo?: number,
        ) => {
          // The keystroke that lands while the save is in flight.
          bridge?.text.insert(bridge.text.length, "LATE");
          await held;
          await store.saveSnapshot(id, snap, sv, upTo);
        },
      },
    };
    bridge = await NoteBridge.open(io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 2, compactBytes: 10 * 1024 * 1024 },
    });

    for (let i = 0; i < 4; i++) bridge.text.insert(bridge.text.length, `${i}`);
    await settle();
    release();
    await settle();
    await bridge.whenPersisted();

    expect(store.snapshotOf(DOC)).not.toBeNull();
    // The late append outlived the truncation…
    expect(store.logLength(DOC)).toBeGreaterThan(0);
    const text = bridge.serialize();
    bridge.destroy();

    // …and, decisively, a fresh bridge over snapshot + surviving log rebuilds
    // the same text. A log truncated past its snapshot loads short here.
    const reopened = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 1_000_000, compactBytes: 0 },
    });
    expect(reopened.serialize()).toBe(text);
    expect(text).toContain("LATE");
    reopened.destroy();
  });

  it("truncates nothing when the store reports no row ids", async () => {
    // An older host: `appendUpdate` answers undefined and `loadState` carries no
    // `lastUpdateId`, so there is no watermark. The snapshot is still written;
    // the log is simply read again next time — never deleted unseen.
    const h = makeHarness({ [PATH]: "" });
    const store = h.persistence;
    const io = {
      ...h.io,
      persistence: {
        loadState: async (id: string) => {
          const s = await store.loadState(id);
          return { snapshot: s.snapshot, updates: s.updates, updateCount: s.updateCount };
        },
        appendUpdate: async (id: string, u: Uint8Array) => {
          await store.appendUpdate(id, u);
          return undefined as unknown as number;
        },
        saveSnapshot: (id: string, snap: Uint8Array, sv: Uint8Array, upTo?: number) =>
          store.saveSnapshot(id, snap, sv, upTo),
      },
    };
    const bridge = await NoteBridge.open(io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 2, compactBytes: 10 * 1024 * 1024 },
    });
    for (let i = 0; i < 4; i++) bridge.text.insert(bridge.text.length, `${i}`);
    await settle();

    expect(store.snapshotOf(DOC)).not.toBeNull();
    expect(store.logLength(DOC)).toBe(4);
    bridge.destroy();

    const reopened = await NoteBridge.open(h.io, {
      docId: DOC,
      path: PATH,
      config: { compactThreshold: 1_000_000, compactBytes: 0 },
    });
    expect(reopened.serialize()).toBe("0123");
    reopened.destroy();
  });
});


/**
 * Closing a note must not drop the ops it applied (desktop-audit #8).
 *
 * `destroy()` is synchronous and appends are fire-and-forget, so retiring on
 * the flush alone left the local CRDT log BEHIND the `.md` the same teardown
 * had just written — the gap a later bridge re-inserts the file's text from.
 * `VaultDocStore.retire` always did this; the open note's manager didn't.
 */
describe("BridgeManager.retire", () => {
  it("waits for the doc's appends before destroying the bridge", async () => {
    const h = makeHarness({ [PATH]: "" });
    let resolveAppend!: () => void;
    const gate = new Promise<void>((r) => {
      resolveAppend = r;
    });
    const io = {
      ...h.io,
      persistence: {
        loadState: (id: string) => h.persistence.loadState(id),
        appendUpdate: async (id: string, u: Uint8Array) => {
          await gate; // the IPC is still in flight when the note closes
          return h.persistence.appendUpdate(id, u);
        },
        saveSnapshot: (id: string, s: Uint8Array, v: Uint8Array, upTo?: number) =>
          h.persistence.saveSnapshot(id, s, v, upTo),
      },
    };
    const manager = new BridgeManager(io);
    const bridge = await manager.openNote(PATH, DOC, { seedFromFile: true });
    bridge.text.insert(0, "typed just before closing");

    let closed = false;
    const closing = manager.closeCurrent().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false); // still waiting on the append
    expect(h.persistence.logLength(DOC)).toBe(0);

    resolveAppend();
    await closing;
    expect(h.persistence.logLength(DOC)).toBeGreaterThan(0);
  });
});
