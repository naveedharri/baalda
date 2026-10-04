// One-step creates (plan "one-step-note-sync", PR3): the merge half.
//
// A `conflict` on our own id, or an adopt onto ANOTHER id, means the server
// already holds text this device has not seen. `SyncManager.httpMergeOnce`
// then: releases (awaited) and clears the local CRDT, opens a fresh bridge,
// applies the server's state pulled over `bootstrap` `only`, runs
// `mergeFileAfterPull`, flushes the egest, and only then pushes through
// docs/batch. Pinned here, at the bridge level that decides doubling:
//
//   * adopt / conflict onto a non-empty server doc: the server's text appears
//     EXACTLY once; the local file's text appears at most once in the doc and,
//     when it is not in the doc, survives as a recovery copy (no base exists
//     between two independent creates, so it is never re-inserted whole);
//   * merging the result back into the server changes nothing (no doubling);
//   * a no-local-CRDT seed built on a throwaway doc, applied locally after the
//     server's answer, and then pulled again from the server does not double;
//   * `covered` on a retry applies nothing new; a REBUILT throwaway (new client
//     id) is not covered, so it goes to the merge instead of being applied;
//   * the file's bytes after the merge equal the doc's text;
//   * registry: conflict/adopt never call `noteSeeded` and never mark pushed;
//     an adopt onto another id rebinds the index row to the winner BEFORE the
//     merge is announced, and hands the loser id over for release.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  // The production `saveRecoveryCopy` (bridge/adapter.ts) writes through this.
  writeTrashCopy: vi.fn(
    async (path: string, stamp: string) => `.context/trash/${stamp}/${path}`,
  ),
  materializeNotesBatch: vi.fn(
    async (items: Array<{ relPath: string; docId: string | null }>) =>
      items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  ),
  isVaultMismatch: (e: unknown) =>
    e instanceof Error && e.message.startsWith("vault-mismatch"),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import * as Y from "yjs";
import type { ApiClient } from "../../api";
import { NoteBridge } from "../../bridge/noteBridge";
import { makeHarness, type Harness } from "../../bridge/__tests__/helpers";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import type { NoteBatchItem, NoteBatchResult } from "../bulkTypes";
import { mergeFileAfterPull } from "../contentUpload";
import { VaultRegistry, type InboundHost, type NoteSeedState } from "../registry";
import { base64ToBytes, classifySeedResult } from "../seedRegister";
import { bytesToBase64 } from "../vaultProtocol";
import { reconcileWithTree } from "./helpers/reconcile";
import { createTauriBridgeIO } from "../../bridge/adapter";
import { attributeRecoveryCopies, reconcileReport } from "../reconcileReport";

const PATH = "Note0.md";
const ORG = "org-1";
const VAULT = "v-1";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A teammate's server doc, built under its own client id. */
function serverDoc(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}

function withRecovery(h: Harness): string[] {
  const copies: string[] = [];
  (h.io as { saveRecoveryCopy?: (p: string, c: string) => Promise<string | null> }).saveRecoveryCopy = async (_p: string, content: string) => {
    copies.push(content);
    return `.context/trash/${copies.length}`;
  };
  return copies;
}

/** The persisted-state clear `ipc.clearYjsDoc` performs (log + snapshot + disk base). */
function clearLocal(h: Harness, docId: string): void {
  (h.persistence as unknown as { docs: Map<string, unknown> }).docs.delete(docId);
  h.persistence.diskBases.delete(docId);
}

/**
 * Exactly the bridge steps of `httpMergeOnce` for one doc, after the local
 * CRDT has been released and cleared.
 */
async function httpMerge(h: Harness, docId: string, serverState: Uint8Array): Promise<NoteBridge> {
  const bridge = await NoteBridge.open(h.io, { docId, path: PATH, seedFromFile: false });
  if (serverState.byteLength > 0) bridge.applyRemote(serverState);
  await mergeFileAfterPull(bridge, { ingestFromFile: true, preIngested: false });
  await bridge.flushEgest();
  await bridge.whenPersisted();
  return bridge;
}

