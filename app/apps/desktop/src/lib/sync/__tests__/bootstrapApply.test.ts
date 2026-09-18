// The bootstrap download, against a fake disk that implements the RUST
// eligibility table exactly as `apply_bootstrap_batch` does.
//
// The table is the whole safety argument, so it is modelled here rather than
// mocked away: Rust decides each doc's fate from the FILE and the local CRDT
// rows, never from the list the runner sends, and these tests assert the
// consequences the product depends on —
//
//   * a page applied twice writes nothing the second time (no doubling);
//   * a run killed mid-page resumes to a byte-identical vault;
//   * a file the human edited is NEVER overwritten (it comes back `conflict`
//     and goes to the per-doc merge path);
//   * a doc that already has local CRDT is MERGED (cold apply), never fast-pathed;
//   * an empty server doc never blanks a non-empty file.
//
// No Tauri, no network: every dependency is injected, in the style of
// `contentUpload.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BootstrapEntry, BootstrapOutcome } from "../../ipc";
import { BootstrapRunner, type BootstrapResume } from "../bootstrap";
import { encodeBootstrapPage } from "../bootstrapCodec";
import type { BootstrapSession } from "../bulkTypes";

const VAULT = "collection-1";

/** A Yjs V1 update for a doc whose "content" text is `text`. */
function updateFor(text: string): Uint8Array {
  const doc = new Y.Doc();
  if (text) doc.getText("content").insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** The text a stored update serializes to — "what the file should say". */
function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

interface PageDoc {
  docId: string;
  relPath: string;
  update: Uint8Array;
}

/**
 * The fake vault: files on disk, CRDT rows in "SQLite", and the eligibility
 * table between them.
 */
function world(initial: { files?: Record<string, string>; crdt?: Record<string, Uint8Array> } = {}) {
  const files = new Map<string, string>(Object.entries(initial.files ?? {}));
  const crdt = new Map<string, Uint8Array>(Object.entries(initial.crdt ?? {}));
  const applied: BootstrapEntry[][] = [];
  const coldApplied: string[] = [];
  const pushedDocs: string[] = [];
  const materialized: string[] = [];

  const applyBatch = vi.fn(async (entries: BootstrapEntry[]): Promise<BootstrapOutcome[]> => {
    applied.push(entries);
    return entries.map((e) => {
      if (crdt.has(e.docId)) {
        return { docId: e.docId, status: "rejected", reason: "already has local CRDT state" };
      }
      const file = files.get(e.relPath);
      if (file === undefined || file.length === 0) {
        files.set(e.relPath, e.content);
        crdt.set(e.docId, e.snapshot);
        return { docId: e.docId, status: "written", reason: null };
      }
      if (file === e.content) {
        crdt.set(e.docId, e.snapshot);
        return { docId: e.docId, status: "unchanged", reason: null };
      }
      // Non-empty and different: writes NOTHING — including when the server's
      // copy is empty, which is the "never blank a real file" case.
      return { docId: e.docId, status: "conflict", reason: "local file differs" };
    });
  });

  /** `VaultDocStore.applyUpdate`: merges, then egests the merged text. */
  const coldApply = vi.fn(async (docId: string, update: Uint8Array) => {
    coldApplied.push(docId);
    const doc = new Y.Doc();
    const existing = crdt.get(docId);
    if (existing) Y.applyUpdate(doc, existing);
    Y.applyUpdate(doc, update);
    crdt.set(docId, Y.encodeStateAsUpdate(doc));
    const path = [...files.keys()].find((p) => p === pathOfDoc.get(docId));
    if (path) files.set(path, doc.getText("content").toString());
    doc.destroy();
  });

  const pathOfDoc = new Map<string, string>();

  return {
    files,
    crdt,
    applied,
    coldApplied,
    pushedDocs,
    materialized,
    pathOfDoc,
    applyBatch,
    coldApply,
    snapshot: () => ({
      files: Object.fromEntries(files),
      crdt: Object.fromEntries([...crdt].map(([k, v]) => [k, [...v].join(",")])),
    }),
  };
}

/** A server that hands out `pages` one at a time from a cursor. */
function server(pages: PageDoc[][], opts: { emptyDocs?: string[] } = {}) {
  const state = {
    sessions: 0,
    have: [] as string[][],
    fetched: [] as number[],
    /** Answer 410 for every request until the session is re-opened. */
    expireAfter: null as number | null,
  };
  const createSession = vi.fn(async (have: string[]): Promise<BootstrapSession> => {
    state.sessions++;
    state.have.push([...have]);
    return {
      sessionId: `s${state.sessions}`,
      docs: pages.reduce((n, p) => n + p.length, 0),
      bytes: 1000,
      emptyDocs: opts.emptyDocs ?? [],
      emptyTruncated: false,
      expiresAt: "",
    };
  });
  const fetchPage = vi.fn(async (_sessionId: string, cursor: number) => {
    state.fetched.push(cursor);
    if (state.expireAfter != null && state.fetched.length > state.expireAfter) {
      state.expireAfter = null;
      const err = Object.assign(new Error("gone"), { status: 410, code: "session_expired" });
      throw err;
    }
    const page = pages[cursor] ?? [];
    return {
      bytes: encodeBootstrapPage(page),
      nextCursor: cursor + 1 < pages.length ? cursor + 1 : null,
      docs: page.length,
      uncompressedBytes: page.reduce((n, d) => n + d.update.byteLength, 0),
    };
  });
  return { state, createSession, fetchPage };
}

/** Wire a runner to a world + a server, with a config-file-like resume slot. */
function runner(
  w: ReturnType<typeof world>,
  s: ReturnType<typeof server>,
  opts: { resume?: { value: BootstrapResume | null }; shouldStop?: () => boolean } = {},
) {
  const resume = opts.resume ?? { value: null as BootstrapResume | null };
  const r = new BootstrapRunner({
    serverVaultId: VAULT,
    shouldStop: opts.shouldStop,
    deps: {
      createSession: s.createSession,
      fetchPage: s.fetchPage,
      applyBatch: w.applyBatch,
      coldApply: w.coldApply,
      haveDocs: () => [...w.crdt.keys()],
      markPushed: (docId) => w.pushedDocs.push(docId),
      markMaterialized: (relPath) => w.materialized.push(relPath),
      loadResume: () => resume.value,
      saveResume: (state) => {
        resume.value = state;
      },
      flushCheckpoint: async () => {},
      sleep: async () => {},
    },
  });
  return { r, resume };
}

beforeEach(() => vi.clearAllMocks());

describe("paging", () => {
  it("asks for the next page BEFORE applying the one in hand", async () => {
    // The loop used to fetch → decode → apply → fetch, so the network was idle
    // through every Rust apply and the disk idle through every fetch (20 such
    // alternations on a 5,000-doc vault). Depth 1 only: peak heap stays one page
    // in flight plus one being applied.
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("one") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("two") }],
      [{ docId: "c", relPath: "c.md", update: updateFor("three") }],
    ];
    const w = world();
    const s = server(pages);
    /** How many pages had been REQUESTED when each apply started. */
    const requestedAtApply: number[] = [];
    const realApply = w.applyBatch.getMockImplementation()!;
    w.applyBatch.mockImplementation(async (entries) => {
      requestedAtApply.push(s.state.fetched.length);
      return realApply(entries);
    });

    const { r } = runner(w, s);
    await r.run();

    // Page 0 is applied with page 1 already on the wire, and so on; the last
    // page (nextCursor null) starts nothing new.
    expect(requestedAtApply).toEqual([2, 3, 3]);
    // …and the vault is exactly what the serial loop produced: every page
    // applied once, in order, with no extra request.
    expect(s.state.fetched).toEqual([0, 1, 2]);
    expect(w.files.get("a.md")).toBe("one");
    expect(w.files.get("b.md")).toBe("two");
    expect(w.files.get("c.md")).toBe("three");
  });

  it("drops a prefetched page when the session expires under it", async () => {
    // The in-flight page belongs to a session the server has forgotten; the
    // restart re-opens one and pages from ITS cursor, never applying the orphan.
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("one") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("two") }],
    ];
    const w = world();
    const s = server(pages);
    s.state.expireAfter = 1; // the prefetch of page 1 is the one that 410s
    const { r } = runner(w, s);
    await r.run();

    expect(s.state.sessions).toBe(2);
    expect(w.files.get("a.md")).toBe("one");
    expect(w.files.get("b.md")).toBe("two");
  });
});

