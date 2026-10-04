import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDiff, computeDiff } from "../../bridge/diff";
import {
  CLOSED_EDIT_CHUNK,
  EMPTY_SHA256,
  runClosedAppEdits,
  type ClosedAppEditsDeps,
  type DiskDrift,
} from "../closedAppEdits";
import { reconcileReport } from "../reconcileReport";

/**
 * A fake vault: `files` is the indexed sha256 per path, `bases` the recorded
 * disk base per doc. `listDrift` mirrors the Rust `list_disk_drift` contract.
 * The drain "pushes" what it was handed and records the new base + an ack, the
 * way the live ingest + push path does.
 */
type Note = {
  docId: string;
  relPath: string;
  sha: string;
  base: string | null;
  /** Local CRDT text (default "doc text"); null = no local CRDT. */
  doc?: string | null;
  /** File text (default "file text"). */
  file?: string;
  /** The server's resolver says view-only. */
  viewOnly?: boolean;
  /** Under a padlock in the editor's lock view. */
  locked?: boolean;
};

function harness(opts: { notes: Note[]; live?: boolean; open?: string | null; permanent?: string[] }) {
  const files = new Map(opts.notes.map((n) => [n.relPath, n.sha]));
  const bases = new Map(opts.notes.filter((n) => n.base != null).map((n) => [n.docId, n.base!]));
  const paths = new Map(opts.notes.map((n) => [n.docId, n.relPath]));
  const acked = new Set<string>();
  const chunks: string[][] = [];
  let live = opts.live ?? true;
  let queued: Array<{ docId: string; relPath: string }> = [];
  let listCalls = 0;
  const trash: string[] = [];
  const minted: string[] = [];
  const byId = new Map(opts.notes.map((n) => [n.docId, n]));
  const byPath = new Map(opts.notes.map((n) => [n.relPath, n]));
  const deps: ClosedAppEditsDeps = {
    isLive: () => live,
    isCurrent: () => true,
    mappedNotes: () => opts.notes.map((n) => ({ docId: n.docId, relPath: n.relPath })),
    listDrift: async (entries) => {
      listCalls++;
      const out: DiskDrift[] = [];
      for (const e of entries) {
        const base = bases.get(e.docId);
        const sha = files.get(e.path);
        if (base != null && sha != null && base !== sha) out.push({ docId: e.docId, path: e.path, sha256: sha });
      }
      return out;
    },
    openDocId: () => opts.open ?? null,
    isPermanentFailure: (d) => (opts.permanent ?? []).includes(d),
    pathForDocId: (d) => paths.get(d) ?? null,
    readOnlyPaths: async () => (p) => byPath.get(p)?.locked === true,
    canEdit: async (d) => {
      minted.push(d);
      return byId.get(d)?.viewOnly !== true;
    },
    docText: async (d) => {
      const n = byId.get(d)!;
      return n.doc === undefined ? "doc text" : n.doc;
    },
    fileText: async (p) => byPath.get(p)?.file ?? "file text",
    recordBase: async (d, sha) => {
      bases.set(d, sha);
    },
    enqueue: (chunk) => {
      chunks.push(chunk.map((c) => c.docId));
      queued = chunk;
    },
    waitForDrain: async () => {
      for (const n of queued) {
        bases.set(n.docId, files.get(n.relPath)!); // diskBase after the ingest
        acked.add(n.docId); // ackedSv after the push
      }
      queued = [];
    },
  };
  return { deps, chunks, acked, bases, trash, minted, setLive: (v: boolean) => (live = v), listCalls: () => listCalls };
}

