// The mirror image of the racing-ingest rule "never re-diff older file bytes
// against newly arrived peer content": after a pull, never diff a file that
// ALREADY holds the peer's content against the pre-pull base that lacks it.
//
// A read-only socket drops this device's ops, so the live doc can carry a
// local op the server never took while the file holds the server's text
// (written by the read-only rebase, a cold apply or a bootstrap). The
// pre-pull → file diff then re-inserted every peer insertion under this
// device's client id, and each later pull added another copy.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "Operator notes.md";
const BASE = "---\ntype: notes\n---\n\n- identity\n- AI-Native\n";

async function setup(docId: string) {
  const h = makeHarness({ [PATH]: BASE });
  const bridge = await NoteBridge.open(h.io, { docId, path: PATH, seedFromFile: true });
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(bridge.doc));
  // A local op the server never accepted (dropped on a read-only socket).
  bridge.doc.getText("content").insert(BASE.length, "- local\n");
  return { ...h, bridge, server };
}

function peerInsert(server: Y.Doc, at: number, text: string): Uint8Array {
  const sv = Y.encodeStateVector(server);
  server.getText("content").insert(at, text);
  return Y.encodeStateAsUpdate(server, sv);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("post-pull reconcile: file already holds the peer's text", () => {
  it("does not re-insert the peer's line, and the file ends equal to the doc", async () => {
    const { bridge, server, fs } = await setup("doc-pp-1");
    const update = peerInsert(server, BASE.indexOf("- AI"), "- peer line\n");
    fs.externalWrite(PATH, server.getText("content").toString());

    bridge.beginPull();
    bridge.applyRemote(update);
    await bridge.reconcileAfterPull();
    await bridge.flushEgest();

    const out = bridge.serialize();
    expect(count(out, "- peer line")).toBe(1);
    expect(fs.get(PATH)).toBe(out);
  });

  it("still ingests a genuine new external edit exactly once beside the server text", async () => {
    const { bridge, server, fs } = await setup("doc-pp-2");
    const update = peerInsert(server, BASE.indexOf("- AI"), "- peer line\n");
    // The file holds the server's text AND an edit made outside the app.
    fs.externalWrite(PATH, server.getText("content").toString() + "- external edit\n");

    bridge.beginPull();
    bridge.applyRemote(update);
    await bridge.reconcileAfterPull();
    await bridge.flushEgest();

    const out = bridge.serialize();
    expect(count(out, "- peer line")).toBe(1);
    expect(count(out, "- external edit")).toBe(1);
    expect(fs.get(PATH)).toBe(out);
  });
});
