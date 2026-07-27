// F4 — the per-note UndoManager must be bounded.
//
// Every tracked local edit pushes a StackItem AND makes Yjs pin the structs that
// edit deleted (`keepItem(item, true)`) so undo can restore them. Unbounded,
// one long session in a single note grows both forever. These tests run the same
// workload twice — with trimming disabled (the old behaviour) and enabled — so
// the difference is the fix, not the harness.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { ORIGIN_EDITOR } from "../types";
import { makeHarness } from "./helpers";

/**
 * How many characters of *deleted* content the doc is still holding onto.
 * Collecting a deleted struct swaps its content for `ContentDeleted` (a bare
 * length) — anything else means the text itself is still in memory, pinned by
 * the UndoManager so it could be restored.
 */
function pinnedDeletedChars(doc: Y.Doc): number {
  let n = 0;
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (s instanceof Y.Item && s.deleted && !(s.content instanceof Y.ContentDeleted)) {
        n += s.length;
      }
    }
  }
  return n;
}

const CHUNK_LEN = 24;

/** `cycles` independent edit steps, each inserting then deleting a chunk. */
async function churn(bridge: NoteBridge, cycles: number): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    const chunk = `chunk-${String(i).padStart(4, "0")}-${"x".repeat(12)}\n`;
    if (chunk.length !== CHUNK_LEN) throw new Error(`chunk len ${chunk.length}`);
    bridge.doc.transact(() => bridge.text.insert(0, chunk), ORIGIN_EDITOR);
    bridge.doc.transact(() => bridge.text.delete(0, chunk.length), ORIGIN_EDITOR);
  }
}

async function openWith(limit: number): Promise<NoteBridge> {
  const { io } = makeHarness({ "n.md": "seed\n" });
  return NoteBridge.open(io, {
    docId: `d-${limit}`,
    path: "n.md",
    // captureTimeout 0 ⇒ every transaction is its own step, so "cycles" maps
    // 1:1 onto stack depth and the test doesn't depend on wall-clock timing.
    config: { undoCaptureTimeoutMs: 0, undoStackLimit: limit },
  });
}

const CYCLES = 60;
const LIMIT = 5;

describe("undo history is bounded", () => {
  it("without trimming, the stack and its GC pins grow with every edit", async () => {
    const bridge = await openWith(0); // 0 disables trimming = pre-fix behaviour
    await churn(bridge, CYCLES);

    // Two steps per cycle (insert, delete) — nothing is ever released.
    expect(bridge.undoDepth).toBe(CYCLES * 2);
    // Every character ever deleted is still pinned (CHUNK chars per cycle).
    expect(pinnedDeletedChars(bridge.doc)).toBeGreaterThanOrEqual(
      CYCLES * CHUNK_LEN,
    );
    bridge.destroy();
  });

  it("caps the stack depth and releases the dropped steps' GC pins", async () => {
    const bridge = await openWith(LIMIT);
    await churn(bridge, CYCLES);

    expect(bridge.undoDepth).toBe(LIMIT);
    // Only the retained steps may still pin deleted content: O(limit), not
    // O(edits). Pre-fix this was >= CYCLES * CHUNK_LEN (~1500 chars).
    expect(pinnedDeletedChars(bridge.doc)).toBeLessThanOrEqual(LIMIT * CHUNK_LEN);
    bridge.destroy();
  });

  it("trimming keeps recent undo working (oldest steps go, newest stay)", async () => {
    const bridge = await openWith(LIMIT);
    await churn(bridge, CYCLES);
    const settled = bridge.serialize(); // every chunk was inserted then deleted

    // The newest step was the delete of the last chunk. Undoing it must bring
    // that text BACK — only possible if the retained steps kept their pins, so
    // this is the assertion that the trim didn't over-release.
    const last = `chunk-${String(CYCLES - 1).padStart(4, "0")}-${"x".repeat(12)}\n`;
    bridge.undoManager.undo();
    expect(bridge.serialize()).toBe(last + settled);
    bridge.undoManager.redo();
    expect(bridge.serialize()).toBe(settled);

    // The remaining retained steps are still undoable — no wall at depth 1.
    let undos = 0;
    while (bridge.undoManager.canUndo()) {
      bridge.undoManager.undo();
      undos++;
      if (undos > LIMIT + 2) break; // guard against an infinite loop
    }
    expect(undos).toBe(LIMIT);
    // ...and the deepest retained step's chunk came back intact too, so the pins
    // that survived really do still carry content.
    //
    // Which chunk that is falls out of the churn shape: the retained steps
    // alternate insert/delete, so each *pair* of undos restores a chunk and then
    // removes it again, netting back to `settled`. With an odd LIMIT the final
    // undo is the leftover delete-undo, leaving that cycle's chunk in place.
    // LIMIT=5 therefore lands on cycle 57, not 58. Computed, not hardcoded, so
    // it tracks LIMIT/CYCLES instead of silently rotting if either changes.
    if (LIMIT % 2 === 0) throw new Error("this assertion assumes an odd LIMIT");
    const deepest = CYCLES - 1 - (LIMIT - 1) / 2;
    const prev = `chunk-${String(deepest).padStart(4, "0")}-${"x".repeat(12)}\n`;
    expect(bridge.serialize()).toContain(prev);
    bridge.destroy();
  });

  it("the default bound is generous: hundreds of steps stay undoable", async () => {
    const { io } = makeHarness({ "big.md": "" });
    const bridge = await NoteBridge.open(io, {
      docId: "big",
      path: "big.md",
      config: { undoCaptureTimeoutMs: 0 }, // default undoStackLimit
    });
    await churn(bridge, 150); // 300 steps
    expect(bridge.undoDepth).toBe(300);
    bridge.destroy();
  });

  it("trimming does not append phantom updates to the CRDT log", async () => {
    const { io, persistence } = makeHarness({ "q.md": "" });
    const bridge = await NoteBridge.open(io, {
      docId: "q",
      path: "q.md",
      config: { undoCaptureTimeoutMs: 0, undoStackLimit: 2, compactThreshold: 10_000 },
    });
    await churn(bridge, 20);
    await Promise.resolve();
    // 40 content transactions ⇒ 40 logged updates; the trim's own (empty)
    // transaction must not add any.
    expect(persistence.logLength("q")).toBe(40);
    expect(bridge.updatesObserved).toBe(40);
    bridge.destroy();
  });

  it("the trimmed doc still serializes and round-trips its state", async () => {
    const { io } = makeHarness({ "r.md": "" });
    const bridge = await NoteBridge.open(io, {
      docId: "r",
      path: "r.md",
      config: { undoCaptureTimeoutMs: 0, undoStackLimit: 3 },
    });
    await churn(bridge, 30);
    bridge.doc.transact(() => bridge.text.insert(0, "final content"), ORIGIN_EDITOR);

    // A peer applying the doc's full state must see exactly the same text —
    // releasing GC pins must not lose live content.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(bridge.doc));
    expect(peer.getText("content").toString()).toBe(bridge.serialize());
    peer.destroy();
    bridge.destroy();
  });
});