describe("closed-app edits pass (#284)", () => {
  beforeEach(() => reconcileReport.clear());

  it("leaves a read-only note with a differing disk base alone: no push, no copy, no banner", async () => {
    const h = harness({
      notes: [
        { docId: "ro", relPath: "ro.md", sha: "new", base: "old", viewOnly: true },
        { docId: "lk", relPath: "locked/lk.md", sha: "new", base: "old", locked: true },
      ],
    });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 2, queued: 0, readOnly: 2, chunks: 0 });
    expect(h.chunks).toEqual([]);
    expect(h.acked.size).toBe(0);
    expect(h.trash).toEqual([]);
    expect(reconcileReport.items()).toEqual([]);
    // The padlocked note never even cost a permission request.
    expect(h.minted).toEqual(["ro"]);
    expect(h.bases.get("ro")).toBe("old");
  });

  it("treats an unanswered permission check as read-only", async () => {
    const h = harness({ notes: [{ docId: "a", relPath: "a.md", sha: "new", base: "old" }] });
    h.deps.canEdit = async () => {
      throw new Error("403");
    };
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ queued: 0, readOnly: 1 });
    expect(h.chunks).toEqual([]);
  });

  it("pushes nothing when the lock view cannot be read", async () => {
    const h = harness({ notes: [{ docId: "a", relPath: "a.md", sha: "new", base: "old" }] });
    h.deps.readOnlyPaths = async () => {
      throw new Error("offline");
    };
    expect(await runClosedAppEdits(h.deps)).toBeNull();
    expect(h.chunks).toEqual([]);
  });

  it("does not push when the file already equals the doc; re-records the base instead", async () => {
    const h = harness({
      notes: [{ docId: "a", relPath: "a.md", sha: "new", base: "stale", doc: "same", file: "same" }],
    });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 1, queued: 0, converged: 1 });
    expect(h.chunks).toEqual([]);
    expect(h.bases.get("a")).toBe("new");
    expect(await runClosedAppEdits(h.deps)).toMatchObject({ drifted: 0 });
  });

  it("does not push a note with no local CRDT to merge into", async () => {
    const h = harness({ notes: [{ docId: "a", relPath: "a.md", sha: "new", base: "old", doc: null }] });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ queued: 0, converged: 1 });
    expect(h.chunks).toEqual([]);
  });

  it("pushes a mapped closed note whose file changed and records its base and ack", async () => {
    const h = harness({
      notes: [
        { docId: "a", relPath: "a.md", sha: "new", base: "old" },
        { docId: "b", relPath: "b.md", sha: "same", base: "same" },
      ],
    });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 1, queued: 1, chunks: 1 });
    expect(h.chunks).toEqual([["a"]]);
    expect(h.bases.get("a")).toBe("new");
    expect(h.acked.has("a")).toBe(true);
    // A second launch finds nothing: the base now matches the file.
    const again = await runClosedAppEdits(h.deps);
    expect(again).toMatchObject({ drifted: 0, queued: 0 });
    expect(h.chunks).toHaveLength(1);
  });

  it("leaves an unchanged note and a note with no recorded base alone", async () => {
    const h = harness({
      notes: [
        { docId: "b", relPath: "b.md", sha: "same", base: "same" },
        { docId: "c", relPath: "c.md", sha: "x", base: null },
      ],
    });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 0, queued: 0 });
    expect(h.chunks).toEqual([]);
    expect(h.acked.size).toBe(0);
  });

  it("never queues a 0-byte file, so it cannot clear a populated doc", async () => {
    const h = harness({ notes: [{ docId: "a", relPath: "a.md", sha: EMPTY_SHA256, base: "full" }] });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 1, queued: 0, skipped: 1 });
    expect(h.chunks).toEqual([]);
    expect(h.bases.get("a")).toBe("full");
  });

  it("skips the open note and permanent failures", async () => {
    const h = harness({
      notes: [
        { docId: "open", relPath: "o.md", sha: "n", base: "o" },
        { docId: "big", relPath: "big.md", sha: "n", base: "o" },
        { docId: "a", relPath: "a.md", sha: "n", base: "o" },
      ],
      open: "open",
      permanent: ["big"],
    });
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 3, queued: 1, skipped: 2 });
    expect(h.chunks).toEqual([["a"]]);
  });

  it("does nothing before the session is live", async () => {
    const h = harness({ notes: [{ docId: "a", relPath: "a.md", sha: "n", base: "o" }], live: false });
    expect(await runClosedAppEdits(h.deps)).toBeNull();
    expect(h.listCalls()).toBe(0);
    expect(h.chunks).toEqual([]);
  });

  it("processes 200 changed notes in chunks, one drain at a time", async () => {
    const notes = Array.from({ length: 200 }, (_, i) => ({
      docId: `d${i}`,
      relPath: `n${i}.md`,
      sha: "new",
      base: "old",
    }));
    const h = harness({ notes });
    let inFlight = 0;
    let maxInFlight = 0;
    const wait = h.deps.waitForDrain;
    h.deps.waitForDrain = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      await wait();
      inFlight--;
    };
    const r = await runClosedAppEdits(h.deps);
    expect(r).toMatchObject({ drifted: 200, queued: 200, chunks: 200 / CLOSED_EDIT_CHUNK });
    expect(h.chunks.every((c) => c.length === CLOSED_EDIT_CHUNK)).toBe(true);
    expect(new Set(h.chunks.flat()).size).toBe(200);
    expect(maxInFlight).toBe(1);
    expect(h.acked.size).toBe(200);
  });
});

describe("closed-app edit ingest merges with server edits (#284)", () => {
  it("keeps the disk edit and the server edit once each", () => {
    // The last state this device and the server agreed on.
    const base = new Y.Doc();
    base.getText("content").insert(0, "# Note\n\nfirst line\n");
    const seed = Y.encodeStateAsUpdate(base);

    const local = new Y.Doc();
    Y.applyUpdate(local, seed);
    const server = new Y.Doc();
    Y.applyUpdate(server, seed);

    // A teammate appended on the server while this app was closed.
    const st = server.getText("content");
    st.insert(st.length, "server line\n");

    // A script appended to the file while this app was closed; the ingest
    // diff-merges the file into the local CRDT, which still holds the base.
    const file = "# Note\n\nfirst line\nlocal line\n";
    const lt = local.getText("content");
    applyDiff(lt, computeDiff(lt.toString(), file));

    // Push + pull.
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local, Y.encodeStateVector(server)));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server, Y.encodeStateVector(local)));

    const merged = local.getText("content").toString();
    expect(server.getText("content").toString()).toBe(merged);
    expect(merged.split("local line").length - 1).toBe(1);
    expect(merged.split("server line").length - 1).toBe(1);
    expect(merged.split("first line").length - 1).toBe(1);
  });
});
