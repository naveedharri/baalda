// Issue #104 — "an in-place truncating write (`> file`) is no longer picked up".
//
// Two findings, one test each.
//
// 1. The write SHAPE is not the variable. A truncate+refill, an append and a
//    create are indistinguishable by the time they reach this layer (the Rust
//    watcher reports one `modified` per path in all three cases, and the file is
//    already complete when the 150 ms drain reads it), and the whole three-step
//    reproduction from the issue goes through end to end here. What the reporter
//    measured — `notes.updated_at` — is only bumped for a sync edit by
//    `stampLastEdited`, which `VersionCapture.touch` throttles to once per 60 s
//    per (doc, editor), so the second write of a burst never moves that column.
//
// 2. There IS a way for an external edit to merge locally and never be pushed,
//    and it is not shape-dependent: `NoteBridge.hydrate` arms its own DEBOUNCED
//    ingest (noteBridge.ts, `if (this.text.length > 0) this.ingest()`), so when
//    that timer wins the race against `ContentUploader.pushOne`'s
//    `bridge.ingestNow()`, the uploader is told "nothing changed", takes the
//    no-socket fast path, marks the doc pushed and badges it synced — while the
//    merged ops sit on this device only. The second test pins that; it FAILS
//    today and is the defect worth fixing.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeHarness } from "../../bridge/__tests__/helpers";
import { ContentUploader, type DocPush } from "../contentUpload";
import type { SyncProgressSink } from "../progress";
import { VaultDocStore } from "../vaultDocStore";

const VAULT = "v-1";
const DOC = "d1";
const PATH = "note.md";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The server's canonical Y.Doc per docId (binary CRDT only, as in production). */
class FakeServer {
  private readonly docs = new Map<string, Y.Doc>();
  doc(docId: string): Y.Doc {
    let d = this.docs.get(docId);
    if (!d) {
      d = new Y.Doc();
      this.docs.set(docId, d);
    }
    return d;
  }
  text(docId: string): string {
    return this.doc(docId).getText("content").toString();
  }
}

/** A `DocPush` that behaves like `DocSync` over `server`. */
function makeConnect(server: FakeServer) {
  const connects: string[] = [];
  const connect = (input: { docId: string; vaultId: string; doc: Y.Doc }): DocPush => {
    const { docId, doc } = input;
    connects.push(docId);
    const remote = server.doc(docId);
    let synced = false;
    let observer: ((u: Uint8Array) => void) | null = null;
    return {
      get readOnly() {
        return false;
      },
      get isSynced() {
        return synced;
      },
      async whenSynced() {
        await tick();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), "remote");
        Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
        observer = (u: Uint8Array) => Y.applyUpdate(remote, u);
        doc.on("update", observer);
        synced = true;
      },
      async whenFlushed() {
        await tick();
        return synced;
      },
      destroy() {
        if (observer) doc.off("update", observer);
        observer = null;
      },
    };
  };
  return { connect, connects };
}

const nullSink: SyncProgressSink = {
  phase: () => {},
  addTotal: () => {},
  item: () => {},
  doc: () => {},
  flush: () => {},
};

/** One vault: real VaultDocStore + real NoteBridge + real ContentUploader. */
function rig(opts: { file: string; readFileDelayMs?: number }) {
  const harness = makeHarness({ [PATH]: opts.file });
  const server = new FakeServer();
  const store = new VaultDocStore({
    io: harness.io,
    resolvePath: (d) => (d === DOC ? PATH : null),
  });
  const { connect, connects } = makeConnect(server);
  const pushed = new Set<string>();
  const run = (o: { force?: boolean; ingestFromFile?: boolean } = {}) =>
    new ContentUploader({
      vaultId: VAULT,
      notes: [{ docId: DOC, relPath: PATH }],
      deps: {
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, { seedFromFile: false, markRecent: false, pin: true }),
        release: (docId) => store.demote(docId),
        connect,
        // Production reads the file through Tauri IPC (`ipc.readNote`), so this
        // is one process-boundary round trip, not a memory read.
        readFile: async (relPath: string) => {
          if (opts.readFileDelayMs) await sleep(opts.readFileDelayMs);
          return harness.io.readFile(relPath);
        },
      },
      isPushed: (id) => pushed.has(id),
      markPushed: (id) => pushed.add(id),
      force: o.force,
      ingestFromFile: o.ingestFromFile,
      progress: nullSink,
      syncTimeoutMs: 50,
      flushTimeoutMs: 50,
    }).run();
  return { harness, server, store, connects, pushed, run };
}

