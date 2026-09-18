// The batched content push: what it sends, what it refuses to send, and what it
// does when the server says "I am not empty after all".
//
// The doc-doubling question is the reason this file uses a REAL `NoteBridge`
// over an in-memory store rather than a stub: the whole safety argument of
// seeding a doc without first pulling it rests on (a) the server re-checking
// emptiness under `expectEmpty`, and (b) this client throwing the seed away
// when that check fails. (b) is only true if the seed can actually be thrown
// away, which is a property of the bridge and its persistence, not of a mock.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../../bridge/noteBridge";
import type { BridgeIO, CrdtPersistence, YjsPersistedState } from "../../bridge/types";
import { FakeFs, sha256Hex } from "../../bridge/__tests__/helpers";
import type { DocPushItem, DocPushResult } from "../bulkTypes";
import { DocBatchPusher, type DocPushWork } from "../docBatchPush";
import { BATCH_MAX_DECODED_BYTES, BATCH_MAX_DOCS, BULK_ITEM_MAX_BYTES } from "../pool";

/** The SQLite CRDT tables, in memory, plus the one thing the conflict path
 *  needs that production gets from `ipc.clearYjsDoc`: a way to drop a doc. */
class MemPersistence implements CrdtPersistence {
  private docs = new Map<
    string,
    { snapshot: Uint8Array | null; stateVector: Uint8Array | null; updates: Uint8Array[] }
  >();
  private nextId = 0;

  private store(docId: string) {
    let d = this.docs.get(docId);
    if (!d) {
      d = { snapshot: null, stateVector: null, updates: [] };
      this.docs.set(docId, d);
    }
    return d;
  }
  async loadState(docId: string): Promise<YjsPersistedState> {
    const d = this.docs.get(docId);
    if (!d) return { snapshot: null, updates: [], updateCount: 0 };
    return { snapshot: d.snapshot, updates: [...d.updates], updateCount: d.updates.length };
  }
  async appendUpdate(docId: string, update: Uint8Array): Promise<number> {
    this.store(docId).updates.push(update);
    return ++this.nextId;
  }
  async saveSnapshot(docId: string, snapshot: Uint8Array, sv: Uint8Array): Promise<void> {
    const d = this.store(docId);
    d.snapshot = snapshot;
    d.stateVector = sv;
    d.updates = [];
  }
  /** `ipc.clearYjsDoc` — the conflict undo. */
  clear(docId: string): void {
    this.docs.delete(docId);
  }
  has(docId: string): boolean {
    const d = this.docs.get(docId);
    return !!d && (d.snapshot != null || d.updates.length > 0);
  }
}

function harness(seed: Record<string, string> = {}) {
  const fs = new FakeFs(seed);
  const persistence = new MemPersistence();
  const io: BridgeIO = {
    readFile: (p) => fs.readFile(p),
    writeFileAtomic: (p, c) => fs.writeFileAtomic(p, c),
    sha256: sha256Hex,
    persistence,
    onError: () => {},
  };
  return { fs, persistence, io };
}

/** A pusher wired to real bridges over `io`, and a scriptable server. */
function pusher(
  io: BridgeIO,
  work: DocPushWork[],
  opts: {
    answer?: (items: DocPushItem[]) => DocPushResult[];
    fail?: () => void;
    readFile?: (relPath: string) => Promise<string>;
    discard?: (docId: string) => Promise<void>;
    skip?: (docId: string) => boolean;
  } = {},
) {
  const bridges = new Map<string, NoteBridge>();
  const requests: DocPushItem[][] = [];
  const pushed: string[] = [];
  const failures: Array<{ docId: string; reason: string; permanent?: boolean }> = [];
  const released: string[] = [];

  const p = new DocBatchPusher({
    work,
    markPushed: (docId) => pushed.push(docId),
    onFailure: (f) => failures.push(f),
    skip: opts.skip,
    deps: {
      acquire: async (docId, relPath) => {
        const existing = bridges.get(docId);
        if (existing) return existing;
        const bridge = await NoteBridge.open(io, { docId, path: relPath, seedFromFile: false });
        bridges.set(docId, bridge);
        return bridge;
      },
      release: async (docId) => {
        released.push(docId);
        // `demote` flushes the pending write and retires the bridge.
        await bridges.get(docId)?.flushEgest();
      },
      push: async (items) => {
        requests.push(items);
        opts.fail?.();
        return (
          opts.answer?.(items) ??
          items.map((i) => ({ docId: i.docId, status: "applied" as const, code: null, error: null }))
        );
      },
      readFile: opts.readFile,
      discardLocalCrdt: opts.discard,
    },
  });
  return { p, bridges, requests, pushed, failures, released };
}