describe("the eligibility table, end to end", () => {
  it("handles all four outcomes in one page", async () => {
    const pages: PageDoc[][] = [
      [
        { docId: "fresh", relPath: "fresh.md", update: updateFor("server text") },
        { docId: "same", relPath: "same.md", update: updateFor("identical") },
        { docId: "differs", relPath: "differs.md", update: updateFor("server text") },
        { docId: "local", relPath: "local.md", update: updateFor("server text") },
      ],
    ];
    const w = world({
      files: { "same.md": "identical", "differs.md": "MY OWN WORK", "local.md": "" },
      crdt: { local: updateFor("local text") },
    });
    w.pathOfDoc.set("local", "local.md");
    const { r } = runner(w, server(pages));
    const out = await r.run();

    // written: the file is created from the server's copy…
    expect(w.files.get("fresh.md")).toBe("server text");
    // unchanged: the file already matched — the CRDT rows are still stored…
    expect(w.crdt.has("same")).toBe(true);
    // conflict: NOTHING was written, and the doc goes to the per-doc merge path.
    expect(w.files.get("differs.md")).toBe("MY OWN WORK");
    expect(out.conflicts).toEqual(["differs"]);
    // rejected: a doc with local CRDT is MERGED, never fast-pathed.
    expect(w.coldApplied).toEqual(["local"]);
    expect(out.merged).toBe(1);

    // Only the two the store now holds may be claimed as pushed, and only the
    // files WE created owe a watcher echo.
    expect(out.applied).toBe(2);
    expect(new Set(w.pushedDocs)).toEqual(new Set(["fresh", "same"]));
    expect(new Set(w.materialized)).toEqual(new Set(["fresh.md", "same.md"]));
  });

  it("never writes an EMPTY server doc over a non-empty file", async () => {
    const w = world({ files: { "note.md": "words that exist only here" } });
    const pages: PageDoc[][] = [[{ docId: "d", relPath: "note.md", update: updateFor("") }]];
    const { r } = runner(w, server(pages));
    const out = await r.run();

    expect(w.files.get("note.md")).toBe("words that exist only here");
    expect(out.conflicts).toEqual(["d"]);
    expect(w.pushedDocs).toEqual([]);
  });

  it("never claims a conflicted doc as pushed", async () => {
    const w = world({ files: { "a.md": "mine" } });
    const { r } = runner(w, server([[{ docId: "a", relPath: "a.md", update: updateFor("theirs") }]]));
    await r.run();
    expect(w.pushedDocs).toEqual([]);
  });
});

