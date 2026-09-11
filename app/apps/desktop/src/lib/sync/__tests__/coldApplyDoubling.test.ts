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
