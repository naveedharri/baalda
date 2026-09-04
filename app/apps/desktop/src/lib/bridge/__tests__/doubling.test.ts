// The note-doubling bug (2026-09-04).
//
// `seedFromFileIfEmpty` is the orphan-seed hook for the startup-ordering rule:
// when signed in, the sync layer pulls the server's canonical state FIRST, then
// asks the bridge to seed from disk only if the doc is still empty. The
// emptiness test used to run BEFORE the awaited `readFile`, and the insert AFTER
// it — so a pull landing inside that window seeded a second insert history on
// top of the server's text.
//
// Yjs merges two independent histories by keeping BOTH, so the note came back
// holding the server's version *and* the file's, and every repeat of the race
// doubled it again. In the vault that exposed this, a daily note had reached
// 68 MB — 2,374,523 lines of 35 distinct lines, two interleaved versions at
// ~43,000 copies each. Downstream, `parse_note` found ~86,370 wikilinks in it,
// `links` reached 2,025,307 rows, and index.sqlite hit 1.27 GB, which made every
// index pass hold the index mutex for tens of seconds and froze the sidebar.
//
// The fix re-asserts emptiness INSIDE the transaction. These tests pin both
// halves: the race must not double, and a genuine orphan must still seed.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness, sha256Hex } from "./helpers";
import { ORIGIN_REMOTE, type BridgeIO } from "../types";

const PATH = "Daily/2026-08-10.md";
const FILE_TEXT = "---\ntype: daily-note\nmeetings: 1\n---\n\n## Busy Monday\n";
const SERVER_TEXT = "---\ntype: daily-note\nmeetings: 8\n---\n\n## Quiet Monday\n";

describe("note-doubling: seed vs. pull", () => {
  it("does not seed on top of server state that lands during the file read", async () => {
    const { io, persistence, fs } = makeHarness({ [PATH]: FILE_TEXT });

    // Open the signed-in way: no seed on open, so the doc waits for the pull.
    const bridge = await NoteBridge.open(io, {
      docId: "doc-1",
      path: PATH,
      seedFromFile: false,
    });
    expect(bridge.serialize()).toBe("");

    // Race the pull into the seed's `await readFile` — exactly the window the
    // bug lived in. Wrapping the harness's readFile is the only timing control
    // needed: the remote update is applied while the seed is suspended on it.
    const racing: BridgeIO = {
      ...io,
      readFile: async (p) => {
        const text = await fs.readFile(p);
        // The server's canonical state arrives, as a remote update would.
        const remote = new Y.Doc();
        remote.getText("content").insert(0, SERVER_TEXT);
        Y.applyUpdate(bridge.doc, Y.encodeStateAsUpdate(remote), ORIGIN_REMOTE);
        return text;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).io = racing;

    const seeded = await bridge.seedFromFileIfEmpty();

    // The pull won: the doc is the server's text, NOT both texts concatenated.
    expect(seeded).toBe(false);
    expect(bridge.serialize()).toBe(SERVER_TEXT);
    expect(bridge.serialize()).not.toContain("Busy Monday");
    // The clincher — the shape the 68 MB file had:
    expect(bridge.serialize().length).toBeLessThan(
      FILE_TEXT.length + SERVER_TEXT.length,
    );
    expect(persistence).toBeDefined();
  });

  it("still seeds a genuine orphan (no server state arrives)", async () => {
    const { io } = makeHarness({ [PATH]: FILE_TEXT });
    const bridge = await NoteBridge.open(io, {
      docId: "doc-2",
      path: PATH,
      seedFromFile: false,
    });
    expect(bridge.serialize()).toBe("");

    const seeded = await bridge.seedFromFileIfEmpty();

    expect(seeded).toBe(true);
    expect(bridge.serialize()).toBe(FILE_TEXT);
    // Seeding must not schedule a write back to disk (ORIGIN_DISK), or the
    // orphan seed would look like an edit to every other device.
    expect(bridge.lastHash).toBe(sha256Hex(FILE_TEXT));
  });

  it("repeating the race cannot accumulate — the doc stays one version", async () => {
    const { io, fs } = makeHarness({ [PATH]: FILE_TEXT });
    const bridge = await NoteBridge.open(io, {
      docId: "doc-3",
      path: PATH,
      seedFromFile: false,
    });

    const remote = new Y.Doc();
    remote.getText("content").insert(0, SERVER_TEXT);
    Y.applyUpdate(bridge.doc, Y.encodeStateAsUpdate(remote), ORIGIN_REMOTE);

    // Whatever re-triggers the orphan seed — a reconnect, a relaunch, a retry —
    // must be a no-op now that the doc holds content. 43,000 of these is what
    // built the 68 MB file.
    for (let i = 0; i < 50; i++) {
      expect(await bridge.seedFromFileIfEmpty()).toBe(false);
    }
    expect(bridge.serialize()).toBe(SERVER_TEXT);
    expect(fs.get(PATH)).toBeDefined();
  });
});
