// One-step creates (plan "one-step-note-sync", PR3): a server advertising
// `notes-with-state` gets every new note's Yjs state WITH its registration.
//
// Pinned here:
//   * 1 note and 24 notes: ONE `notes/batch` request each, no per-note
//     `POST /api/notes`, and no socket (the uploader is never involved —
//     settling happens from the HTTP answer through the host hooks).
//   * `applied`/`covered` ⇒ `noteSeeded` (markPushed + recordAck(sv)) — only
//     AFTER the response; a crash before it leaves the note unpushed.
//   * adopt onto ANOTHER id ⇒ mapped to the winner and handed to the HTTP merge,
//     never seeded / never announced as server-created.
//   * `conflict` ⇒ HTTP merge.
//   * old server (no `seeded` in the answer) ⇒ today's flow (`created` announce).
//   * chunking: 100 items / 4 MiB decoded; an item over 4 MiB goes alone.

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
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import type { NoteBatchItem, NoteBatchResult } from "../bulkTypes";
import { VaultRegistry, type InboundHost, type NoteSeedState } from "../registry";
import {
  base64ToBytes,
  classifySeedResult,
  packSeedChunks,
  SEED_BATCH_MAX_BYTES,
  SEED_BATCH_MAX_ITEMS,
} from "../seedRegister";
import { bytesToBase64 } from "../vaultProtocol";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";
const MiB = 1024 * 1024;

function tree(notes: number): TreeNode {
  const children: TreeNode[] = [];
  for (let i = 0; i < notes; i++) {
    children.push({ id: `n${i}`, name: `Note${i}.md`, path: `Note${i}.md`, isDir: false });
  }
  return { id: "root", name: "vault", path: "", isDir: true, children };
}

function stateFor(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

type Answer = (item: NoteBatchItem) => Partial<NoteBatchResult>;

/** A new server: answers `notes/batch` with the seed fields. */
function fakeApi(answer: Answer = () => ({})) {
  const calls = { createNote: 0, batchNotes: 0, sizes: [] as number[], items: [] as NoteBatchItem[] };
  const api = {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: VAULT, name: "v", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] })),
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [], tombstones: [] })),
    createNote: vi.fn(async (input: { relPath: string }) => {
      calls.createNote++;
      return { id: `srv-${input.relPath}`, rel_path: input.relPath, title: null };
    }),
    batchCreateNotes: vi.fn(async (_v: string, items: NoteBatchItem[]) => {
      calls.batchNotes++;
      calls.sizes.push(items.length);
      calls.items.push(...items);
      return items.map((i) => {
        const base: NoteBatchResult = {
          relPath: i.relPath,
          docId: i.docId ?? `srv-${i.relPath}`,
          status: "created",
          folderId: null,
          title: null,
          code: null,
          error: null,
        };
        const seeded = i.state
          ? {
              seeded: true,
              content: "applied" as const,
              sv: bytesToBase64(Y.encodeStateVectorFromUpdate(base64ToBytes(i.state)!)),
            }
          : {};
        return { ...base, ...seeded, ...answer(i) };
      });
    }),
  } as unknown as ApiClient;
  return { api, calls };
}

function fakeHost(features: string[] = ["notes-with-state", "bootstrap-only"], bytes?: (p: string) => number) {
  const seeded: Array<{ docId: string; sv: Uint8Array | null }> = [];
  const merged: string[] = [];
  const created: string[] = [];
  const host: InboundHost = {
    serverFeatures: async () => new Set(features),
    buildNoteState: async (_docId, relPath): Promise<NoteSeedState> => {
      const n = bytes?.(relPath);
      return {
        state: n ? new Uint8Array(n).fill(1) : stateFor(`# ${relPath}`),
        textSha256: "x",
        fresh: true,
      };
    },
    noteSeeded: async (docId, sv) => {
      seeded.push({ docId, sv });
    },
    noteNeedsMerge: (ids) => merged.push(...ids),
    noteServerCreated: (ids) => created.push(...ids),
  } as unknown as InboundHost;
  return { host, seeded, merged, created };
}

