// A read-only doc whose local CRDT holds ops the server lacks used to re-send
// them on every connect: the server answered `rejected`, Hocuspocus dropped
// them, and they stayed local forever. A rejected doc is now rebased onto the
// server once per session, and the bridge never ingests a read-only doc's file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  READ_ONLY_DETAIL,
  READ_ONLY_TOAST,
  ReadOnlyRejections,
  resetReadOnlyAnnouncements,
  wasRebased,
} from "../readOnlyRejections";
import { reconcileReport } from "../reconcileReport";
import { markLocalEdit, resetLocalEdits } from "../../bridge/localEdits";
import {
  isReadOnlyDoc,
  markReadOnlyDoc,
  resetReadOnlyDocs,
  setReadOnlyCopyKeeper,
} from "../../bridge/readOnlyDocs";
import { NoteBridge } from "../../bridge/noteBridge";
import { makeHarness } from "../../bridge/__tests__/helpers";
import { ORIGIN_REMOTE } from "../../bridge/types";

const PATH = "n.md";
const DOC = "d1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one connect's sync step 2 would carry to the server. */
function wouldSend(local: Y.Doc, server: Y.Doc): boolean {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(server));
  const before = Y.encodeStateVector(probe);
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(local, Y.encodeStateVector(server)));
  const after = Y.encodeStateVector(probe);
  return Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0;
}

/** A device: local CRDT (server state + one stray op) and a file. */
function world(opts: { file?: string; stray?: string; edited?: boolean; open?: () => boolean } = {}) {
  const server = new Y.Doc();
  server.getText("content").insert(0, "server text\n");
  let local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  if (opts.stray !== undefined) local.getText("content").insert(0, opts.stray);
  let file = opts.file ?? local.getText("content").toString();
  const copies: string[] = [];
  const replaceLocal = vi.fn(async (_d: string, _p: string, update: Uint8Array, text: string) => {
    local = new Y.Doc();
    Y.applyUpdate(local, update);
    file = text;
  });
  const serverState = vi.fn(async () => ({
    update: Y.encodeStateAsUpdate(server),
    text: server.getText("content").toString(),
  }));
  const notify = vi.fn();
  const h = new ReadOnlyRejections({
    pathOf: (d) => (d === DOC ? PATH : null),
    localText: async () => local.getText("content").toString(),
    readFile: async () => file,
    writeTrashCopy: async (_p, stamp, content) => {
      copies.push(content);
      return `.context/trash/${stamp}/${PATH}`;
    },
    userEdited: () => opts.edited ?? false,
    notify,
    serverState,
    replaceLocal,
    isOpen: opts.open,
  });
  return {
    h,
    server,
    copies,
    notify,
    replaceLocal,
    serverState,
    local: () => local,
    file: () => file,
  };
}

beforeEach(() => {
  reconcileReport.clear();
  resetReadOnlyAnnouncements();
  resetLocalEdits();
  resetReadOnlyDocs();
});
afterEach(() => resetReadOnlyDocs());