function assertNoDoubling(bridge: NoteBridge, server: Y.Doc, serverText: string, fileText: string, copies: string[]) {
  const text = bridge.serialize();
  // The server's text survives, once.
  expect(count(text, serverText.trim())).toBe(1);
  // The local text is never re-inserted as a whole a second time…
  const local = fileText.replace(serverText, "").trim();
  if (local) {
    expect(count(text, local)).toBeLessThanOrEqual(1);
    // …and when it is not in the doc, it is not lost either.
    if (count(text, local) === 0) expect(copies.some((c) => c.includes(local))).toBe(true);
  }
  // Pushing the merged state (docs/batch, no expectEmpty) doubles nothing.
  const before = server.getText("content").toString();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(bridge.doc));
  const after = server.getText("content").toString();
  expect(after).toBe(text);
  expect(count(after, before.trim())).toBe(1);
}

describe("HTTP merge after adopt / conflict", () => {
  it("adopt onto a non-empty winner doc: server text once, local text never doubled", async () => {
    const serverText = "# Plan\nTeam line\n";
    const fileText = "# Plan\nMy line\n";
    const server = serverDoc(serverText);
    const h = makeHarness({ [PATH]: fileText });
    const copies = withRecovery(h);

    // The loser id's local CRDT exists but is never touched by the winner's merge.
    const loser = await NoteBridge.open(h.io, { docId: "loser", path: PATH, seedFromFile: true });
    await loser.flushEgest();
    await loser.whenPersisted();
    loser.destroy();

    const b = await httpMerge(h, "winner", Y.encodeStateAsUpdate(server));
    assertNoDoubling(b, server, serverText, fileText, copies);
    // The file on disk is the doc's text (bridge egest).
    expect(h.fs.get(PATH)).toBe(b.serialize());
    b.destroy();
  });

  it("conflict on the same id: local CRDT released + cleared, then merged without doubling", async () => {
    const serverText = "Shared body\n";
    const fileText = "Shared body\nLocal addition\n";
    const server = serverDoc(serverText);
    const h = makeHarness({ [PATH]: fileText });
    const copies = withRecovery(h);

    // This device built its own ops for the same text (independent client id):
    // exactly what must never be merged into the server doc.
    const old = await NoteBridge.open(h.io, { docId: "d", path: PATH, seedFromFile: true });
    expect(old.serialize()).toBe(fileText);
    // `store.release`: flush + persist, THEN clear — never the other way round.
    await old.flushEgest();
    await old.whenPersisted();
    old.destroy();
    clearLocal(h, "d");

    const b = await httpMerge(h, "d", Y.encodeStateAsUpdate(server));
    assertNoDoubling(b, server, serverText, fileText, copies);
    expect(h.fs.get(PATH)).toBe(b.serialize());
    // The reopened doc holds only the server's history plus the merge: a fresh
    // bridge hydrating it shows the same text (nothing stale re-persisted).
    const again = await NoteBridge.open(h.io, { docId: "d", path: PATH, seedFromFile: false });
    expect(again.serialize()).toBe(b.serialize());
    again.destroy();
    b.destroy();
  });

  it("a server that omits the doc (empty update) seeds the file once", async () => {
    const fileText = "Only here\n";
    const h = makeHarness({ [PATH]: fileText });
    const b = await httpMerge(h, "d", new Uint8Array());
    expect(b.serialize()).toBe(fileText);
    expect(h.fs.get(PATH)).toBe(fileText);
    b.destroy();
  });
});

describe("one-step seed with no local CRDT", () => {
  it("throwaway seed applied after the answer, then a pull of the same ops: no doubling", async () => {
    const fileText = "Fresh note\nwith two lines\n";
    const h = makeHarness({ [PATH]: fileText });

    // buildNoteState: a THROWAWAY doc from the file.
    const tmp = new Y.Doc();
    tmp.getText("content").insert(0, fileText);
    const seed = Y.encodeStateAsUpdate(tmp);
    tmp.destroy();

    // The server applies it (expectEmpty) and a teammate edits on top.
    const server = new Y.Doc();
    Y.applyUpdate(server, seed);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, seed);
    peer.getText("content").insert(fileText.length, "peer line\n");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(peer));

    // noteSeeded: the live local doc gets the SAME ops (not a re-seed from text).
    const b = await NoteBridge.open(h.io, { docId: "d", path: PATH, seedFromFile: false });
    expect(b.serialize()).toBe("");
    b.applyRemote(seed);
    expect(b.serialize()).toBe(fileText);

    // A later pull of everything the server holds.
    b.applyRemote(Y.encodeStateAsUpdate(server));
    b.applyRemote(Y.encodeStateAsUpdate(server)); // and again: idempotent
    expect(b.serialize()).toBe(`${fileText}peer line\n`);
    expect(count(b.serialize(), "Fresh note")).toBe(1);
    await b.flushEgest();
    expect(h.fs.get(PATH)).toBe(b.serialize());
    b.destroy();
  });
});

