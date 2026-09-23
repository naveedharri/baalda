// #200 — a signed-in bridge must not merge its file before the first server
// pull, and a file that is merely BEHIND its doc must never be diffed in.
//
// The repro that opened the issue: a local CRDT at `Price: 97`, a file at
// `Price: 127` (a teammate's edit that reached this disk on an earlier launch)
// and the server holding the teammate's edit. Hydrate used to arm a 150 ms
// ingest that fired before the provider's first sync, so this device inserted
// `12` under its OWN client id, the pull then delivered the teammate's `12`,
// and the note read `Price: 12127` — gaining the digits again on every round.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness, sha256Hex } from "./helpers";
import { ORIGIN_REMOTE } from "../types";

const PATH = "n.md";
const DOC = "d";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server history: `base` by one client, then a peer's edit on top of it. */
function serverWithPeerEdit(
  base: string,
  edit: (t: Y.Text) => void,
): { server: Y.Doc; base: Uint8Array } {
  const server = new Y.Doc();
  server.getText("content").insert(0, base);
  const baseUpdate = Y.encodeStateAsUpdate(server);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, baseUpdate);
  edit(peer.getText("content"));
  Y.applyUpdate(server, Y.encodeStateAsUpdate(peer));
  return { server, base: baseUpdate };
}

/** The provider's first sync: everything the server has that we don't. */
function pull(bridge: NoteBridge, server: Y.Doc): void {
  const delta = Y.encodeStateAsUpdate(server, Y.encodeStateVector(bridge.doc));
  Y.applyUpdate(bridge.doc, delta, ORIGIN_REMOTE);
}

describe("hot open: pull before merge", () => {
  it("does not re-insert a server edit the file already holds (97 → 127, never 12127)", async () => {
    const { server, base } = serverWithPeerEdit("Price: 97\n", (t) => {
      t.delete(7, 1);
      t.insert(7, "12");
    });
    expect(server.getText("content").toString()).toBe("Price: 127\n");

    const { io, fs, persistence } = makeHarness({ [PATH]: "Price: 127\n" });
    await persistence.appendUpdate(DOC, base);
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });
    expect(b.awaitingPull).toBe(true);

    // Past the ingest debounce: nothing was merged before the pull.
    await sleep(200);
    expect(b.serialize()).toBe("Price: 97\n");

    pull(b, server);
    expect(await b.reconcileAfterPull()).toBe(false);
    expect(b.serialize()).toBe("Price: 127\n");
    await sleep(400);
    expect(fs.get(PATH)).toBe("Price: 127\n");
    b.destroy();
  });

  it("merges an edit made outside the app while closed, against the pre-pull doc", async () => {
    const { server, base } = serverWithPeerEdit("A\nB\n", (t) => t.insert(0, "S\n"));
    const { io, fs, persistence } = makeHarness({ [PATH]: "A\nB\nC from the AI\n" });
    await persistence.appendUpdate(DOC, base);
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });

    pull(b, server);
    expect(await b.reconcileAfterPull()).toBe(true);
    expect(b.serialize()).toBe("S\nA\nB\nC from the AI\n");
    await sleep(400);
    expect(fs.get(PATH)).toBe("S\nA\nB\nC from the AI\n");
    b.destroy();
  });

  it("writes the pulled state out when the file was merely behind", async () => {
    const { server, base } = serverWithPeerEdit("x\n", (t) => t.insert(2, "y\n"));
    const { io, fs, persistence } = makeHarness({ [PATH]: "x\n" });
    await persistence.appendUpdate(DOC, base);
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });

    pull(b, server);
    // The pull's egest is held until the file has been looked at…
    await sleep(400);
    expect(fs.get(PATH)).toBe("x\n");
    // …and then it is a write, not a merge.
    expect(await b.reconcileAfterPull()).toBe(false);
    await sleep(400);
    expect(b.serialize()).toBe("x\ny\n");
    expect(fs.get(PATH)).toBe("x\ny\n");
    b.destroy();
  });

  it("a watcher event while waiting only marks the file dirty", async () => {
    const { server, base } = serverWithPeerEdit("one\n", (t) => t.insert(4, "two\n"));
    const { io, fs, persistence } = makeHarness({ [PATH]: "one\n" });
    await persistence.appendUpdate(DOC, base);
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });

    fs.externalWrite(PATH, "zero\none\n");
    b.ingest();
    await sleep(200);
    expect(b.serialize()).toBe("one\n");

    pull(b, server);
    expect(await b.reconcileAfterPull()).toBe(true);
    expect(b.serialize()).toBe("zero\none\ntwo\n");
    b.destroy();
  });

  it("ends the wait by itself if nobody reconciles (offline, a forgotten caller)", async () => {
    const d = new Y.Doc();
    d.getText("content").insert(0, "local\n");
    const { io, persistence, fs } = makeHarness({ [PATH]: "local\nedited outside\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    const b = await NoteBridge.open(io, {
      docId: DOC,
      path: PATH,
      seedFromFile: false,
      config: { pullReconcileTimeoutMs: 50 },
    });
    expect(b.awaitingPull).toBe(true);
    await sleep(150);
    expect(b.awaitingPull).toBe(false);
    expect(b.serialize()).toBe("local\nedited outside\n");
    expect(fs.get(PATH)).toBe("local\nedited outside\n");
    b.destroy();
  });

  it("flushing a deferred write on close reconciles first", async () => {
    const { server, base } = serverWithPeerEdit("p\n", (t) => t.insert(2, "q\n"));
    const { io, fs, persistence } = makeHarness({ [PATH]: "p\n" });
    await persistence.appendUpdate(DOC, base);
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });
    pull(b, server);
    await b.flushEgest();
    expect(b.awaitingPull).toBe(false);
    expect(fs.get(PATH)).toBe("p\nq\n");
    b.destroy();
  });

  it("a local-only bridge still reconciles its file at open, as before", async () => {
    const d = new Y.Doc();
    d.getText("content").insert(0, "mine\n");
    const { io, persistence } = makeHarness({ [PATH]: "mine\nfrom obsidian\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH });
    expect(b.awaitingPull).toBe(false);
    await sleep(200);
    expect(b.serialize()).toBe("mine\nfrom obsidian\n");
    b.destroy();
  });
});

