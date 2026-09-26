import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { mergeSv, svCovers, svFromBase64, svIsEmpty, svToBase64, unseenWork } from "../ackedSv";

function docWith(text: string, clientID?: number): Y.Doc {
  const d = new Y.Doc();
  if (clientID !== undefined) d.clientID = clientID;
  d.getText("content").insert(0, text);
  return d;
}

describe("ackedSv", () => {
  it("a stale device (no ops since the ack) has no unseen work", () => {
    const d = docWith("hello");
    const acked = Y.encodeStateVector(d);
    expect(unseenWork({ localSv: Y.encodeStateVector(d), ackedSv: acked })).toBe(false);
  });

  it("an offline edit after the ack is unseen work", () => {
    const d = docWith("hello");
    const acked = Y.encodeStateVector(d);
    d.getText("content").insert(5, " world");
    expect(unseenWork({ localSv: Y.encodeStateVector(d), ackedSv: acked })).toBe(true);
  });

  it("a remote op the server holds but we lack is NOT unseen work", () => {
    const local = docWith("a", 1);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local));
    server.clientID = 2;
    server.getText("content").insert(1, "b");
    expect(unseenWork({ localSv: Y.encodeStateVector(local), ackedSv: Y.encodeStateVector(server) })).toBe(false);
  });

  it("a local CRDT with ops and no ack at all is unseen work", () => {
    expect(unseenWork({ localSv: Y.encodeStateVector(docWith("x")), ackedSv: null })).toBe(true);
  });

  it("no CRDT: falls back to file hash vs disk base", () => {
    expect(unseenWork({ localSv: null, ackedSv: null, fileHash: null })).toBe(false);
    expect(unseenWork({ localSv: null, ackedSv: null, fileHash: "h1", diskBase: "h1" })).toBe(false);
    expect(unseenWork({ localSv: null, ackedSv: null, fileHash: "h2", diskBase: "h1" })).toBe(true);
    expect(unseenWork({ localSv: null, ackedSv: null, fileHash: "h2", diskBase: null })).toBe(true);
  });

  it("merge takes the per-client max and round-trips base64", () => {
    const a = docWith("aa", 10);
    const b = docWith("bbb", 20);
    const merged = mergeSv(Y.encodeStateVector(a), Y.encodeStateVector(b));
    expect(svCovers(merged, Y.encodeStateVector(a))).toBe(true);
    expect(svCovers(merged, Y.encodeStateVector(b))).toBe(true);
    const rt = svFromBase64(svToBase64(merged))!;
    expect(Y.decodeStateVector(rt)).toEqual(Y.decodeStateVector(merged));
    expect(svIsEmpty(Y.encodeStateVector(new Y.Doc()))).toBe(true);
    expect(svIsEmpty(merged)).toBe(false);
  });
});