describe("read-only rebase onto the server", () => {
  it("rebases a stray local op once; the file is the server text; a second connect sends nothing", async () => {
    const w = world({ stray: "stale ingest " });
    expect(wouldSend(w.local(), w.server)).toBe(true);
    await w.h.handle(DOC);
    expect(w.replaceLocal).toHaveBeenCalledTimes(1);
    expect(w.file()).toBe("server text\n");
    expect(w.local().getText("content").toString()).toBe("server text\n");
    // The file differed from the server: exactly one quiet copy, no entry, no toast.
    expect(w.copies).toEqual(["stale ingest server text\n"]);
    expect(reconcileReport.items()).toEqual([]);
    expect(w.notify).not.toHaveBeenCalled();
    expect(wasRebased(DOC)).toBe(true);
    expect(isReadOnlyDoc(DOC)).toBe(true);
    // Next connect: nothing the server lacks, so no `rejected` frame — and even
    // a late duplicate frame does nothing.
    expect(wouldSend(w.local(), w.server)).toBe(false);
    expect(await w.h.handle(DOC)).toBe(false);
    expect(w.replaceLocal).toHaveBeenCalledTimes(1);
    expect(w.serverState).toHaveBeenCalledTimes(1);
    expect(w.copies).toHaveLength(1);
  });

  it("keeps no copy when the file already equals the server text", async () => {
    // Stray op in the CRDT only (e.g. history from before the downgrade).
    const w = world({ stray: "old ", file: "server text\n" });
    expect(await w.h.handle(DOC)).toBe(false);
    expect(w.copies).toEqual([]);
    expect(w.replaceLocal).toHaveBeenCalledTimes(1);
    expect(wouldSend(w.local(), w.server)).toBe(false);
  });

  it("a real typed edit: one toast, one Activity entry, one copy, then the rebase", async () => {
    markLocalEdit(DOC);
    const w = world({ stray: "my edit ", edited: true });
    expect(await w.h.handle(DOC)).toBe(true);
    expect(w.copies).toEqual(["my edit server text\n"]);
    expect(w.notify).toHaveBeenCalledExactlyOnceWith(READ_ONLY_TOAST);
    expect(reconcileReport.items()).toEqual([
      expect.objectContaining({ kind: "keptLocally", docId: DOC, detail: READ_ONLY_DETAIL }),
    ]);
    expect(w.file()).toBe("server text\n");
    await w.h.handle(DOC);
    expect(w.copies).toHaveLength(1);
    expect(w.notify).toHaveBeenCalledTimes(1);
  });

  it("the open note: copy at the frame, rebase only when it closes, never a second copy", async () => {
    let open = true;
    const w = world({ stray: "typed ", edited: true, open: () => open });
    expect(await w.h.handle(DOC)).toBe(true);
    expect(w.copies).toHaveLength(1);
    expect(w.replaceLocal).not.toHaveBeenCalled();
    open = false;
    await w.h.closed(DOC);
    expect(w.replaceLocal).toHaveBeenCalledTimes(1);
    expect(w.copies).toHaveLength(1);
    expect(w.file()).toBe("server text\n");
    expect(w.notify).toHaveBeenCalledTimes(1);
  });

  it("a failed copy leaves the file and the CRDT alone", async () => {
    const w = world({ stray: "x " });
    const h = new ReadOnlyRejections({
      pathOf: () => PATH,
      localText: async () => "x server text\n",
      readFile: async () => "x server text\n",
      writeTrashCopy: async () => {
        throw new Error("disk full");
      },
      userEdited: () => false,
      serverState: w.serverState,
      replaceLocal: w.replaceLocal,
    });
    expect(await h.handle(DOC)).toBe(false);
    expect(w.replaceLocal).not.toHaveBeenCalled();
    expect(wasRebased(DOC)).toBe(false);
  });
});

describe("the bridge never ingests a read-only doc's file", () => {
  async function openWithDrift() {
    const server = new Y.Doc();
    server.getText("content").insert(0, "server text\n");
    const { io, fs, persistence } = makeHarness({ [PATH]: "server text\nedited elsewhere\n" });
    await persistence.appendUpdate(DOC, Y.encodeStateAsUpdate(server));
    const b = await NoteBridge.open(io, { docId: DOC, path: PATH, seedFromFile: false });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(b.doc)), ORIGIN_REMOTE);
    return { b, fs, server };
  }

  it("hydrate on open of a read-only doc with a differing file: no ingest, one quiet copy", async () => {
    markReadOnlyDoc(DOC, true);
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, text) => {
      kept.push(text);
      return true;
    });
    const { b, fs, server } = await openWithDrift();
    expect(await b.reconcileAfterPull()).toBe(false);
    expect(b.serialize()).toBe("server text\n");
    expect(wouldSend(b.doc, server)).toBe(false);
    expect(kept).toEqual(["server text\nedited elsewhere\n"]);
    await sleep(400);
    expect(fs.get(PATH)).toBe("server text\n");
    // A later watcher ingest of the same doc creates no op either.
    await b.ingestNow();
    expect(wouldSend(b.doc, server)).toBe(false);
    b.destroy();
  });

  it("a failed quiet copy leaves the file as it is", async () => {
    markReadOnlyDoc(DOC, true);
    setReadOnlyCopyKeeper(async () => false);
    const { b, fs } = await openWithDrift();
    await b.reconcileAfterPull();
    await sleep(400);
    expect(fs.get(PATH)).toBe("server text\nedited elsewhere\n");
    expect(b.serialize()).toBe("server text\n");
    b.destroy();
  });

  it("an editable doc is untouched: the file's edit merges as before", async () => {
    const kept: string[] = [];
    setReadOnlyCopyKeeper(async (_d, _p, text) => {
      kept.push(text);
      return true;
    });
    const { b, fs, server } = await openWithDrift();
    expect(await b.reconcileAfterPull()).toBe(true);
    expect(b.serialize()).toBe("server text\nedited elsewhere\n");
    expect(wouldSend(b.doc, server)).toBe(true);
    expect(kept).toEqual([]);
    await sleep(400);
    expect(fs.get(PATH)).toBe("server text\nedited elsewhere\n");
    b.destroy();
  });

  it("an editable token clears the mark", () => {
    markReadOnlyDoc(DOC, true);
    markReadOnlyDoc(DOC, false);
    expect(isReadOnlyDoc(DOC)).toBe(false);
  });
});
