// Small arrivals without placeholders.
//
// A teammate's new note or a small grant used to land as a 0-byte file first
// and fill in when the vault channel's backfill frame arrived. With the channel
// connected and live, the pull defers those placeholders and the first content
// frame creates the file WITH its text through the bootstrap apply. Whatever
// has not arrived within DEFERRED_ARRIVAL_WAIT_MS gets its placeholder after
// all, and so does everything on a vault-channel drop.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null as string | null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => [] as Array<{ id: string; path: string; title: string }>),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  rebindNoteId: vi.fn(async () => true),
  materializeNotesBatch: vi.fn(
    async (items: Array<{ relPath: string; docId: string | null }>) =>
      items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  ),
  isVaultMismatch: (e: unknown) =>
    e instanceof Error && e.message.startsWith("vault-mismatch"),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient, RegisteredNote } from "../../api";
import * as ipc from "../../ipc";
import type { BootstrapEntry, BootstrapOutcome, TreeNode } from "../../ipc";
import { makeHarness } from "../../bridge/__tests__/helpers";
import {
  createDeferredWithContent,
  DEFERRED_ARRIVAL_WAIT_MS,
  DeferredArrivalFlush,
  fullStateEntry,
  liveArrivalPredicate,
  type LiveArrivalState,
} from "../deferredArrival";
import { VaultRegistry, type InboundHost } from "../registry";
import { VaultDocStore } from "../vaultDocStore";
import { reconcileReport } from "../reconcileReport";
import { ContentUploader } from "../contentUpload";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";

const emptyTree = (): TreeNode => ({ id: "root", name: "vault", path: "", isDir: true, children: [] });

const serverOnly = (n: number): RegisteredNote[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `srv-${i}`,
    rel_path: `Remote/N${i}.md`,
    title: null,
  })) as RegisteredNote[];