describe("idempotence", () => {
  it("runs twice with no doubling — the second pass writes nothing", async () => {
    const pages: PageDoc[][] = [
      [
        { docId: "a", relPath: "a.md", update: updateFor("alpha") },
        { docId: "b", relPath: "b/b.md", update: updateFor("beta") },
      ],
    ];
    const w = world();
    const first = runner(w, server(pages));
    await first.r.run();
    const after = w.snapshot();

    // A second session over the same pages: every doc now has CRDT rows, so the
    // table answers `rejected` and the merge is a no-op on state we already hold.
    const second = runner(w, server(pages));
    await second.r.run();

    expect(w.snapshot()).toEqual(after);
    expect(w.files.get("a.md")).toBe("alpha");
    expect(textOf(w.crdt.get("a")!)).toBe("alpha");
  });
});

describe("resume", () => {
  it("a run killed mid-stream resumes to a byte-identical vault", async () => {
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("alpha") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("beta") }],
      [{ docId: "c", relPath: "c.md", update: updateFor("gamma") }],
    ];
    // The reference: one uninterrupted run.
    const whole = world();
    await runner(whole, server(pages)).r.run();

    // The interrupted one: stop after the first page has been applied.
    const partial = world();
    let applies = 0;
    partial.applyBatch.mockImplementation(async (entries: BootstrapEntry[]) => {
      applies++;
      return entries.map((e) => {
        partial.files.set(e.relPath, e.content);
        partial.crdt.set(e.docId, e.snapshot);
        return { docId: e.docId, status: "written" as const, reason: null };
      });
    });
    const slot = { value: null as BootstrapResume | null };
    const killed = runner(partial, server(pages), {
      resume: slot,
      shouldStop: () => applies >= 1,
    });
    await killed.r.run();
    expect(slot.value).not.toBeNull();
    expect(slot.value!.cursor).toBe(1); // the NEXT page, saved after the IPC returned
    expect(partial.files.size).toBe(1);

    // …and the resumed run picks up exactly there.
    const s2 = server(pages);
    const resumed = runner(partial, s2, { resume: slot });
    await resumed.r.run();

    expect(s2.createSession).not.toHaveBeenCalled(); // resumed, not restarted
    expect(s2.state.fetched[0]).toBe(1);
    expect(partial.snapshot()).toEqual(whole.snapshot());
    expect(slot.value).toBeNull(); // drained ⇒ no stale cursor for the next launch
  });

  it("advances the cursor ONLY after the batch IPC returns", async () => {
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("alpha") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("beta") }],
    ];
    const w = world();
    const slot = { value: null as BootstrapResume | null };
    const cursorsWhenApplied: Array<number | null> = [];
    const realApply = w.applyBatch.getMockImplementation()!;
    w.applyBatch.mockImplementation(async (entries: BootstrapEntry[]) => {
      // What a crash at this instant would leave behind.
      cursorsWhenApplied.push(slot.value?.cursor ?? null);
      return realApply(entries);
    });
    await runner(w, server(pages), { resume: slot }).r.run();

    // Page 0 is applied while the saved cursor still points AT page 0 (it is 0
    // from the session open), so a crash re-sends it rather than skipping it.
    expect(cursorsWhenApplied).toEqual([0, 1]);
  });

  it("ignores a cursor recorded against another collection", async () => {
    const w = world();
    const slot = {
      value: {
        serverVaultId: "some-other-collection",
        sessionId: "stale",
        cursor: 7,
        docsTotal: 9,
        docsDone: 9,
        bytesTotal: 9,
        bytesDone: 9,
      } as BootstrapResume,
    };
    // `registry.bootstrapResume()` is what guards this in production; here the
    // runner is handed the stale value directly and must still start clean.
    const s = server([[{ docId: "a", relPath: "a.md", update: updateFor("alpha") }]]);
    const r = new BootstrapRunner({
      serverVaultId: VAULT,
      deps: {
        createSession: s.createSession,
        fetchPage: s.fetchPage,
        applyBatch: w.applyBatch,
        coldApply: w.coldApply,
        haveDocs: () => [],
        markPushed: () => {},
        markMaterialized: () => {},
        loadResume: () => (slot.value?.serverVaultId === VAULT ? slot.value : null),
        saveResume: (v) => {
          slot.value = v as BootstrapResume;
        },
        flushCheckpoint: async () => {},
      },
    });
    await r.run();
    expect(s.createSession).toHaveBeenCalledTimes(1);
    expect(s.state.fetched[0]).toBe(0);
  });
});