function localIds(n: number) {
  vi.mocked(ipc.listNoteTitles).mockResolvedValue(
    Array.from({ length: n }, (_, i) => ({ id: `loc-${i}`, path: `Note${i}.md`, title: `Note${i}` })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(true);
});

describe("one-step register + seed", () => {
  it("1 note: one request of one item, seeded, pushed + acked, no per-note create", async () => {
    localIds(1);
    const { api, calls } = fakeApi();
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1));

    expect(calls.createNote).toBe(0);
    expect(calls.batchNotes).toBe(1);
    expect(calls.items[0].state).toBeTruthy();
    expect(h.seeded).toHaveLength(1);
    expect(h.seeded[0].docId).toBe("loc-0");
    expect(h.seeded[0].sv).toBeInstanceOf(Uint8Array);
    expect(h.created).toEqual([]); // nothing left for the push phase / uploader
    expect(h.merged).toEqual([]);
  });

  it("24 notes go in ONE request with no per-note socket", async () => {
    localIds(24);
    const { api, calls } = fakeApi();
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(24));

    expect(calls.createNote).toBe(0);
    expect(calls.batchNotes).toBe(1);
    expect(calls.sizes).toEqual([24]);
    expect(h.seeded).toHaveLength(24);
    expect(h.created).toEqual([]);
  });

  it("250 notes ⇒ ceil(250/100) = 3 requests", async () => {
    localIds(250);
    const { api, calls } = fakeApi();
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(250));
    expect(calls.sizes).toEqual([100, 100, 50]);
    expect(h.seeded).toHaveLength(250);
  });

  it("covered on retry (adopted of our OWN id) settles as seeded", async () => {
    localIds(1);
    const { api } = fakeApi((i) => ({
      status: "adopted",
      docId: i.docId!,
      seeded: true,
      content: "covered",
    }));
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1));
    expect(h.seeded.map((s) => s.docId)).toEqual(["loc-0"]);
    expect(h.merged).toEqual([]);
  });

  it("does not mark pushed when the request fails (interrupted upload)", async () => {
    localIds(1);
    const { api } = fakeApi();
    vi.mocked(api.batchCreateNotes).mockRejectedValue(
      Object.assign(new Error("boom"), { status: 400 }),
    );
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1)).catch(() => {});
    expect(h.seeded).toEqual([]);
    expect(reg.isPushed("loc-0")).toBe(false);
  });
});

describe("adopt and conflict", () => {
  it("adopt onto another id rebinds to the winner and goes to the HTTP merge, never seeded", async () => {
    localIds(1);
    const { api } = fakeApi(() => ({
      status: "adopted",
      docId: "winner",
      seeded: false,
      content: "skipped",
      reason: "adopted",
      sv: undefined,
    }));
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1));
    expect(reg.getMapping("Note0.md")).toEqual({ vaultId: VAULT, docId: "winner" });
    expect(h.merged).toEqual(["winner"]);
    expect(h.seeded).toEqual([]);
    expect(h.created).toEqual([]); // an adopted row is never announced as empty
  });

  it("conflict on our own id goes through the pull-merge", async () => {
    localIds(1);
    const { api } = fakeApi(() => ({ seeded: false, content: "conflict", sv: undefined }));
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1));
    expect(h.merged).toEqual(["loc-0"]);
    expect(h.seeded).toEqual([]);
  });
});

describe("old servers", () => {
  it("no feature advertised: today's per-note path, no state sent", async () => {
    localIds(1);
    const { api, calls } = fakeApi();
    const h = fakeHost([]);
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(1));
    expect(calls.createNote).toBe(1);
    expect(calls.batchNotes).toBe(0);
    expect(h.seeded).toEqual([]);
  });

  it("feature advertised but answer lacks `seeded`: falls back to register-then-push", async () => {
    localIds(2);
    const { api } = fakeApi(() => ({ seeded: undefined, content: undefined, sv: undefined }));
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(2));
    expect(h.seeded).toEqual([]);
    expect(h.created.sort()).toEqual(["loc-0", "loc-1"]);
  });
});