describe("disk base: a file behind its doc is written, never diffed", () => {
  const FULL = "A\nB peer-added paragraph\nC\n";

  it("a stale non-empty file does not delete the doc's newer text (local vault)", async () => {
    // The last egest wrote "A\n"; the doc then gained B and C, and the write
    // that would have carried them never landed (quit inside the debounce).
    const d = new Y.Doc();
    d.getText("content").insert(0, FULL);
    const { io, fs, persistence } = makeHarness({ [PATH]: "A\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    persistence.diskBases.set(DOC, sha256Hex("A\n"));

    const b = await NoteBridge.open(io, { docId: DOC, path: PATH });
    await sleep(600);
    expect(b.serialize()).toBe(FULL);
    expect(fs.get(PATH)).toBe(FULL);
    expect(persistence.diskBases.get(DOC)).toBe(sha256Hex(FULL));
    b.destroy();
  });

  it("the same stale file after a pull is written out too (signed in)", async () => {
    const d = new Y.Doc();
    d.getText("content").insert(0, FULL);
    const { io, fs, persistence } = makeHarness({ [PATH]: "A\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    persistence.diskBases.set(DOC, sha256Hex("A\n"));

    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });
    expect(await b.reconcileAfterPull()).toBe(false);
    await sleep(400);
    expect(b.serialize()).toBe(FULL);
    expect(fs.get(PATH)).toBe(FULL);
    b.destroy();
  });

  it("a genuine edit (file differs from the disk base) still merges — including emptying most of it", async () => {
    const d = new Y.Doc();
    d.getText("content").insert(0, FULL);
    const { io, fs, persistence } = makeHarness({ [PATH]: FULL });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    persistence.diskBases.set(DOC, sha256Hex(FULL));

    const b = await NoteBridge.open(io, { docId: DOC, path: PATH });
    await sleep(200);
    fs.externalWrite(PATH, "A\n"); // the user deliberately cut it down
    b.ingest();
    await sleep(200);
    expect(b.serialize()).toBe("A\n");
    expect(persistence.diskBases.get(DOC)).toBe(sha256Hex("A\n"));
    b.destroy();
  });

  it("every egest records the written bytes as the disk base", async () => {
    const { io, fs, persistence } = makeHarness({ [PATH]: "" });
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH });
    b.edit((t) => t.insert(0, "typed\n"));
    await sleep(400);
    expect(fs.get(PATH)).toBe("typed\n");
    expect(persistence.diskBases.get(DOC)).toBe(sha256Hex("typed\n"));
    b.destroy();
  });

  it("an ingest records the file it merged", async () => {
    const d = new Y.Doc();
    d.getText("content").insert(0, "one\n");
    const { io, fs, persistence } = makeHarness({ [PATH]: "one\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(d));
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH });
    await sleep(200);
    fs.externalWrite(PATH, "one\ntwo\n");
    expect(await b.ingestNow()).toBe(true);
    expect(persistence.diskBases.get(DOC)).toBe(sha256Hex("one\ntwo\n"));
    b.destroy();
  });
});
