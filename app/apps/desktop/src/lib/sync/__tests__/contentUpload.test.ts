// Bulk CONTENT upload (phase 2) — the write path that did not exist.
//
// Reconcile only ever created a `notes` row (and hence an EMPTY server Y.Doc) per
// file; a note's markdown reached the server solely when a human opened it. These
// tests cover the engine that fixes that, and above all its idempotency: running
// it twice — or running it on a second device that holds the same file — must
// leave the note's text IDENTICAL, never doubled.
//
// The "server" here is a real Y.Doc per docId, exchanged exactly the way
// Hocuspocus does it (SyncStep1/2 both directions on connect, then live update
// forwarding), so a doubling bug would show up as doubled text — not be papered
// over by a mock.

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { makeHarness } from "../../bridge/__tests__/helpers";
import { ContentUploader, type DocPush } from "../contentUpload";
import { UPLOAD_CONCURRENCY } from "../pool";
import type { SyncProgressSink } from "../progress";
import { VaultDocStore } from "../vaultDocStore";
import type { DocSyncState, SyncProgressPhase } from "../vaultScope";

const VAULT = "v-1";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

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
  seed(docId: string, text: string): void {
    this.doc(docId).getText("content").insert(0, text);
  }
}

interface PushBehaviour {
  /** Docs whose provider never reaches a real sync (offline / server down). */
  neverSynced?: Set<string>;
  /** Docs whose grant is view-only. */
  readOnly?: Set<string>;
  /** Docs the server never acknowledges. */
  neverFlushed?: Set<string>;
}

/** A `DocPush` that behaves like `DocSync` over `server`. */
function makeConnect(server: FakeServer, behaviour: PushBehaviour = {}) {
  const connects: string[] = [];
  const connect = (input: { docId: string; vaultId: string; doc: Y.Doc }): DocPush => {
    const { docId, doc } = input;
    connects.push(docId);
    const remote = server.doc(docId);
    const readOnly = behaviour.readOnly?.has(docId) ?? false;
    let synced = false;
    let observer: ((u: Uint8Array) => void) | null = null;
    return {
      get readOnly() {
        return readOnly;
      },
      get isSynced() {
        return synced;
      },
      async whenSynced() {
        await tick();
        if (behaviour.neverSynced?.has(docId)) return; // times out, isSynced stays false
        // SyncStep1/2, both directions — exactly what makes pull-before-seed work.
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), "remote");
        if (!readOnly) {
          Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
        }
        // Live: every later local update is forwarded, like the provider does.
        observer = (u: Uint8Array) => {
          if (!readOnly) Y.applyUpdate(remote, u);
        };
        doc.on("update", observer);
        synced = true;
      },
      async whenFlushed() {
        await tick();
        return synced && !(behaviour.neverFlushed?.has(docId) ?? false);
      },
      destroy() {
        if (observer) doc.off("update", observer);
        observer = null;
      },
    };
  };
  return { connect, connects };
}

function recordingSink() {
  const phases: SyncProgressPhase[] = [];
  const docs: Array<[string, DocSyncState]> = [];
  let done = 0;
  let failed = 0;
  const sink: SyncProgressSink = {
    phase: (p) => phases.push(p),
    addTotal: () => {},
    item: (o) => {
      done++;
      if (o === "failed") failed++;
    },
    doc: (id, s) => docs.push([id, s]),
    flush: () => {},
  };
  return {
    sink,
    phases,
    docs,
    stateOf: (id: string) => docs.filter(([d]) => d === id).map(([, s]) => s),
    counts: () => ({ done, failed }),
  };
}

interface RigOptions {
  files: Record<string, string>;
  notes: Array<{ docId: string; relPath: string }>;
  server?: FakeServer;
  behaviour?: PushBehaviour;
  pushed?: Set<string>;
  skip?: (docId: string) => boolean;
  shouldStop?: () => boolean;
  concurrency?: number;
  failureStreakLimit?: number;
  /** Reuse a previous rig's CRDT store, to model a SECOND run on one device. */
  harness?: ReturnType<typeof makeHarness>;
  onAcquire?: (docId: string, store: VaultDocStore) => void;
}

