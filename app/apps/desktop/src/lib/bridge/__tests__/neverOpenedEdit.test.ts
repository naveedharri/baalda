// Offline reconciliation: an external writer (an AI, another editor) edited a
// note this device never opened, so there is no local CRDT to merge against.
// A signed-in open defers to the server's pull, which then decides the doc's
// text — so the file's bytes must be saved aside BEFORE anything can egest
// over them. A file that still equals its disk base is not an edit at all.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness, sha256Hex } from "./helpers";

const PATH = "note.md";

function withRecovery() {
  const h = makeHarness({ [PATH]: "B's external edit\n" });
  const copies: Array<{ path: string; content: string }> = [];
  h.io.saveRecoveryCopy = async (path, content) => {
    copies.push({ path, content });
    return `.context/trash/x/${path}`;
  };
  return { ...h, copies };
}

describe("never-opened external edit", () => {
  it("saves the file aside before the pull can replace it (no disk base)", async () => {
    const { io, fs, copies } = withRecovery();
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(copies).toEqual([{ path: PATH, content: "B's external edit\n" }]);

    // The server's text lands and is written out: the edit survives in the copy.
    const server = new Y.Doc();
    server.getText("content").insert(0, "the team's text\n");
    bridge.applyRemote(Y.encodeStateAsUpdate(server));
    await bridge.flushEgest();
    expect(fs.get(PATH)).toBe("the team's text\n");
    expect(copies[0].content).toBe("B's external edit\n");
    bridge.destroy();
  });

  it("saves the file aside when it moved on from its disk base", async () => {
    const { io, persistence, copies } = withRecovery();
    persistence.diskBases.set("d1", sha256Hex("what this device last synced\n"));
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
    expect(copies).toHaveLength(1);
    bridge.destroy();
  });

  it("takes no copy when the file still equals its disk base", async () => {
    const { io, persistence, copies } = withRecovery();
    persistence.diskBases.set("d1", sha256Hex("B's external edit\n"));
    const bridge = await NoteBridge.open(io, { docId: "d1", path: PATH, seedFromFile: false });
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
