// A read-only note whose local CRDT is EMPTY (access revoked then re-granted:
// the CRDT was dropped, the file came back with the server's text) must never
// lose that file to the read-only write-back, and must still converge once
// the server's state arrives. A read-only doc that DOES hold text keeps the
// quiet-copy path; an editable doc is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { markReadOnlyDoc, resetReadOnlyDocs, setReadOnlyCopyKeeper } from "../readOnlyDocs";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const TEXT = "# Plan\n\nThe team's text, delivered with the regrant.\n";

function serverUpdate(text: string): Uint8Array {
  const server = new Y.Doc();
  server.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(server);
}

afterEach(() => resetReadOnlyDocs());

describe("read-only doc with an empty local CRDT", () => {
  it("never writes the empty doc over the file, and converges on the server's text", async () => {
    const h = makeHarness({ [PATH]: TEXT });
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, t) => {
      kept.push(t);
      return true;
    });
    markReadOnlyDoc("d1", true);
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    // The watcher names the file (its arrival): the ingest must not clobber it.
    await bridge.ingestNow();
    await bridge.flushEgest();
    expect(h.fs.get(PATH)).toBe(TEXT);
    expect(kept).toEqual([]); // the file is not a stray edit
    // The server's state lands: same text, no rewrite, no doubling.
    bridge.applyRemote(serverUpdate(TEXT));
    await bridge.flushEgest();
    expect(bridge.text.toString()).toBe(TEXT);
    expect(h.fs.get(PATH)).toBe(TEXT);
    bridge.destroy();
  });

  it("a file filled in after the open (placeholder, then content) is never clobbered", async () => {
    const h = makeHarness({ [PATH]: "" });
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, t) => {
      kept.push(t);
      return true;
    });
    markReadOnlyDoc("d1", true);
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    h.fs.externalWrite(PATH, TEXT); // the content arrives on disk
    await bridge.ingestNow();
    await bridge.flushEgest();
    expect(h.fs.get(PATH)).toBe(TEXT);
    expect(kept).toEqual([]);
    bridge.applyRemote(serverUpdate(TEXT));
    await bridge.flushEgest();
    expect(bridge.text.toString()).toBe(TEXT);
    expect(h.fs.get(PATH)).toBe(TEXT);
    bridge.destroy();
  });

  it("a doc emptied this session never writes its emptiness over a delivered file", async () => {
    const h = makeHarness({ [PATH]: "old" });
    await h.persistence.saveSnapshot("d1", serverUpdate("old"), new Uint8Array());
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, t) => {
      kept.push(t);
      return true;
    });
    markReadOnlyDoc("d1", true);
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    bridge.abandonPull(true);
    // A remote clear (the doc had content: everHadContent is set).
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(bridge.doc));
    peer.getText("content").delete(0, peer.getText("content").length);
    bridge.applyRemote(Y.encodeStateAsUpdate(peer, Y.encodeStateVector(bridge.doc)));
    await bridge.flushEgest();
    h.fs.externalWrite(PATH, TEXT);
    await bridge.ingestNow();
    await bridge.flushEgest();
    expect(h.fs.get(PATH)).toBe(TEXT);
    bridge.destroy();
  });

  it("a regrant delivered with its state opens with text at once", async () => {
    const h = makeHarness({ [PATH]: TEXT });
    // What apply_bootstrap_batch persists beside the file: the full snapshot.
    const update = serverUpdate(TEXT);
    await h.persistence.saveSnapshot("d1", update, Y.encodeStateVector(new Y.Doc()));
    markReadOnlyDoc("d1", true);
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(bridge.text.toString()).toBe(TEXT);
    await bridge.ingestNow();
    await bridge.flushEgest();
    expect(h.fs.get(PATH)).toBe(TEXT);
    bridge.destroy();
  });
});

describe("read-only doc that holds text", () => {
  it("a differing file goes to the quiet copy and is never ingested", async () => {
    const h = makeHarness({ [PATH]: TEXT });
    await h.persistence.saveSnapshot("d1", serverUpdate(TEXT), new Uint8Array());
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, t) => {
      kept.push(t);
      return true;
    });
    markReadOnlyDoc("d1", true);
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    bridge.abandonPull(true);
    h.fs.externalWrite(PATH, TEXT + "a stray local edit\n");
    await bridge.ingestNow();
    await bridge.flushEgest();
    expect(kept).toEqual([TEXT + "a stray local edit\n"]);
    expect(bridge.text.toString()).toBe(TEXT);
    expect(h.fs.get(PATH)).toBe(TEXT);
    bridge.destroy();
  });
});

describe("editable doc", () => {
  it("still diff-merges a differing file", async () => {
    const h = makeHarness({ [PATH]: TEXT });
    await h.persistence.saveSnapshot("d1", serverUpdate(TEXT), new Uint8Array());
    const bridge = await NoteBridge.open(h.io, { docId: "d1", path: PATH, seedFromFile: false });
    bridge.abandonPull(true);
    h.fs.externalWrite(PATH, TEXT + "an edit\n");
    await bridge.ingestNow();
    expect(bridge.text.toString()).toBe(TEXT + "an edit\n");
    bridge.destroy();
  });
});