function rig(opts: RigOptions) {
  const harness = opts.harness ?? makeHarness(opts.files);
  const server = opts.server ?? new FakeServer();
  const pathByDoc = new Map(opts.notes.map((n) => [n.docId, n.relPath] as const));
  const store = new VaultDocStore({
    io: harness.io,
    resolvePath: (docId) => pathByDoc.get(docId) ?? null,
  });
  const { connect, connects } = makeConnect(server, opts.behaviour);
  const pushedSet = opts.pushed ?? new Set<string>();
  const marked: string[] = [];
  const sink = recordingSink();
  const uploader = new ContentUploader({
    vaultId: VAULT,
    notes: opts.notes,
    deps: {
      acquire: (docId, relPath) => {
        opts.onAcquire?.(docId, store);
        return store.promote(docId, relPath, {
          seedFromFile: false,
          markRecent: false,
          pin: true,
        });
      },
      release: (docId) => store.demote(docId),
      connect,
    },
    isPushed: (id) => pushedSet.has(id),
    markPushed: (id) => {
      marked.push(id);
      pushedSet.add(id);
    },
    skip: opts.skip,
    shouldStop: opts.shouldStop,
    progress: sink.sink,
    concurrency: opts.concurrency,
    failureStreakLimit: opts.failureStreakLimit,
    syncTimeoutMs: 50,
    flushTimeoutMs: 50,
  });
  return { uploader, store, server, harness, connects, marked, sink, pushedSet };
}

describe("ContentUploader — pushing local content", () => {
  it("seeds an empty server doc from the local markdown", async () => {
    const r = rig({
      files: { "Note.md": "# hello world" },
      notes: [{ docId: "d1", relPath: "Note.md" }],
    });
    const result = await r.uploader.run();

    expect(result).toMatchObject({ total: 1, pushed: 1, failed: 0 });
    expect(r.server.text("d1")).toBe("# hello world");
    expect(r.marked).toEqual(["d1"]);
    expect(r.sink.stateOf("d1")).toEqual(["queued", "syncing", "synced"]);
    expect(r.sink.phases).toContain("uploading");
    // Residency released — the run does not leak bridges.
    expect(r.store.hotSize()).toBe(0);
  });

  it("writes server content out to disk for a note that is only a placeholder", async () => {
    const server = new FakeServer();
    server.seed("d1", "content from a teammate");
    const r = rig({
      files: { "Note.md": "" },
      notes: [{ docId: "d1", relPath: "Note.md" }],
      server,
    });
    await r.uploader.run();

    expect(r.harness.fs.get("Note.md")).toBe("content from a teammate");
    expect(r.server.text("d1")).toBe("content from a teammate"); // unchanged
  });

  it("never pushes for a view-only grant, but still pulls", async () => {
    const server = new FakeServer();
    server.seed("d1", "theirs");
    const r = rig({
      files: { "Note.md": "mine" },
      notes: [{ docId: "d1", relPath: "Note.md" }],
      server,
      behaviour: { readOnly: new Set(["d1"]) },
    });
    await r.uploader.run();

    expect(r.server.text("d1")).toBe("theirs"); // our text was NOT pushed
    expect(r.harness.fs.get("Note.md")).toBe("theirs");
  });
});