describe("retry after a lost response", () => {
  it("`covered` re-applies nothing new", () => {
    const tmp = new Y.Doc();
    tmp.getText("content").insert(0, "Body\n");
    const seed = Y.encodeStateAsUpdate(tmp);
    tmp.destroy();
    const sv = bytesToBase64(Y.encodeStateVectorFromUpdate(seed));
    expect(classifySeedResult("adopted", { seeded: true, content: "covered", sv }, true, true)).toBe("seeded");

    const local = new Y.Doc();
    Y.applyUpdate(local, seed);
    const svBefore = Y.encodeStateVector(local);
    Y.applyUpdate(local, seed); // noteSeeded on the retry: the SAME bytes
    expect(local.getText("content").toString()).toBe("Body\n");
    expect(Y.encodeStateVector(local)).toEqual(svBefore);
    expect(base64ToBytes(sv)).toEqual(Y.encodeStateVectorFromUpdate(seed));
  });

  it("a REBUILT throwaway (new client id) is not covered and is merged, never applied", () => {
    const build = () => {
      const d = new Y.Doc();
      d.getText("content").insert(0, "Body\n");
      const u = Y.encodeStateAsUpdate(d);
      d.destroy();
      return u;
    };
    const first = build();
    const second = build();
    // The server's covered rule (`serverStateCovers`): every client clock of
    // the submitted state is already in the server's state vector.
    const server = new Y.Doc();
    Y.applyUpdate(server, first);
    const serverSv = Y.decodeStateVector(Y.encodeStateVector(server));
    const covers = (u: Uint8Array) =>
      [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(u))].every(
        ([client, clock]) => (serverSv.get(client) ?? 0) >= clock,
      );
    expect(covers(first)).toBe(true);
    expect(covers(second)).toBe(false);
    // Not covered + the doc holds text ⇒ `conflict` ⇒ merge, not `seeded`.
    expect(classifySeedResult("adopted", { seeded: false, content: "conflict" }, true, true)).toBe("merge");
  });
});

// ---- registry side ---------------------------------------------------------

function tree(): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: [{ id: "n0", name: PATH, path: PATH, isDir: false }],
  };
}

function fakeApi(answer: (item: NoteBatchItem) => Partial<NoteBatchResult>) {
  return {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createNote: vi.fn(async () => {
      throw new Error("one-step creates never use the per-note route");
    }),
    batchCreateNotes: vi.fn(async (_v: string, items: NoteBatchItem[]) =>
      items.map((i) => ({
        relPath: i.relPath,
        docId: i.docId ?? "srv",
        status: "created",
        folderId: null,
        title: null,
        code: null,
        error: null,
        ...answer(i),
      })),
    ),
  } as unknown as ApiClient;
}

function fakeHost() {
  const order: string[] = [];
  const seeded: string[] = [];
  const merged: Array<{ ids: readonly string[]; losers: readonly string[] }> = [];
  const host: InboundHost = {
    serverFeatures: async () => new Set(["notes-with-state", "bootstrap-only"]),
    buildNoteState: async (): Promise<NoteSeedState> => {
      const d = new Y.Doc();
      d.getText("content").insert(0, "# local");
      const state = Y.encodeStateAsUpdate(d);
      d.destroy();
      return { state, textSha256: "x", fresh: true };
    },
    noteSeeded: async (docId: string) => {
      seeded.push(docId);
    },
    noteNeedsMerge: (ids: readonly string[], losers: readonly string[] = []) => {
      order.push("merge");
      merged.push({ ids, losers });
    },
    noteServerCreated: () => {},
  } as unknown as InboundHost;
  return { host, seeded, merged, order };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([{ id: "loc-0", path: PATH, title: "Note0" }]);
});

