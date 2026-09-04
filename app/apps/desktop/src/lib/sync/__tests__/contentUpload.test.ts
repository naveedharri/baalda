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
import { ContentUploader, MAX_NOTE_BYTES, type DocPush } from "../contentUpload";
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
  force?: boolean;
  include?: (docId: string) => boolean;
  priority?: (docId: string) => boolean;
  ingestFromFile?: boolean;
  mustConnect?: (docId: string) => boolean;
  /** Reuse a previous rig's CRDT store, to model a SECOND run on one device. */
  harness?: ReturnType<typeof makeHarness>;
  onAcquire?: (docId: string, store: VaultDocStore) => void;
  /** Wire the production `readFile` dep (the pre-network checks need it). */
  readFile?: boolean;
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
      ...(opts.readFile ? { readFile: (relPath: string) => harness.io.readFile(relPath) } : {}),
    },
    isPushed: (id) => pushedSet.has(id),
    markPushed: (id) => {
      marked.push(id);
      pushedSet.add(id);
    },
    skip: opts.skip,
    force: opts.force,
    include: opts.include,
    priority: opts.priority,
    ingestFromFile: opts.ingestFromFile,
    mustConnect: opts.mustConnect,
    shouldStop: opts.shouldStop,
    progress: sink.sink,
    concurrency: opts.concurrency,
    failureStreakLimit: opts.failureStreakLimit,
    syncTimeoutMs: 50,
    flushTimeoutMs: 50,
  });
  return { uploader, store, server, harness, connects, marked, sink, pushedSet };
}

describe("ContentUploader — pre-network checks (readFile)", () => {
  it("settles a note the server lacks whose file is empty too, without a socket", async () => {
    // The prod loop: 307 zero-byte .md files, all "pushed" locally, all named by
    // `ready.empty` on every connect. Seeding an empty file inserts nothing, so
    // the server kept holding nothing and named them again next time — a token
    // mint and a WebSocket apiece, forever.
    const r = rig({
      files: { "Empty.md": "" },
      notes: [{ docId: "e", relPath: "Empty.md" }],
      pushed: new Set(["e"]),
      include: () => true, // the server says it has nothing for this doc
      readFile: true,
    });
    const result = await r.uploader.run();
    expect(result).toMatchObject({ total: 1, pushed: 1, failed: 0 });
    expect(r.connects).toEqual([]);
    expect(r.marked).toEqual(["e"]);
    const states = r.sink.stateOf("e");
    expect(states[states.length - 1]).toBe("synced");
    expect(r.store.hotSize()).toBe(0);
  });

  it("still PULLS for an empty placeholder when the server has not said it is empty", async () => {
    // Same local shape (empty file, empty doc) but the server holds content the
    // backfill never delivered here. Skipping the network would strand the note
    // blank until the next reconnect — the socket is the recovery path.
    const server = new FakeServer();
    server.seed("p", "content from a teammate");
    const r = rig({
      files: { "Placeholder.md": "" },
      notes: [{ docId: "p", relPath: "Placeholder.md" }],
      server,
      readFile: true,
    });
    await r.uploader.run();
    expect(r.connects).toEqual(["p"]);
    expect(r.harness.fs.get("Placeholder.md")).toBe("content from a teammate");
  });

  it("fails a note over the size ceiling permanently, without a socket or a streak hit", async () => {
    const huge = "x".repeat(MAX_NOTE_BYTES + 1);
    const r = rig({
      files: { "Huge.md": huge, "Small.md": "fine" },
      notes: [
        { docId: "huge", relPath: "Huge.md" },
        { docId: "small", relPath: "Small.md" },
      ],
      readFile: true,
      concurrency: 1,
      failureStreakLimit: 1, // a single COUNTED failure would abort the run
    });
    const result = await r.uploader.run();
    // The oversized note failed once, for a reason a person can act on...
    expect(r.uploader.failedDocs()).toEqual([
      expect.objectContaining({
        docId: "huge",
        permanent: true,
        reason: expect.stringContaining("10 MB"),
      }),
    ]);
    expect(r.connects).toEqual(["small"]); // ...never dialled the server...
    // ...and did not count toward the streak: the run carried on and pushed the rest.
    expect(result).toMatchObject({ total: 2, pushed: 1, failed: 1, aborted: false });
    expect(r.server.text("small")).toBe("fine");
  });
});

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