describe("chunking", () => {
  it("packs at 100 items", () => {
    const items = Array.from({ length: 250 }, () => ({ stateBytes: 10 }));
    expect(packSeedChunks(items).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(SEED_BATCH_MAX_ITEMS).toBe(100);
  });

  it("packs at 4 MiB decoded", () => {
    const items = Array.from({ length: 5 }, () => ({ stateBytes: 1.5 * MiB }));
    // 1.5 + 1.5 = 3 MiB fits; a third would exceed 4 MiB.
    expect(packSeedChunks(items).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(SEED_BATCH_MAX_BYTES).toBe(4 * MiB);
  });

  it("an item over 4 MiB travels alone", () => {
    const items = [{ stateBytes: 10 }, { stateBytes: 6 * MiB }, { stateBytes: 10 }];
    const chunks = packSeedChunks(items);
    expect(chunks).toHaveLength(2);
    expect(chunks.find((c) => c.length === 1)?.[0].stateBytes).toBe(6 * MiB);
  });

  it("end to end: a 6 MiB note goes in its own request", async () => {
    localIds(3);
    const { api, calls } = fakeApi();
    const h = fakeHost(undefined, (p) => (p === "Note1.md" ? 6 * MiB : 0));
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(3));
    expect(calls.sizes.sort()).toEqual([1, 2]);
  });
});

describe("classifySeedResult", () => {
  it("maps every outcome", () => {
    expect(classifySeedResult("created", { seeded: true, content: "applied" }, true, true)).toBe("seeded");
    expect(classifySeedResult("adopted", { seeded: true, content: "covered" }, true, true)).toBe("seeded");
    expect(classifySeedResult("adopted", { seeded: false, content: "skipped" }, true, false)).toBe("merge");
    expect(classifySeedResult("adopted", { seeded: false, content: "conflict" }, true, true)).toBe("merge");
    expect(classifySeedResult("created", {}, true, true)).toBe("legacy");
    expect(classifySeedResult("created", { seeded: true, content: "applied" }, false, true)).toBe("legacy");
    expect(classifySeedResult("error", { seeded: false, content: "refused" }, true, true)).toBe("none");
  });
});

describe("eager single registerNote (note opened before the reconcile)", () => {
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  function eagerApi(extra: (input: { state?: string; docId?: string }) => Record<string, unknown>) {
    const sent: Array<{ relPath: string; state?: string; docId?: string }> = [];
    const { api } = fakeApi();
    (api as unknown as { createNote: unknown }).createNote = vi.fn(
      async (input: { relPath: string; state?: string; docId?: string }) => {
        sent.push(input);
        return {
          id: input.docId ?? `srv-${input.relPath}`,
          rel_path: input.relPath,
          title: null,
          created: true,
          ...extra(input),
        };
      },
    );
    return { api, sent };
  }

  it("sends the note's state and settles applied as pushed + acked", async () => {
    localIds(0);
    const { api, sent } = eagerApi((i) =>
      i.state
        ? {
            seeded: true,
            content: "applied",
            sv: bytesToBase64(Y.encodeStateVectorFromUpdate(base64ToBytes(i.state)!)),
          }
        : {},
    );
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0));

    const mapping = await reg.registerNote("Fresh.md", "Fresh", "loc-fresh");
    expect(mapping?.docId).toBe("loc-fresh");
    expect(sent).toHaveLength(1);
    expect(sent[0].state).toBeTruthy();
    expect(h.seeded).toHaveLength(1);
    expect(h.seeded[0].docId).toBe("loc-fresh");
    expect(h.seeded[0].sv).toBeInstanceOf(Uint8Array);
    expect(h.merged).toEqual([]);
  });

  it("conflict goes to the merge queue, never settled", async () => {
    localIds(0);
    const { api } = eagerApi(() => ({ seeded: false, content: "conflict" }));
    const h = fakeHost();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0));

    await reg.registerNote("Clash.md", "Clash", "loc-clash");
    expect(h.seeded).toEqual([]);
    expect(h.merged).toEqual(["loc-clash"]);
  });

  it("an empty note sends no state; an old server keeps today's flow", async () => {
    localIds(0);
    const { api, sent } = eagerApi(() => ({}));
    const h = fakeHost();
    (h.host as { buildNoteState: unknown }).buildNoteState = async (): Promise<NoteSeedState> => ({
      state: stateFor(""),
      textSha256: EMPTY,
      fresh: true,
    });
    const reg = new VaultRegistry(api);
    reg.setInboundHost(h.host);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree(0));
    await reg.registerNote("Empty.md", "Empty", "loc-empty");
    expect(sent[0].state).toBeUndefined();

    const old = eagerApi(() => ({}));
    const oldHost = fakeHost([]);
    const reg2 = new VaultRegistry(old.api);
    reg2.setInboundHost(oldHost.host);
    await reconcileWithTree(reg2, { organizationId: ORG, vaultName: "v" }, tree(0));
    await reg2.registerNote("Old.md", "Old", "loc-old");
    expect(old.sent[0].state).toBeUndefined();
    expect(oldHost.seeded).toEqual([]);
    expect(oldHost.merged).toEqual([]);
  });
});