describe("#104 — an in-place truncating write", () => {
  it("syncs create, truncate+refill and append alike", async () => {
    const r = rig({ file: "# note\n\nfirst\n" });

    // 1. `printf '# note\n\nfirst\n' > note.md` — the create's content run.
    await r.run();
    expect(r.server.text(DOC)).toBe("# note\n\nfirst\n");

    // 2. `printf '# note\n\nsecond\n' > note.md` — truncate + refill, IN PLACE
    //    (open(O_WRONLY|O_CREAT|O_TRUNC), same inode). The bridge diffs it
    //    against the doc like any other edit: 0.31 change ratio, well under the
    //    0.6 that would take the large-diff path, and never 0 bytes, so the
    //    `allowTruncateFromDisk` refusal is not involved either.
    r.harness.fs.externalWrite(PATH, "# note\n\nsecond\n");
    await r.run({ force: true, ingestFromFile: true });
    expect(r.server.text(DOC)).toBe("# note\n\nsecond\n");

    // 3. `printf 'third\n' >> note.md` — append.
    r.harness.fs.externalWrite(PATH, "# note\n\nsecond\nthird\n");
    await r.run({ force: true, ingestFromFile: true });
    expect(r.server.text(DOC)).toBe("# note\n\nsecond\nthird\n");
  });

  it("pushes an external edit the hydrate-time ingest merged first", async () => {
    // The real "edit stays local while the badge says synced" mechanism.
    //
    // `promote` → `NoteBridge.open` → `hydrate` finds a non-empty doc and arms a
    // 150 ms debounced `ingest()`. `pushOne` then reads the file over IPC before
    // it calls `ingestNow()`. When that read takes longer than the debounce, the
    // hydrate timer has already merged the file into the doc, `ingestNow()`
    // answers "nothing changed" — and because the doc is `isPushed` and not
    // `mustConnect`, the uploader returns WITHOUT opening a socket and marks it
    // pushed. The merged ops never leave the device; only the next write to that
    // file can carry them.
    const r = rig({ file: "# note\n\nfirst\n", readFileDelayMs: 300 });
    await r.run();
    expect(r.server.text(DOC)).toBe("# note\n\nfirst\n");

    r.harness.fs.externalWrite(PATH, "# note\n\nsecond\n");
    await r.run({ force: true, ingestFromFile: true });

    // The doc DID take the edit — it is purely the push that was skipped.
    const bridge = await r.store.promote(DOC, PATH, { seedFromFile: false });
    expect(bridge.serialize()).toBe("# note\n\nsecond\n");
    await r.store.demote(DOC);

    expect(r.pushed.has(DOC)).toBe(true); // badged synced…
    expect(r.server.text(DOC)).toBe("# note\n\nsecond\n"); // …but the server never got it
  });
});

describe("#200 — a local-change run merges the file AFTER the pull", () => {
  /** A teammate edits the server's copy (their own client id). */
  function peerEdit(server: FakeServer, edit: (t: Y.Text) => void): void {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server.doc(DOC)));
    edit(peer.getText("content"));
    Y.applyUpdate(server.doc(DOC), Y.encodeStateAsUpdate(peer));
  }

  it("a file that already holds the server's edit is not re-inserted", async () => {
    const r = rig({ file: "Price: 97\n" });
    await r.run();
    expect(r.server.text(DOC)).toBe("Price: 97\n");

    // The teammate's edit reaches this disk before it reaches this device's
    // CRDT (a synced folder, another app's copy) — the watcher reports it.
    peerEdit(r.server, (t) => {
      t.delete(7, 1);
      t.insert(7, "12");
    });
    r.harness.fs.externalWrite(PATH, "Price: 127\n");
    await r.run({ force: true, ingestFromFile: true });

    expect(r.server.text(DOC)).toBe("Price: 127\n");
    expect(r.harness.fs.get(PATH)).toBe("Price: 127\n");
  });

  it("still pushes a genuine external edit next to a teammate's", async () => {
    const r = rig({ file: "A\nB\n" });
    await r.run();
    peerEdit(r.server, (t) => t.insert(0, "S\n"));
    r.harness.fs.externalWrite(PATH, "A\nB\nC from the AI\n");
    await r.run({ force: true, ingestFromFile: true });

    expect(r.server.text(DOC)).toBe("S\nA\nB\nC from the AI\n");
    expect(r.harness.fs.get(PATH)).toBe("S\nA\nB\nC from the AI\n");
  });
});