describe("registry: merge outcomes are never settled as pushed", () => {
  it("adopt onto another id: rebind before the merge, loser handed over, not pushed", async () => {
    const h = fakeHost();
    vi.mocked(ipc.rebindNoteId).mockImplementation(async () => {
      h.order.push("rebind");
      return true;
    });
    const reg = new VaultRegistry(
      fakeApi(() => ({ status: "adopted", docId: "winner", seeded: false, content: "skipped" })),
    );
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree());

    expect(ipc.rebindNoteId).toHaveBeenCalledWith(PATH, "winner", expect.anything());
    expect(h.order).toEqual(["rebind", "merge"]);
    expect(h.merged).toEqual([{ ids: ["winner"], losers: ["loc-0"] }]);
    expect(h.seeded).toEqual([]);
    expect(reg.isPushed("winner")).toBe(false);
    expect(reg.isPushed("loc-0")).toBe(false);
  });

  it("conflict on the same id: merge, no rebind, not pushed", async () => {
    const h = fakeHost();
    const reg = new VaultRegistry(
      fakeApi((i) => ({ status: "adopted", docId: i.docId!, seeded: false, content: "conflict" })),
    );
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree());

    expect(ipc.rebindNoteId).not.toHaveBeenCalled();
    expect(h.merged).toEqual([{ ids: ["loc-0"], losers: [] }]);
    expect(h.seeded).toEqual([]);
    expect(reg.isPushed("loc-0")).toBe(false);
  });
});

// The decided outcome (2026-10-04): when the server holds DIFFERENT text, its
// text wins and the local text goes to `.context/trash`. That copy must be
// visible exactly once, as `conflictKeptServer`, through the production
// `saveRecoveryCopy` (adapter.ts) and the claim `httpMergeOnce` takes around
// the fresh bridge. A clean adopt reports nothing.
describe("HTTP merge: the kept-server conflict is reported", () => {
  /** The harness, with the PRODUCTION recovery-copy writer (it records). */
  function prodRecovery(h: Harness): void {
    (h.io as { saveRecoveryCopy?: (p: string, c: string) => Promise<string | null> }).saveRecoveryCopy =
      createTauriBridgeIO().saveRecoveryCopy;
  }

  /** `httpMergeOnce`'s per-doc block: claim the path, merge, release the claim. */
  async function claimedMerge(h: Harness, docId: string, serverState: Uint8Array): Promise<NoteBridge> {
    const unclaim = attributeRecoveryCopies(PATH, { kind: "conflictKeptServer", docId });
    try {
      return await httpMerge(h, docId, serverState);
    } finally {
      unclaim();
    }
  }

  beforeEach(() => {
    reconcileReport.clear();
  });

  it("differing text: exactly one entry, with the recovery path and the doc id", async () => {
    const serverText = "# Plan\nTeam line\n";
    const fileText = "# Plan\nMy line\n";
    const h = makeHarness({ [PATH]: fileText });
    prodRecovery(h);

    const b = await claimedMerge(h, "winner", Y.encodeStateAsUpdate(serverDoc(serverText)));
    expect(b.serialize()).toBe(serverText);
    expect(h.fs.get(PATH)).toBe(serverText);

    const items = reconcileReport.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "conflictKeptServer", docId: "winner", path: PATH });
    expect(items[0].detail).toMatch(/^\.context\/trash\/.+\/Note0\.md$/);
    // The copy holds the local text that lost.
    const calls = vi.mocked(ipc.writeTrashCopy).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe(fileText);
    b.destroy();
  });

  it("identical text: a clean adopt records nothing and writes no copy", async () => {
    const text = "Same on both sides\n";
    const h = makeHarness({ [PATH]: text });
    prodRecovery(h);

    const b = await claimedMerge(h, "winner", Y.encodeStateAsUpdate(serverDoc(text)));
    expect(b.serialize()).toBe(text);
    expect(reconcileReport.items()).toEqual([]);
    expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
    b.destroy();
  });

  it("empty local file: nothing to keep, nothing reported", async () => {
    const h = makeHarness({ [PATH]: "" });
    prodRecovery(h);

    const b = await claimedMerge(h, "winner", Y.encodeStateAsUpdate(serverDoc("Team text\n")));
    expect(b.serialize()).toBe("Team text\n");
    expect(reconcileReport.items()).toEqual([]);
    expect(ipc.writeTrashCopy).not.toHaveBeenCalled();
    b.destroy();
  });

  it("without a claim the same copy stays the generic external-edit entry", async () => {
    const h = makeHarness({ [PATH]: "Mine\n" });
    prodRecovery(h);

    const b = await httpMerge(h, "winner", Y.encodeStateAsUpdate(serverDoc("Theirs\n")));
    const items = reconcileReport.items();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("externalEditSaved");
    b.destroy();
  });
});