describe("ContentUploader — idempotency (must never double content)", () => {
  it("re-running on the same device leaves the text identical", async () => {
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const files = { "Note.md": "alpha beta gamma" };
    const first = rig({ files, notes });
    await first.uploader.run();
    expect(first.server.text("d1")).toBe("alpha beta gamma");

    // Same CRDT store, same server, and deliberately NOT skipped by the
    // checkpoint — this is the "stale/missing checkpoint" case.
    const second = rig({
      files,
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(),
    });
    const result = await second.uploader.run();

    expect(result.pushed).toBe(1);
    expect(second.server.text("d1")).toBe("alpha beta gamma");
  });

  it("a SECOND device holding the same file does not duplicate the note", async () => {
    // This is the case that doubles if the seed ever runs before the pull: two
    // Y.Docs with different client ids each insert the file's text, and Yjs
    // merges both insertions instead of deduplicating them.
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const files = { "Note.md": "shared paragraph" };
    const deviceA = rig({ files, notes });
    await deviceA.uploader.run();

    const deviceB = rig({ files, notes, server: deviceA.server }); // fresh CRDT store
    await deviceB.uploader.run();

    expect(deviceA.server.text("d1")).toBe("shared paragraph");
    expect(deviceB.harness.fs.get("Note.md")).toBe("shared paragraph");
  });

  it("three runs in a row are still exactly one copy", async () => {
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const files = { "Note.md": "once" };
    let harness = makeHarness(files);
    let server = new FakeServer();
    for (let i = 0; i < 3; i++) {
      const r = rig({ files, notes, harness, server, pushed: new Set() });
      await r.uploader.run();
      harness = r.harness;
      server = r.server;
    }
    expect(server.text("d1")).toBe("once");
  });

  it("does NOT seed when the initial sync never landed (no unpushed local orphan)", async () => {
    // Seeding on an unverified pull is precisely how a local orphan is created
    // that later merges into real server content as a duplicate.
    const r = rig({
      files: { "Note.md": "local only" },
      notes: [{ docId: "d1", relPath: "Note.md" }],
      behaviour: { neverSynced: new Set(["d1"]) },
    });
    const result = await r.uploader.run();

    expect(result).toMatchObject({ pushed: 0, failed: 1 });
    expect(r.server.text("d1")).toBe("");
    expect(r.marked).toEqual([]);
    expect(r.sink.stateOf("d1")).toContain("error");
    // Nothing was seeded locally either, so the next attempt starts clean.
    expect(r.harness.persistence.logLength("d1")).toBe(0);
  });
});

describe("ContentUploader — bounded and cancellable", () => {
  it("keeps at most UPLOAD_CONCURRENCY docs resident at once", async () => {
    const notes = Array.from({ length: 24 }, (_, i) => ({
      docId: `d${i}`,
      relPath: `Note${i}.md`,
    }));
    const files: Record<string, string> = {};
    for (const n of notes) files[n.relPath] = `body of ${n.docId}`;
    let maxHot = 0;
    const r = rig({
      files,
      notes,
      onAcquire: (_docId, store) => {
        maxHot = Math.max(maxHot, store.hotSize() + 1);
      },
    });
    const result = await r.uploader.run();

    expect(result.pushed).toBe(24);
    expect(maxHot).toBeGreaterThan(1); // genuinely concurrent, not sequential
    expect(maxHot).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(r.store.hotSize()).toBe(0);
    for (const n of notes) expect(r.server.text(n.docId)).toBe(`body of ${n.docId}`);
  });

  it("abandons the rest of the queue when the vault switches", async () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({
      docId: `d${i}`,
      relPath: `Note${i}.md`,
    }));
    const files: Record<string, string> = {};
    for (const n of notes) files[n.relPath] = "x";
    let current = true;
    const r = rig({
      files,
      notes,
      shouldStop: () => !current,
      onAcquire: () => {
        if (r.connects.length >= 4) current = false; // the user switched vaults
      },
    });
    const result = await r.uploader.run();

    expect(result.cancelled).toBe(true);
    expect(r.connects.length).toBeLessThan(40);
    expect(r.marked.length).toBeLessThan(40);
    // Nothing was pushed for the docs we never reached.
    const untouched = notes.slice(r.connects.length + UPLOAD_CONCURRENCY);
    for (const n of untouched) expect(r.server.text(n.docId)).toBe("");
  });

  it("skips the open note — its editor session owns that doc's provider", async () => {
    const notes = [
      { docId: "open", relPath: "Open.md" },
      { docId: "other", relPath: "Other.md" },
    ];
    const r = rig({
      files: { "Open.md": "being edited", "Other.md": "background" },
      notes,
      skip: (docId) => docId === "open",
    });
    const result = await r.uploader.run();

    expect(r.connects).toEqual(["other"]);
    expect(result.total).toBe(1);
    expect(r.server.text("open")).toBe("");
    expect(r.server.text("other")).toBe("background");
  });
});

