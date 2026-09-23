// The cold-apply doubling loop (2026-09-04, a customer's `Map of Content.md`).
//
// `coldApply` opens a TRANSIENT bridge — a brand-new `Y.Doc`, so a brand-new
// clientID every time — hydrates it from the LOCAL CRDT store, folds in the file
// on disk, applies the server's update and egests the result.
//
// Folding the file in is a three-way merge and has to stay one: an AI that
// edited the `.md` while no bridge was alive would otherwise be overwritten by
// the egest. But ingest turns file bytes into ops attributed to THIS client, so
// when the file ALREADY holds the text of the update about to be applied — which
// is what a local CRDT store that has fallen behind its own file looks like —
// that text was inserted twice: once as this client's fresh ops, once as the
// server's, and Yjs keeps both. The egest then wrote the doubled text back to
// the file, so the next update through here doubled twice as much.
//
// Production ran that eighteen times in one hour: eighteen updates, each from a
// different clientID, each re-inserting the whole current delta, ending at 2^16
// copies of one added block — 16 MB of Yjs state for a 686-byte note,
// 1,179,679 lines of 35 distinct ones.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultDocStore } from "../vaultDocStore";
import { makeHarness } from "../../bridge/__tests__/helpers";

const DOC = "doc-moc";
const PATH = "Map of Content.md";
const BASE = "# Map of Content\n\n- [[One]]\n";
const ADDED = "\n## Team\n\n- [[AI Platform]]\n";

const stateOf = (d: Y.Doc) => Y.encodeStateAsUpdate(d);
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** The server's copy of the note: ONE Yjs history, as the real server has. */
function serverDoc(text: string): Y.Doc {
  const remote = new Y.Doc();
  remote.getText("content").insert(0, text);
  return remote;
}

describe("cold apply: a local store behind its own file", () => {
  it("does not re-insert text the incoming update already carries", async () => {
    const { io, fs } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const server = serverDoc(BASE);

    // Round one: the doc, the local CRDT store and the file all hold BASE.
    await store.applyUpdate(DOC, stateOf(server));
    expect(fs.get(PATH)).toBe(BASE);

    // A teammate adds a block. It reaches this device's FILE (an earlier apply
    // egested it) but not its local CRDT store — the state the loop feeds on.
    server.getText("content").insert(BASE.length, ADDED);
    fs.externalWrite(PATH, BASE + ADDED);

    // The same block now arrives as an update.
    await store.applyUpdate(DOC, stateOf(server));

    expect(occurrences(fs.get(PATH)!, "## Team")).toBe(1);
    expect(fs.get(PATH)).toBe(BASE + ADDED);
    await store.destroyAll();
  });

  it("does not compound across successive updates", async () => {
    const { io, fs } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const server = serverDoc(BASE);
    await store.applyUpdate(DOC, stateOf(server));

    // Four rounds of the same shape — the loop that reached 2^16. Each round
    // opens a fresh transient bridge with a fresh clientID, and each round the
    // file is one step ahead of the local store.
    server.getText("content").insert(BASE.length, ADDED);
    for (let i = 0; i < 4; i++) {
      fs.externalWrite(PATH, server.getText("content").toString());
      await store.applyUpdate(DOC, stateOf(server));
    }

    expect(occurrences(fs.get(PATH)!, "## Team")).toBe(1);
    expect(fs.get(PATH)).toBe(BASE + ADDED);
    await store.destroyAll();
  });

  it("still merges a genuine external edit the server has never seen", async () => {
    const { io, fs } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const server = serverDoc(BASE);
    await store.applyUpdate(DOC, stateOf(server));

    // An AI edits the file while no bridge is alive, and a teammate's update
    // lands for the same note. Both contributions must survive.
    fs.externalWrite(PATH, BASE + "- [[Written by the AI]]\n");
    server.getText("content").insert(BASE.length, "- [[From a teammate]]\n");
    await store.applyUpdate(DOC, stateOf(server));

    const onDisk = fs.get(PATH)!;
    expect(onDisk).toContain("- [[Written by the AI]]");
    expect(onDisk).toContain("- [[From a teammate]]");
    await store.destroyAll();
  });
});

/**
 * One writer per doc_id — the promote side of the same rule.
 *
 * `coldApply` holds its transient bridge across several awaits (loadYjsState,
 * the `isExternalEdit` read, the egest write, `whenPersisted`). A `promote`
 * landing inside that window used to see nothing in the hot tier and open a
 * SECOND bridge on the same doc_id: two egests racing one file, two persist
 * streams, and — on a `force`/`ingestFromFile` run — the hot bridge ingesting
 * the text the cold one had just written from the remote update, which is the
 * doubling loop `isExternalEdit` closed on the cold side. `release` already
 * awaited the chain; `promote` now does too.
 */