function fakeApi(serverNotes: RegisteredNote[]) {
  return {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => serverNotes),
    listNoteRegistry: vi.fn(async () => ({ notes: serverNotes, tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: serverNotes, tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}`, path: input.path })),
    batchCreateFolders: vi.fn(async (_v: string, items: Array<{ path: string }>) =>
      items.map((i) => ({ path: i.path, id: `folder-${i.path}`, status: "created" as const, code: null, error: null })),
    ),
  } as unknown as ApiClient;
}

/** A teammate's note: its full server state as one update. */
function serverState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return u;
}

/** Placeholder writes the registry made (0-byte files). */
const placeholders = () => [
  ...vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0]),
  ...vi.mocked(ipc.materializeNotesBatch).mock.calls.flatMap((c) => c[0].map((i) => i.relPath)),
];

/**
 * The SyncManager's wiring in miniature: the live predicate arms the bounded
 * wait, the store's `createDeferred` goes through the bootstrap apply (here a
 * fake with Rust's create-only semantics over the harness disk), and the
 * flush writes the registry's pending placeholders.
 */
function setup(serverNotes: RegisteredNote[], state: Partial<LiveArrivalState> = {}) {
  const reg = new VaultRegistry(fakeApi(serverNotes));
  const { io, fs } = makeHarness({});
  const contentWrites: Array<{ path: string; content: string }> = [];
  const pushed: string[] = [];
  const materializedContent: string[] = [];
  let timer: { fn: () => void; ms: number } | null = null;
  const flush = new DeferredArrivalFlush(
    () => void reg.materializePendingFromBootstrap(),
    (fn, ms) => {
      timer = { fn, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    () => {
      timer = null;
    },
  );
  const live: LiveArrivalState = {
    serverTooOld: false,
    channelSynced: true,
    live: true,
    liveOnly: false,
    held: new Set(),
    serverEmpty: new Set(),
    ...state,
  };
  const h: InboundHost = {
    releaseDoc: async () => {},
    notePathChanged: () => {},
    noteRemoved: () => {},
    materializeContent: async (docId) => {
      materializedContent.push(docId);
      return true;
    },
    bootstrapWillDeliver: () => {
      const p = liveArrivalPredicate(live);
      if (p) flush.arm();
      return p;
    },
  };
  reg.setInboundHost(h);
  const applyBatch = async (entries: BootstrapEntry[]): Promise<BootstrapOutcome[]> =>
    Promise.all(
      entries.map(async (e) => {
        const cur = fs.get(e.relPath);
        if (cur == null || cur === "") {
          await fs.writeFileAtomic(e.relPath, e.content);
          contentWrites.push({ path: e.relPath, content: e.content });
          return { docId: e.docId, status: "written" as const, reason: null };
        }
        return { docId: e.docId, status: cur === e.content ? ("unchanged" as const) : ("conflict" as const), reason: null };
      }),
    );
  const store = new VaultDocStore({
    io,
    resolvePath: (id) => reg.pathForDocId(id),
    createDeferred: (docId, path, update) =>
      createDeferredWithContent(
        {
          deferredPathFor: (id) => reg.deferredPathFor(id),
          applyBatch,
          markMaterialized: (rp) => reg.markMaterialized(rp),
          markPushed: (id) => {
            reg.markPushed(id);
            pushed.push(id);
          },
        },
        docId,
        path,
        update,
      ),
  });
  const fireTimer = async () => {
    const t = timer;
    timer = null;
    t?.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    reg,
    fs,
    store,
    flush,
    contentWrites,
    pushed,
    materializedContent,
    timerMs: () => (timer as { ms: number } | null)?.ms ?? null,
    fireTimer,
    pull: () => reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reconcileReport.clear();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.materializeNotesBatch).mockImplementation(async (items) =>
    items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  );
});

describe("small arrivals land with their content, no placeholder first", () => {
  it.each([
    { path: "Remote/N0.md", content: "Hello from a teammate" },
    { path: "Dashboards/Home.html", content: "<!doctype html><h1>Shared dashboard</h1>" },
  ])("a live $path from a teammate is created with content in one write", async ({ path, content }) => {
    const notes = serverOnly(1);
    notes[0].rel_path = path;
    const t = setup(notes);
    await t.pull();

    expect(placeholders()).toEqual([]);
    expect(t.fs.get(path)).toBeUndefined();
    expect(t.reg.pendingFromBootstrapCount()).toBe(1);
    expect(t.timerMs()).toBe(DEFERRED_ARRIVAL_WAIT_MS);

    await t.store.applyUpdate("srv-0", serverState(content));

    expect(t.contentWrites).toEqual([{ path: path, content: content }]);
    expect(t.fs.get(path)).toBe(content);
    expect(t.pushed).toEqual(["srv-0"]);
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
    // The content-created file owes exactly one watcher echo.
    expect(t.reg.consumeMaterialized(path)).toBe(true);
    expect(t.reg.consumeMaterialized(path)).toBe(false);
    // The store now knows the doc, so the next `hello` names it.
    expect(t.store.knownDocs()).toContain("srv-0");

    // The window closing later writes nothing: no 0-byte file ever existed.
    await t.fireTimer();
    expect(placeholders()).toEqual([]);
    expect(t.fs.get(path)).toBe(content);
  });

  it("confirming server content does not strand a new empty note before its file arrives", async () => {
    const t = setup(serverOnly(1));
    await t.pull();
    // A concurrent content run can confirm an empty Y.Doc without writing a
    // file: flushEgest has no text change to flush. Server confirmation must
    // not cancel the receiving side's still-owed file creation.
    const uploader = new ContentUploader({
      vaultId: VAULT,
      notes: [{ docId: "srv-0", relPath: "Remote/N0.md" }],
      isPushed: (id) => t.reg.isPushed(id),
      markPushed: (id) => t.reg.markPushed(id),
      deps: {
        acquire: (id, path) => t.store.promote(id, path, { seedFromFile: false, pin: true }),
        release: (id) => t.store.demote(id),
        readFile: (path) => t.fs.readFile(path),
        connect: ({ doc }) => ({
          isSynced: true,
          readOnly: false,
          whenSynced: async () => { Y.applyUpdate(doc, serverState(""), "remote"); },
          whenFlushed: async () => true,
          destroy: () => {},
        }),
      },
    });
    await uploader.run();
    expect(uploader.failedDocs()).toEqual([]);
    expect(t.reg.isPushed("srv-0")).toBe(true);
    expect(t.fs.get("Remote/N0.md")).toBeUndefined();
    await t.fireTimer();
    expect(placeholders()).toEqual(["Remote/N0.md"]);
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
    expect(reconcileReport.items()).toEqual([]);
  });

  it("another registry event while a new file is arriving never reports a deletion", async () => {
    const t = setup(serverOnly(1));
    await t.pull();
    // A folder create / reauth can request another pull before backfill or the
    // arrival deadline. Mapped-but-not-created is not deleted from this device.
    await t.reg.pull();
    await t.fireTimer();
    expect(placeholders()).toEqual(["Remote/N0.md"]);
    expect(reconcileReport.items()).toEqual([]);
    expect(t.reg.lastPassDrift()?.missingMapped).toBe(0);
  });

  it("still reports a real removal after the arriving file was created", async () => {
    const t = setup(serverOnly(1));
    await t.pull();
    await t.store.applyUpdate("srv-0", serverState("arrived"));
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
    // The next full disk listing is empty, representing an actual removal
    // AFTER arrival rather than a file we have not written yet.
    await t.reg.pull();
    expect(reconcileReport.items().map((item) => item.kind)).toEqual(["restoredFromServer"]);
  });

  it("a 10-note grant is created with content, never as placeholders", async () => {
    const t = setup(serverOnly(10));
    await t.pull();
    expect(placeholders()).toEqual([]);
    expect(t.reg.pendingFromBootstrapCount()).toBe(10);

    for (let i = 0; i < 10; i++) await t.store.applyUpdate(`srv-${i}`, serverState(`note ${i}`));

    expect(t.contentWrites).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(t.fs.get(`Remote/N${i}.md`)).toBe(`note ${i}`);
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
    await t.fireTimer();
    expect(placeholders()).toEqual([]);
  });

  it("a doc the server holds no state for still gets its placeholder immediately", async () => {
    const t = setup(serverOnly(3), { serverEmpty: new Set(["srv-1"]) });
    await t.pull();

    expect(placeholders()).toEqual(["Remote/N1.md"]);
    expect(t.reg.pendingFromBootstrapCount()).toBe(2);
    expect(t.reg.deferredPathFor("srv-1")).toBeNull();
  });

  it("content that never arrives gets its placeholder when the 2 s window closes", async () => {
    const t = setup(serverOnly(2));
    await t.pull();
    await t.store.applyUpdate("srv-0", serverState("arrived"));
    expect(placeholders()).toEqual([]);

    expect(t.timerMs()).toBe(2000);
    await t.fireTimer();

    expect(placeholders()).toEqual(["Remote/N1.md"]);
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
    expect(t.reg.consumeMaterialized("Remote/N1.md")).toBe(true);
  });

  it("a vault-channel drop flushes the deferred placeholders at once", async () => {
    const t = setup(serverOnly(2));
    await t.pull();
    expect(t.flush.armed()).toBe(true);

    t.flush.flushNow();
    await new Promise((r) => setTimeout(r, 0));

    expect(new Set(placeholders())).toEqual(new Set(["Remote/N0.md", "Remote/N1.md"]));
    expect(t.flush.armed()).toBe(false);
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
  });

  it("a doc this device holds a local CRDT for keeps today's placeholder + materializeContent", async () => {
    const t = setup(serverOnly(2), { held: new Set(["srv-0"]) });
    await t.pull();

    expect(placeholders()).toEqual(["Remote/N0.md"]);
    expect(t.materializedContent).toEqual(["srv-0"]);
    expect(t.reg.deferredPathFor("srv-0")).toBeNull();
    expect(t.reg.deferredPathFor("srv-1")).toBe("Remote/N1.md");
  });

  it("no live channel: placeholders as before, no wait armed", async () => {
    for (const state of [{ channelSynced: false }, { live: false }, { serverTooOld: true }, { liveOnly: true }]) {
      vi.mocked(ipc.writeNoteIfMissing).mockClear();
      const t = setup(serverOnly(1), state);
      await t.pull();
      expect(placeholders()).toEqual(["Remote/N0.md"]);
      expect(t.flush.armed()).toBe(false);
    }
  });

  it("an increment with missing dependencies is not a full state: ordinary cold apply", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "base");
    const sv = Y.encodeStateVector(doc);
    doc.getText("content").insert(4, " more");
    const increment = Y.encodeStateAsUpdate(doc, sv);
    doc.destroy();

    expect(fullStateEntry("d", "a.md", increment)).toBeNull();
    expect(fullStateEntry("d", "a.md", serverState("whole"))?.content).toBe("whole");
    const applyBatch = vi.fn();
    expect(
      await createDeferredWithContent(
        { deferredPathFor: () => "a.md", applyBatch, markMaterialized: vi.fn(), markPushed: vi.fn() },
        "d",
        "a.md",
        increment,
      ),
    ).toBeNull();
    expect(applyBatch).not.toHaveBeenCalled();
  });
});

describe("the placeholder flush waits for a running pull", () => {
  // A teammate's note created, renamed and deleted within ~2 s: the 2 s flush
  // resolved the note's path while the pull carrying the delete was running,
  // the pull found no file to remove, then the flush wrote an empty file at
  // the old name that stayed until the next pass.
  it("a note the running pull deletes gets no empty file at its old name", async () => {
    const t = setup(serverOnly(1));
    await t.pull();
    expect(t.reg.pendingFromBootstrapCount()).toBe(1);
    const api = (t.reg as unknown as { api: ApiClient }).api;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(api.listNoteRegistryPaged).mockImplementationOnce(async () => {
      await gate;
      return { notes: [], tombstones: ["srv-0"] } as never;
    });
    const pulling = t.reg.pull();
    await new Promise((r) => setTimeout(r, 0));
    const flushing = t.reg.materializePendingFromBootstrap();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await pulling;
    await flushing;
    expect(placeholders()).toEqual([]);
    expect(t.fs.get("Remote/N0.md")).toBeUndefined();
    expect(t.reg.pendingFromBootstrapCount()).toBe(0);
  });

  it("with no pull running the flush still writes the placeholder", async () => {
    const t = setup(serverOnly(1));
    await t.pull();
    await t.reg.materializePendingFromBootstrap();
    expect(placeholders()).toEqual(["Remote/N0.md"]);
  });
});