describe("ContentUploader — local-change runs (force + ingestFromFile)", () => {
  // The live sync of externally-written files (an AI with the vault folder open
  // in Claude/Cursor writing .md files directly): the doc is already confirmed
  // on the server ("pushed"), but its file just changed underneath us.

  it("pushes an external edit to an already-pushed note", async () => {
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const first = rig({ files: { "Note.md": "v1" }, notes });
    await first.uploader.run();
    expect(first.server.text("d1")).toBe("v1");

    // Claude rewrites the file on disk while nobody has the note open.
    first.harness.fs.externalWrite("Note.md", "v1 plus an AI edit");
    const second = rig({
      files: {},
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(["d1"]),
      force: true,
      ingestFromFile: true,
    });
    const result = await second.uploader.run();

    expect(result).toMatchObject({ total: 1, pushed: 1, failed: 0 });
    expect(second.server.text("d1")).toBe("v1 plus an AI edit");
  });

  it("skips the network entirely when the file matches the doc (egest echo)", async () => {
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const first = rig({ files: { "Note.md": "steady" }, notes });
    await first.uploader.run();

    // The watcher fires for our OWN background write: same bytes, no diff.
    const second = rig({
      files: {},
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(["d1"]),
      force: true,
      ingestFromFile: true,
    });
    const result = await second.uploader.run();

    expect(result).toMatchObject({ total: 1, pushed: 1, failed: 0 });
    expect(second.connects).toEqual([]); // no provider was ever opened
    expect(second.server.text("d1")).toBe("steady");
    expect(second.store.hotSize()).toBe(0); // bridge released on the skip path
  });

  it("merges an external edit instead of doubling when the server moved too", async () => {
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const first = rig({ files: { "Note.md": "alpha beta" }, notes });
    await first.uploader.run();

    // A teammate appends on the server; Claude appends in the file. Both must
    // survive the push (CRDT merge), and nothing may double.
    first.server.doc("d1").getText("content").insert(0, "THEIRS ");
    first.harness.fs.externalWrite("Note.md", "alpha beta OURS");
    const second = rig({
      files: {},
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(["d1"]),
      force: true,
      ingestFromFile: true,
    });
    await second.uploader.run();

    const merged = second.server.text("d1");
    expect(merged).toContain("THEIRS");
    expect(merged).toContain("OURS");
    expect(merged.match(/alpha beta/g)).toHaveLength(1);
    // The merged text landed back on disk too.
    expect(second.harness.fs.get("Note.md")).toBe(merged);
  });

  it("still seeds an empty doc AFTER the pull on ingest runs (split-brain rule)", async () => {
    // A brand-new file (doc empty, never pushed) going through the local-change
    // path must behave exactly like the bulk path: pull first, then seed — the
    // pre-connect ingest is only for docs that already hold content.
    const server = new FakeServer();
    server.seed("d1", "server truth");
    const r = rig({
      files: { "Note.md": "" },
      notes: [{ docId: "d1", relPath: "Note.md" }],
      server,
      force: true,
      ingestFromFile: true,
    });
    await r.uploader.run();

    expect(r.server.text("d1")).toBe("server truth"); // no doubling, no clobber
    expect(r.harness.fs.get("Note.md")).toBe("server truth");
  });
});