describe("the server's two instructions", () => {
  it("410 opens a NEW session with a fresh `have`", async () => {
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("alpha") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("beta") }],
    ];
    const w = world();
    const s = server(pages);
    s.state.expireAfter = 1; // the second fetch 410s
    await runner(w, s).r.run();

    expect(s.createSession).toHaveBeenCalledTimes(2);
    // The second `have` carries what the first session already landed, so the
    // restart re-downloads the remainder and not the vault.
    expect(s.state.have[0]).toEqual([]);
    expect(s.state.have[1]).toEqual(["a"]);
  });

  it("waits out a 503 and then carries on", async () => {
    const pages: PageDoc[][] = [[{ docId: "a", relPath: "a.md", update: updateFor("alpha") }]];
    const w = world();
    const s = server(pages);
    let thrown = false;
    const real = s.fetchPage.getMockImplementation()!;
    s.fetchPage.mockImplementation(async (id: string, cursor: number) => {
      if (!thrown) {
        thrown = true;
        throw Object.assign(new Error("busy"), {
          status: 503,
          code: "bootstrap_busy",
          retryAfterMs: 5,
        });
      }
      return real(id, cursor);
    });
    const out = await runner(w, s).r.run();
    expect(out.applied).toBe(1);
    expect(w.files.get("a.md")).toBe("alpha");
  });

  it("re-throws `server_too_old` for the session to report", async () => {
    const w = world();
    const s = server([[{ docId: "a", relPath: "a.md", update: updateFor("alpha") }]]);
    s.fetchPage.mockImplementation(async () => {
      throw Object.assign(new Error("not found"), { status: 404, code: "server_too_old" });
    });
    await expect(runner(w, s).r.run()).rejects.toMatchObject({ code: "server_too_old" });
  });
});

describe("limits and reporting", () => {
  it("refuses a doc over the size ceiling ONCE, permanently, and keeps going", async () => {
    const huge = "x".repeat(11 * 1024 * 1024);
    const pages: PageDoc[][] = [
      [
        { docId: "big", relPath: "big.md", update: updateFor(huge) },
        { docId: "ok", relPath: "ok.md", update: updateFor("fine") },
      ],
    ];
    const w = world();
    const out = await runner(w, server(pages)).r.run();

    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ docId: "big", permanent: true });
    expect(w.files.has("big.md")).toBe(false);
    // …and the rest of the page still lands.
    expect(w.files.get("ok.md")).toBe("fine");
  });

  it("reports the session's emptyDocs for the push side", async () => {
    const w = world();
    const out = await runner(w, server([[]], { emptyDocs: ["e1", "e2"] })).r.run();
    expect(out.emptyDocs).toEqual(["e1", "e2"]);
  });

  it("stops on a vault switch without claiming anything", async () => {
    const pages: PageDoc[][] = [
      [{ docId: "a", relPath: "a.md", update: updateFor("alpha") }],
      [{ docId: "b", relPath: "b.md", update: updateFor("beta") }],
    ];
    const w = world();
    let stop = false;
    const out = await runner(w, server(pages), { shouldStop: () => stop }).r.run().then(
      (r) => r,
      (e) => {
        throw e;
      },
    );
    expect(out.cancelled).toBe(false);
    // …and a run that is stopped before it starts touches nothing.
    stop = true;
    const w2 = world();
    const out2 = await runner(w2, server(pages), { shouldStop: () => stop }).r.run();
    expect(out2.cancelled).toBe(true);
    expect(w2.files.size).toBe(0);
  });
});