const text = (b: NoteBridge) => b.doc.getText("content").toString();

beforeEach(() => vi.clearAllMocks());

describe("what gets seeded, and what carries expectEmpty", () => {
  it("seeds a server-empty doc from its file and flags it expectEmpty", async () => {
    const { io, fs } = harness({ "a.md": "file text" });
    const h = pusher(io, [{ docId: "a", relPath: "a.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
    });
    const out = await h.p.run();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0][0].expectEmpty).toBe(true);
    expect(text(h.bridges.get("a")!)).toBe("file text");
    expect(out.pushed).toBe(1);
    expect(h.pushed).toEqual(["a"]);
  });

  it("NEVER seeds a doc that already has text, even when the server says empty", async () => {
    const { io, fs, persistence } = harness({ "a.md": "file text" });
    // Give the doc its own content first, the way a previous session would have.
    const seeded = await NoteBridge.open(io, { docId: "a", path: "a.md", seedFromFile: false });
    seeded.edit((t) => t.insert(0, "doc text"));
    await seeded.whenPersisted();
    expect(persistence.has("a")).toBe(true);

    const h = pusher(io, [{ docId: "a", relPath: "a.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
    });
    await h.p.run();

    // The file's bytes were NOT inserted — the doc is unchanged…
    expect(text(h.bridges.get("a")!)).toBe("doc text");
    // …and without a seed there is no emptiness claim to make.
    expect(h.requests[0][0].expectEmpty).toBeUndefined();
  });

  it("sends a doc with local CRDT state WITHOUT expectEmpty (a plain merge)", async () => {
    const { io } = harness();
    const bridge = await NoteBridge.open(io, { docId: "b", path: "b.md", seedFromFile: false });
    bridge.edit((t) => t.insert(0, "typed offline"));
    await bridge.whenPersisted();

    const h = pusher(io, [{ docId: "b", relPath: "b.md", serverEmpty: false }]);
    await h.p.run();
    expect(h.requests[0][0].expectEmpty).toBeUndefined();
  });

  it("settles empty-everywhere without a request at all", async () => {
    const { io, fs } = harness({ "e.md": "" });
    const h = pusher(io, [{ docId: "e", relPath: "e.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
    });
    await h.p.run();
    expect(h.requests).toHaveLength(0);
    expect(h.pushed).toEqual(["e"]); // confirmed by definition: nothing anywhere
  });

  it("never touches the open note", async () => {
    const { io, fs } = harness({ "a.md": "file text" });
    const h = pusher(io, [{ docId: "a", relPath: "a.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
      skip: (docId) => docId === "a",
    });
    await h.p.run();
    expect(h.requests).toHaveLength(0);
    expect(h.bridges.size).toBe(0);
  });
});

describe("conflict — the server was not empty after all", () => {
  /** What the follow-up `DocSync` path does: pull, seed-if-empty, ingest. */
  async function followUp(io: BridgeIO, docId: string, relPath: string, serverUpdate: Uint8Array) {
    const bridge = await NoteBridge.open(io, { docId, path: relPath, seedFromFile: false });
    const duringPull: string[] = [];
    bridge.applyRemote(serverUpdate); // PULL FIRST
    duringPull.push(text(bridge));
    await bridge.seedFromFileIfEmpty(); // a no-op on a non-empty doc
    await bridge.ingestNow(); // fold the file back in as a DIFF
    return { bridge, duringPull };
  }

  it("discards the seed, so the follow-up merge can neither double nor lose the text", async () => {
    // The dangerous case: the file and the server hold the SAME text, so a
    // second insert history is indistinguishable from real content.
    const SAME = "the note everyone already has";
    const { io, fs, persistence } = harness({ "n.md": SAME });
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, SAME);
    const serverUpdate = Y.encodeStateAsUpdate(serverDoc);

    const h = pusher(io, [{ docId: "n", relPath: "n.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
      answer: (items) =>
        items.map((i) => ({ docId: i.docId, status: "conflict", code: null, error: null })),
      discard: async (docId) => persistence.clear(docId),
    });
    const out = await h.p.run();

    expect(out.conflicts).toEqual(["n"]);
    expect(h.pushed).toEqual([]); // nothing was applied, so nothing is claimed
    expect(persistence.has("n")).toBe(false); // the seed is gone…
    expect(fs.get("n.md")).toBe(SAME); // …and the FILE is untouched

    const { bridge, duringPull } = await followUp(io, "n", "n.md", serverUpdate);
    // Not doubled at ANY point — the doc was empty when the server's copy landed.
    expect(duringPull).toEqual([SAME]);
    // …and not lost.
    expect(text(bridge)).toBe(SAME);
  });

  it("…which is exactly what a surviving seed would have doubled", async () => {
    // The same scenario with no `discardLocalCrdt`: the seed stays in the local
    // CRDT, the pull merges a second insert history, and the doc transiently
    // holds the note TWICE. (Diff-ingest converges it afterwards, but the
    // doubled ops are already live — that is the 68 MB incident's shape.)
    const SAME = "the note everyone already has";
    const { io, fs } = harness({ "n.md": SAME });
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, SAME);

    const h = pusher(io, [{ docId: "n", relPath: "n.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
      answer: (items) =>
        items.map((i) => ({ docId: i.docId, status: "conflict", code: null, error: null })),
      // no discard
    });
    await h.p.run();

    const { duringPull } = await followUp(io, "n", "n.md", Y.encodeStateAsUpdate(serverDoc));
    expect(duringPull[0]).toHaveLength(SAME.length * 2);
  });
});

describe("packing", () => {
  it("never sends more than BATCH_MAX_DOCS in one request", async () => {
    const { io, fs } = harness(
      Object.fromEntries(
        Array.from({ length: BATCH_MAX_DOCS + 30 }, (_, i) => [`n${i}.md`, `note ${i}`]),
      ),
    );
    const work: DocPushWork[] = Array.from({ length: BATCH_MAX_DOCS + 30 }, (_, i) => ({
      docId: `n${i}`,
      relPath: `n${i}.md`,
      serverEmpty: true,
    }));
    const h = pusher(io, work, { readFile: (p) => fs.readFile(p) });
    const out = await h.p.run();

    expect(out.requests).toBeGreaterThan(1);
    for (const req of h.requests) expect(req.length).toBeLessThanOrEqual(BATCH_MAX_DOCS);
    expect(h.requests.flat()).toHaveLength(BATCH_MAX_DOCS + 30);
  });

  it("splits by BYTES as well as by count", async () => {
    // Five docs of ~900 KiB of state each: every one is under the per-item
    // ceiling, and five of them are over the 4 MiB decoded budget for ONE
    // request — so the packer has to split on bytes, well below 100 items.
    const big = "y".repeat(900 * 1024);
    const ids = ["a", "b", "c", "d", "e"];
    const { io, fs } = harness(Object.fromEntries(ids.map((id) => [`${id}.md`, big])));
    const work: DocPushWork[] = ids.map((id) => ({
      docId: id,
      relPath: `${id}.md`,
      serverEmpty: true,
    }));
    const h = pusher(io, work, { readFile: (p) => fs.readFile(p) });
    await h.p.run();

    for (const req of h.requests) {
      const bytes = req.reduce((n, i) => n + Math.floor((i.update.length * 3) / 4), 0);
      expect(bytes).toBeLessThanOrEqual(BATCH_MAX_DECODED_BYTES);
    }
    expect(h.requests.length).toBeGreaterThan(1);
  });

  it("routes an item over BULK_ITEM_MAX_BYTES to the per-doc path instead", async () => {
    const huge = "z".repeat(BULK_ITEM_MAX_BYTES + 1024);
    const { io, fs } = harness({ "big.md": huge, "small.md": "small" });
    const h = pusher(
      io,
      [
        { docId: "big", relPath: "big.md", serverEmpty: true },
        { docId: "small", relPath: "small.md", serverEmpty: true },
      ],
      { readFile: (p) => fs.readFile(p) },
    );
    const out = await h.p.run();

    expect(out.oversized.map((o) => o.docId)).toEqual(["big"]);
    // …and it was NOT seeded on the way out: the per-doc path pulls first.
    expect(h.requests.flat().map((i) => i.docId)).toEqual(["small"]);
  });
});

describe("failures", () => {
  it("records `denied` as PERMANENT and never retries it", async () => {
    const { io, fs } = harness({ "a.md": "file text" });
    const h = pusher(io, [{ docId: "a", relPath: "a.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
      answer: (items) =>
        items.map((i) => ({
          docId: i.docId,
          status: "denied",
          code: "no_edit_permission",
          error: null,
        })),
    });
    const out = await h.p.run();

    expect(h.requests).toHaveLength(1); // one attempt, not three
    expect(out.failures[0]).toMatchObject({ docId: "a", permanent: true });
    expect(h.pushed).toEqual([]);
  });

  it("keeps going after a failed chunk — no streak abort", async () => {
    const count = BATCH_MAX_DOCS + 5;
    const { io, fs } = harness(
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`n${i}.md`, `note ${i}`])),
    );
    const work: DocPushWork[] = Array.from({ length: count }, (_, i) => ({
      docId: `n${i}`,
      relPath: `n${i}.md`,
      serverEmpty: true,
    }));
    let calls = 0;
    const h = pusher(io, work, {
      readFile: (p) => fs.readFile(p),
      fail: () => {
        calls++;
        if (calls <= 3) throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    const out = await h.p.run();

    // The first chunk exhausted its retries and failed EVERY note in it…
    expect(out.failures.length).toBeGreaterThan(0);
    // …and the run still sent the rest (the old streak limit would have stopped).
    expect(out.pushed).toBeGreaterThan(0);
    for (const f of out.failures) expect(f.permanent).toBeUndefined();
  });

  it("reports a doc the server answered nothing for", async () => {
    const { io, fs } = harness({ "a.md": "x", "b.md": "y" });
    const h = pusher(
      io,
      [
        { docId: "a", relPath: "a.md", serverEmpty: true },
        { docId: "b", relPath: "b.md", serverEmpty: true },
      ],
      {
        readFile: (p) => fs.readFile(p),
        answer: (items) =>
          items
            .slice(0, 1)
            .map((i) => ({ docId: i.docId, status: "applied" as const, code: null, error: null })),
      },
    );
    const out = await h.p.run();
    expect(out.failures.map((f) => f.docId)).toEqual(["b"]);
    expect(h.pushed).toEqual(["a"]);
  });

  it("refuses a doc over the note-size ceiling, permanently and without a socket", async () => {
    const huge = "q".repeat(11 * 1024 * 1024);
    const { io, fs } = harness({ "big.md": huge });
    const h = pusher(io, [{ docId: "big", relPath: "big.md", serverEmpty: true }], {
      readFile: (p) => fs.readFile(p),
    });
    const out = await h.p.run();
    expect(h.requests).toHaveLength(0);
    expect(out.failures[0]).toMatchObject({ docId: "big", permanent: true });
  });
});