describe("ContentUploader — mustConnect (out-of-band merges)", () => {
  it("connects and pushes even when file == doc, when the doc is marked diverged", async () => {
    // A cold apply (or resident bridge) already merged the external edit into
    // the doc and egested it back, so the file matches the doc — but the merged
    // ops never reached the server. `mustConnect` is the marker that forces the
    // flush the fast-path would otherwise skip.
    const notes = [{ docId: "d1", relPath: "Note.md" }];
    const first = rig({ files: { "Note.md": "v1" }, notes });
    await first.uploader.run();
    expect(first.server.text("d1")).toBe("v1");

    // Simulate the out-of-band merge: local ops land in the CRDT store and the
    // file, without any provider seeing them (exactly what coldApply's ingest
    // does when the server sent an unrelated delta).
    const { NoteBridge } = await import("../../bridge/noteBridge");
    first.harness.fs.externalWrite("Note.md", "v1 merged-out-of-band");
    const b = await NoteBridge.open(first.harness.io, { docId: "d1", path: "Note.md" });
    await b.ingestNow();
    b.destroy();

    const second = rig({
      files: {},
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(["d1"]),
      force: true,
      ingestFromFile: true,
    });
    // Without the marker: the fast-path skips, and the server never learns.
    await second.uploader.run();
    expect(second.server.text("d1")).toBe("v1");
    expect(second.connects).toEqual([]);

    const third = rig({
      files: {},
      notes,
      harness: first.harness,
      server: first.server,
      pushed: new Set(["d1"]),
      force: true,
      ingestFromFile: true,
      mustConnect: () => true,
    });
    await third.uploader.run();
    expect(third.connects).toEqual(["d1"]);
    expect(third.server.text("d1")).toBe("v1 merged-out-of-band");
  });
});

// ── `ready.empty`: the server outranks the local checkpoint ─────────────────
// `pushed` is a local optimisation. A crashed run, a wiped `.context/` or a
// restored backup can leave it claiming notes the server never received — 613 of
// them in prod, registered with zero content and unreachable forever, because
// every later run skipped them on the strength of that claim.

describe("ContentUploader — include (the server's empty list)", () => {
  it("pushes a doc the checkpoint claims but the server has no content for", async () => {
    const r = rig({
      files: { "Lost.md": "the only copy", "Fine.md": "already there" },
      notes: [
        { docId: "lost", relPath: "Lost.md" },
        { docId: "fine", relPath: "Fine.md" },
      ],
      pushed: new Set(["lost", "fine"]),
      include: (id) => id === "lost",
    });
    r.server.seed("fine", "already there");

    const result = await r.uploader.run();

    expect(result.total).toBe(1); // only the doc the server actually lacks
    expect(r.connects).toEqual(["lost"]);
    expect(r.server.text("lost")).toBe("the only copy");
    // …and it is never badged synced on the way in, not even for one emission.
    expect(r.sink.stateOf("lost")).toEqual(["queued", "syncing", "synced"]);
    expect(r.sink.stateOf("fine")).toEqual(["synced"]);
  });

  it("still connects when the file matches the doc (the ingest fast-path must not skip it)", async () => {
    // The local-change fast-path exists to avoid a socket per watcher echo, and
    // its whole premise is "the server already has this". For an `include` doc
    // that premise is false, so the fast-path has to stand down.
    const r = rig({
      files: { "Echo.md": "same bytes" },
      notes: [{ docId: "echo", relPath: "Echo.md" }],
      pushed: new Set(["echo"]),
      include: (id) => id === "echo",
      force: true,
      ingestFromFile: true,
    });

    await r.uploader.run();

    expect(r.connects).toEqual(["echo"]);
    expect(r.server.text("echo")).toBe("same bytes");
  });
});

describe("ContentUploader — priority", () => {
  it("pushes the prioritised docs first, keeping the order within each group", async () => {
    const notes = ["a", "b", "c", "d", "e"].map((id) => ({
      docId: id,
      relPath: `${id.toUpperCase()}.md`,
    }));
    const files: Record<string, string> = {};
    for (const n of notes) files[n.relPath] = `text ${n.docId}`;
    const r = rig({
      files,
      notes,
      // Serial, so `connects` IS the queue order.
      concurrency: 1,
      priority: (id) => id === "d" || id === "b",
    });

    await r.uploader.run();

    // Stable partition: d/b keep their relative order, and so does the rest.
    expect(r.connects).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("leaves the queue untouched when no priority is given", async () => {
    const notes = ["a", "b", "c"].map((id) => ({ docId: id, relPath: `${id}.md` }));
    const files: Record<string, string> = { "a.md": "1", "b.md": "2", "c.md": "3" };
    const r = rig({ files, notes, concurrency: 1 });
    await r.uploader.run();
    expect(r.connects).toEqual(["a", "b", "c"]);
  });
});
