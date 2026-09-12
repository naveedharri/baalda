// The ingest-side twin of the seed-vs-pull race (doubling.test.ts).
//
// `seedFromFileIfEmpty` and `hydrate` both re-assert emptiness INSIDE the
// transaction, so neither can seed on top of a pull any more. `drainIngest` had
// the same shape and none of that protection:
//
//   • against an EMPTY doc its diff is the whole file inserted — a seed by
//     another name, and one that runs outside the pull-then-seed order;
//   • the recovery snapshot a whole-file diff always takes is an `await`
//     between reading the doc and applying the diff computed from it;
//   • nothing serialized two passes, so the debounced watcher drain and the
//     sync layer's `ingestNow` could each apply their own copy.
//
// All three are live callers, not theory: `docSession.handleLocalFileChanged`
// ingests any resident bridge the watcher names, including one whose first pull
// has not landed yet, and it does so while the uploader is working the same doc.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";
import { ORIGIN_REMOTE, type BridgeIO, type CrdtPersistence } from "../types";

const PATH = "Map of Content.md";
const FILE_TEXT = "---\ntype: moc\n---\n\n## Map of Content\n\n- [[One]]\n- [[Two]]\n";
const SERVER_TEXT = "---\ntype: moc\n---\n\n## Map of Content\n\n- [[One]]\n- [[Two]]\n";

function applyRemote(bridge: NoteBridge, text: string): void {
  const remote = new Y.Doc();
  remote.getText("content").insert(0, text);
  Y.applyUpdate(bridge.doc, Y.encodeStateAsUpdate(remote), ORIGIN_REMOTE);
}

describe("note-doubling: ingest vs. pull", () => {
  it("refuses to seed an unpulled doc from disk, and leaves the seed to the ordered path", async () => {
    const { io, fs } = makeHarness({ [PATH]: "# placeholder\n" });
    const bridge = await NoteBridge.open(io, {
      docId: "doc-1",
      path: PATH,
      seedFromFile: false, // signed in: this doc waits for the pull
    });
    expect(bridge.serialize()).toBe("");

    // The file gains its real content while the doc is still empty and unpulled
    // — an external writer, or the folder arriving from another device.
    fs.externalWrite(PATH, FILE_TEXT);
    expect(await bridge.ingestNow()).toBe(false);
    expect(bridge.serialize()).toBe("");

    // The pull lands; the ordered seed hook then finds the doc populated and
    // does nothing. One copy of the note, not two.
    applyRemote(bridge, SERVER_TEXT);
    expect(await bridge.seedFromFileIfEmpty()).toBe(false);
    expect(bridge.serialize()).toBe(SERVER_TEXT);
  });

  it("does not apply a diff computed before the recovery snapshot let a remote in", async () => {
    const { io, fs, persistence } = makeHarness({ [PATH]: "# one\n" });
    const bridge = await NoteBridge.open(io, {
      docId: "doc-2",
      path: PATH,
      seedFromFile: true, // local vault: seeded on open, so the doc holds text
    });
    expect(bridge.serialize()).toBe("# one\n");

    // A whole-file rewrite (an AI editing the vault folder): ratio > 0.6, so a
    // recovery snapshot is taken first — and the server's update lands in that
    // await, moving the doc out from under the diff already computed.
    fs.externalWrite(PATH, FILE_TEXT);
    let landed = false;
    const racing: CrdtPersistence = {
      loadState: (id) => persistence.loadState(id),
      appendUpdate: (id, u) => persistence.appendUpdate(id, u),
      saveSnapshot: async (id, s, v) => {
        await persistence.saveSnapshot(id, s, v);
        if (!landed) {
          landed = true;
          applyRemote(bridge, SERVER_TEXT);
        }
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).io = { ...io, persistence: racing } as BridgeIO;

    await bridge.ingestNow();

    // The file is what ingest is merging in, so the file's text is the answer —
    // once, re-diffed against the doc as the remote left it.
    expect(bridge.serialize()).toBe(FILE_TEXT);
  });

  it("does not double when two ingests of a whole-file rewrite overlap", async () => {
    const { io, fs } = makeHarness({ [PATH]: "# one\n" });
    const bridge = await NoteBridge.open(io, {
      docId: "doc-3",
      path: PATH,
      seedFromFile: true,
    });
    fs.externalWrite(PATH, FILE_TEXT);

    // The debounced watcher drain and the sync layer's `ingestNow` ask for the
    // same merge at once.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const slow: BridgeIO = {
      ...io,
      readFile: async (p) => {
        const text = await fs.readFile(p);
        if (first) {
          first = false;
          await held; // hold pass #1 inside its read
        }
        return text;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).io = slow;

    const a = bridge.ingestNow();
    const b = bridge.ingestNow();
    release!();
    await Promise.all([a, b]);

    expect(bridge.serialize()).toBe(FILE_TEXT);
  });
});