describe("ContentUploader — resume and honest failures", () => {
  it("resumes from the checkpoint: already-pushed docs are never re-opened", async () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({
      docId: `d${i}`,
      relPath: `Note${i}.md`,
    }));
    const files: Record<string, string> = {};
    for (const n of notes) files[n.relPath] = n.docId;
    const r = rig({ files, notes, pushed: new Set(["d0", "d1", "d2"]) });
    const result = await r.uploader.run();

    expect(result.total).toBe(3);
    expect(r.connects.sort()).toEqual(["d3", "d4", "d5"]);
    // The resumed half reads as synced immediately, before a socket opens.
    expect(r.sink.stateOf("d0")).toEqual(["synced"]);
  });

  it("marks a doc the server never acknowledged as error, and does not checkpoint it", async () => {
    const notes = [
      { docId: "ok", relPath: "Ok.md" },
      { docId: "bad", relPath: "Bad.md" },
    ];
    const r = rig({
      files: { "Ok.md": "fine", "Bad.md": "lost" },
      notes,
      behaviour: { neverFlushed: new Set(["bad"]) },
      concurrency: 1,
    });
    const result = await r.uploader.run();

    expect(result).toMatchObject({ total: 2, pushed: 1, failed: 1 });
    expect(r.marked).toEqual(["ok"]);
    expect(r.uploader.failedDocs()).toEqual([
      { docId: "bad", relPath: "Bad.md", reason: expect.any(String) },
    ]);
    expect(r.sink.stateOf("bad")).toContain("error");
    expect(r.sink.counts().failed).toBe(1);
  });

  it("aborts the whole run after a streak of failures (a dead server)", async () => {
    const notes = Array.from({ length: 50 }, (_, i) => ({
      docId: `d${i}`,
      relPath: `Note${i}.md`,
    }));
    const files: Record<string, string> = {};
    for (const n of notes) files[n.relPath] = "x";
    const r = rig({
      files,
      notes,
      behaviour: { neverSynced: new Set(notes.map((n) => n.docId)) },
      concurrency: 1,
      failureStreakLimit: 5,
    });
    const result = await r.uploader.run();

    expect(result.aborted).toBe(true);
    // Bounded: it does not grind through all 50 timeouts.
    expect(result.failed).toBeLessThanOrEqual(6);
    expect(r.connects.length).toBeLessThanOrEqual(6);
  });

  it("survives an acquire failure without abandoning the rest of the queue", async () => {
    const notes = [
      { docId: "d1", relPath: "Missing.md" },
      { docId: "d2", relPath: "Present.md" },
    ];
    const r = rig({ files: { "Present.md": "here" }, notes, concurrency: 1 });
    // `NoteBridge.open` reads the file; a missing one still opens (the read error
    // is reported, not thrown), so force a real acquire failure instead.
    const original = r.store.promote.bind(r.store);
    vi.spyOn(r.store, "promote").mockImplementation(async (docId, path, o) => {
      if (docId === "d1") throw new Error("index locked");
      return original(docId, path, o);
    });

    const result = await r.uploader.run();
    expect(result).toMatchObject({ total: 2, pushed: 1, failed: 1 });
    expect(r.server.text("d2")).toBe("here");
    expect(r.uploader.failedDocs()[0].docId).toBe("d1");
  });
});