describe("one writer per doc_id", () => {
  it("promote waits for an in-flight cold apply on the same doc", async () => {
    const { io, fs } = makeHarness({ [PATH]: BASE });
    // A gate the cold apply blocks on, inside its `isExternalEdit` read.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let hold = false;
    const slow = {
      ...io,
      readFile: async (p: string) => {
        if (hold) {
          hold = false;
          await gate;
        }
        return io.readFile(p);
      },
    };
    const store = new VaultDocStore({ io: slow, resolvePath: () => PATH });
    const server = serverDoc(BASE);
    await store.applyUpdate(DOC, stateOf(server));

    // A teammate's block arrives while the file is one step ahead — the shape
    // that makes `coldApply` read the file, where it now blocks.
    server.getText("content").insert(BASE.length, ADDED);
    fs.externalWrite(PATH, BASE + ADDED);
    const order: string[] = [];
    hold = true;
    const cold = store.applyUpdate(DOC, stateOf(server)).then(() => order.push("cold"));
    expect(store.pendingColdDocs()).toEqual([DOC]);

    // The content uploader promotes the very same doc mid-apply.
    const promoted = store.promote(DOC, PATH).then((b) => {
      order.push("promote");
      return b;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]); // neither has resolved: the promote is waiting

    open();
    const bridge = await promoted;
    await cold;
    expect(order).toEqual(["cold", "promote"]);
    // One writer, so one copy of the teammate's block everywhere.
    expect(occurrences(fs.get(PATH)!, "## Team")).toBe(1);
    expect(bridge.serialize()).toBe(BASE + ADDED);
    await store.destroyAll();
  });

  it("routes an update queued mid-promote into the resident bridge", async () => {
    const { io } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const server = serverDoc(BASE);
    await store.applyUpdate(DOC, stateOf(server));

    const bridge = await store.promote(DOC, PATH);
    server.getText("content").insert(BASE.length, ADDED);
    await store.applyUpdate(DOC, stateOf(server));

    // It reached the hot bridge, not a second transient one.
    expect(bridge.serialize()).toBe(BASE + ADDED);
    expect(store.pendingColdDocs()).toEqual([]);
    await store.destroyAll();
  });

  it("two concurrent promotes share one bridge", async () => {
    const { io } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const [a, b] = await Promise.all([
      store.promote(DOC, PATH, { pin: true }),
      store.promote(DOC, PATH),
    ]);
    expect(a).toBe(b);
    await store.destroyAll();
  });
});

/**
 * #200: the same double insert through a TIMER. `NoteBridge.open` used to arm
 * a debounced ingest for any non-empty doc, then await a load-time compaction
 * (> 64 rows or > 1 MB). When that compaction outlived the 150 ms debounce,
 * the ingest merged the file before `coldApply` got to look at it — and then
 * applied the very update the file already reflected, on top.
 */
describe("cold apply: a slow load-time compaction", () => {
  it("does not merge the file before the update is applied", async () => {
    const server = serverDoc("x 97\n");
    const base = stateOf(server);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, base);
    const sv = Y.encodeStateVector(server);
    peer.getText("content").delete(2, 1);
    peer.getText("content").insert(2, "12");
    const delta = Y.encodeStateAsUpdate(peer, sv);

    const { io, fs, persistence } = makeHarness({ [PATH]: "x 127\n" });
    // Enough rows that opening the doc compacts it, and a snapshot write slow
    // enough to outlive the ingest debounce.
    for (let i = 0; i < 70; i++) await persistence.appendUpdate(DOC, base);
    const save = persistence.saveSnapshot.bind(persistence);
    persistence.saveSnapshot = async (...a: Parameters<typeof save>) => {
      await new Promise((r) => setTimeout(r, 250));
      return save(...a);
    };
    const merges: string[] = [];
    const store = new VaultDocStore({
      io,
      resolvePath: () => PATH,
      onExternalMerge: (d) => merges.push(d),
    });

    await store.applyUpdate(DOC, delta);

    expect(fs.get(PATH)).toBe("x 127\n");
    expect(merges).toEqual([]);
    await store.destroyAll();
  });
});

/**
 * #200: the editor's bridge outlives its provider by one flush. While it is
 * closing, a background update for the same doc must wait for it — never open
 * a second bridge beside it — and must still be applied afterwards.
 */
describe("closing hold", () => {
  it("queues a feed update behind the closing editor bridge", async () => {
    const { io, fs } = makeHarness({ [PATH]: BASE });
    const store = new VaultDocStore({ io, resolvePath: () => PATH });
    const server = serverDoc(BASE);
    await store.applyUpdate(DOC, stateOf(server));

    let finishClose!: () => void;
    const closing = new Promise<void>((r) => {
      finishClose = r;
    });
    store.holdUntil(DOC, closing);

    server.getText("content").insert(BASE.length, ADDED);
    const applied = store.applyUpdate(DOC, stateOf(server));
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.get(PATH)).toBe(BASE); // held, not applied beside the closing bridge
    expect(store.pendingColdDocs()).toEqual([DOC]);

    finishClose();
    await applied;
    expect(fs.get(PATH)).toBe(BASE + ADDED);
    await store.destroyAll();
  });
});
