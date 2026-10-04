// Only the user's own change marks a note as edited: a file ingest on open, a
// persistence replay or a peer's update must not, or a read-only note's stale
// ops would be announced as "your edit was not accepted" on every open.

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { hasLocalEdit, resetLocalEdits } from "../localEdits";
import { makeHarness } from "./helpers";

describe("local edit tracking", () => {
  beforeEach(() => resetLocalEdits());

  it("open + seed from file + remote update leave the note unedited; typing marks it", async () => {
    const { io } = makeHarness({ "n.md": "from disk\n" });
    const bridge = await NoteBridge.open(io, { docId: "d1", path: "n.md" });
    const peer = new Y.Doc();
    peer.getText("content").insert(0, "teammate ");
    bridge.applyRemote(Y.encodeStateAsUpdate(peer));
    expect(hasLocalEdit("d1")).toBe(false);

    // y-codemirror's binding transacts with an object origin.
    bridge.doc.transact(() => bridge.text.insert(0, "x"), {});
    expect(hasLocalEdit("d1")).toBe(true);
  });

  it("the editor origin and undo count as edits", async () => {
    const { io } = makeHarness({ "n.md": "a\n" });
    const bridge = await NoteBridge.open(io, { docId: "d2", path: "n.md" });
    bridge.edit((t) => t.insert(0, "b"));
    expect(hasLocalEdit("d2")).toBe(true);
  });
});
