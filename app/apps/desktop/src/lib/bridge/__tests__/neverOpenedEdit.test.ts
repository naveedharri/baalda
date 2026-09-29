// Offline reconciliation: an external writer (an AI, another editor) edited a
// note this device never opened, so there is no local CRDT to merge against.
// A signed-in open defers to the server's pull, which then decides the doc's
// text. The file's bytes must be saved aside before an egest replaces them —
// but ONLY when they really differ from what gets written. A vault whose notes
// have no disk base yet (every vault from before the base existed) must not
// copy a single note on an ordinary launch.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness, sha256Hex } from "./helpers";

const PATH = "note.md";

function withRecovery(fileText = "B's external edit\n") {
  const h = makeHarness({ [PATH]: fileText });
  const copies: Array<{ path: string; content: string }> = [];
  h.io.saveRecoveryCopy = async (path, content) => {
    copies.push({ path, content });
    return `.context/trash/x/${path}`;
  };
  return { ...h, copies };
}

function serverUpdate(text: string): Uint8Array {
  const server = new Y.Doc();
  server.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(server);
}

describe("never-opened external edit", () => {
  it("no base, file equals the server's text: no copy (the ordinary launch)", async () => {
    const { io, fs, copies } = withRecovery("the team's text\n");
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(copies).toEqual([]); // nothing at open
    bridge.applyRemote(serverUpdate("the team's text\n"));
    await bridge.flushEgest();
    expect(copies).toEqual([]);
    expect(fs.get(PATH)).toBe("the team's text\n");
    // …and a later edit of the user's own is not mistaken for that case.
    bridge.text.insert(bridge.text.length, "more\n");
    await bridge.flushEgest();
    expect(copies).toEqual([]);
    bridge.destroy();
  });

  it("no base, file differs from the server's text: copy before the egest replaces it", async () => {
    const { io, fs, copies } = withRecovery();
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(copies).toEqual([]); // not at open: no base is not evidence
    bridge.applyRemote(serverUpdate("the team's text\n"));
    await bridge.flushEgest();
    expect(copies).toEqual([{ path: PATH, content: "B's external edit\n" }]);
    expect(fs.get(PATH)).toBe("the team's text\n");
    // Once only.
    bridge.text.insert(0, "x");
    await bridge.flushEgest();
    expect(copies).toHaveLength(1);
    bridge.destroy();
  });

  it("no base, the server was empty and the orphan seed took the file in: no copy", async () => {
    const { io, copies } = withRecovery();
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(await bridge.seedFromFileIfEmpty()).toBe(true);
    await bridge.flushEgest();
    expect(copies).toEqual([]);
    bridge.destroy();
  });

  it("saves the file aside at open when it moved on from its disk base", async () => {
    const { io, persistence, copies } = withRecovery();
    persistence.diskBases.set("d1", sha256Hex("what this device last synced\n"));
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(copies).toEqual([{ path: PATH, content: "B's external edit\n" }]);
    bridge.destroy();
  });

  it("takes no copy when the file still equals its disk base", async () => {
    const { io, persistence, copies } = withRecovery();
    persistence.diskBases.set("d1", sha256Hex("B's external edit\n"));
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    bridge.applyRemote(serverUpdate("B's external edit\n"));
    await bridge.flushEgest();
    expect(copies).toEqual([]);
    bridge.destroy();
  });

  it("takes no copy on a local-only vault, which seeds from the file instead", async () => {
    const { io, copies } = withRecovery();
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: true });
    expect(copies).toEqual([]);
    expect(bridge.serialize()).toBe("B's external edit\n");
    bridge.destroy();
  });
});
