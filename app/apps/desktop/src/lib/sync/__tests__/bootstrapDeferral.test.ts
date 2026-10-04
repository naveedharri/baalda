// PR4: receiving side without placeholders.
//
// A fresh device joining a big vault used to write one 0-byte placeholder per
// server-only note (20,000 files for a 20,000-note vault) and show the whole
// tree empty until the bootstrap download filled it. Now a pull that knows a
// bootstrap download follows DEFERS those notes: `apply_bootstrap_batch`
// creates each file with its content, create-only, and only the notes the
// download did not deliver (server-empty docs, an interrupted run) get a
// batched placeholder afterwards.
//
// Rust-side guarantees this relies on are pinned elsewhere:
//   - `write_note_if_absent_or_empty` writes only over a missing or 0-byte file
//     and answers `conflict` for differing content (notefile.rs tests,
//     `bootstrapApply.test.ts`);
//   - `materialize_notes_batch` is create-only (notefile.rs
//     `write_note_if_missing_creates_but_never_overwrites`).

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

import type { ApiClient, RegisteredNote } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";
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

/**
 * A host whose `bootstrapWillDeliver` answers like the SyncManager's: `null`
 * when no download follows, else "delivered unless this device holds CRDT".
 */
function host(opts: { follows: boolean; heldLocally?: Set<string> }) {
  const materializedContent: string[] = [];
  const h: InboundHost = {
    releaseDoc: async () => {},
    notePathChanged: () => {},
    noteRemoved: () => {},
    materializeContent: async (docId) => {
      materializedContent.push(docId);
      return true;
    },
    bootstrapWillDeliver: () =>
      opts.follows ? (docId: string) => !(opts.heldLocally ?? new Set()).has(docId) : null,
  };
  return { h, materializedContent };
}

const batchedPaths = () =>
  vi.mocked(ipc.materializeNotesBatch).mock.calls.flatMap((c) => c[0].map((i) => i.relPath));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.materializeNotesBatch).mockImplementation(async (items) =>
    items.map((i) => ({ relPath: i.relPath, created: true, rebound: true })),
  );
});

describe("PR4 — no placeholders for notes a bootstrap download will create", () => {
  it("writes NO placeholder for docs with pending bootstrap content", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    reg.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    expect(ipc.materializeNotesBatch).not.toHaveBeenCalled();
    expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
    expect(reg.pendingFromBootstrapCount()).toBe(30);
    // Nothing was written, so no watcher echo is owed for any of them.
    expect(reg.consumeMaterialized("Remote/N0.md")).toBe(false);
  });

  it("keeps placeholders when no bootstrap follows (today's behaviour)", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    reg.setInboundHost(host({ follows: false }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    expect(batchedPaths()).toHaveLength(30);
    expect(reg.pendingFromBootstrapCount()).toBe(0);
  });

  it("a small delta (one live note) keeps the sub-second placeholder", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(1)));
    reg.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    expect(vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0])).toEqual(["Remote/N0.md"]);
    expect(reg.pendingFromBootstrapCount()).toBe(0);
  });

  it("docs this device holds CRDT for keep the placeholder + materializeContent", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    const { h, materializedContent } = host({ follows: true, heldLocally: new Set(["srv-3"]) });
    reg.setInboundHost(h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    expect(batchedPaths()).toEqual(["Remote/N3.md"]);
    expect(materializedContent).toEqual(["srv-3"]);
    expect(reg.pendingFromBootstrapCount()).toBe(29);
  });

  it("bootstrap-created paths are covered by consumeMaterialized and leave the pending set", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    reg.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    // What `BootstrapRunner` does for a `written` outcome.
    reg.markPushed("srv-5");
    reg.markMaterialized("Remote/N5.md");

    expect(reg.consumeMaterialized("Remote/N5.md")).toBe(true);
    expect(reg.consumeMaterialized("Remote/N5.md")).toBe(false);
    expect(reg.pendingFromBootstrapCount()).toBe(29);
  });

  it("server-empty docs the download did not deliver get ONE batched placeholder write", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    reg.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());

    // The download delivered everything except N7 and N8 (the server holds no
    // state for them: its `emptyDocs`).
    for (let i = 0; i < 30; i++) {
      if (i === 7 || i === 8) continue;
      reg.markPushed(`srv-${i}`);
      reg.markMaterialized(`Remote/N${i}.md`);
    }
    vi.mocked(ipc.materializeNotesBatch).mockClear();
    expect(await reg.materializePendingFromBootstrap()).toBe(true);

    const calls = vi.mocked(ipc.materializeNotesBatch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual([
      { relPath: "Remote/N7.md", docId: "srv-7" },
      { relPath: "Remote/N8.md", docId: "srv-8" },
    ]);
    expect(reg.consumeMaterialized("Remote/N7.md")).toBe(true);
    expect(reg.pendingFromBootstrapCount()).toBe(0);
    // A second flush is free.
    expect(await reg.materializePendingFromBootstrap()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  // Simulates page 1 (N0..N9) landing before a kill, then a second launch whose
  // pull sees the rest of `total` server-only notes missing from disk.
  async function relaunchAfterPage1(total: number): Promise<void> {
    const api = fakeApi(serverOnly(total));
    const first = new VaultRegistry(api);
    first.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(first, { organizationId: ORG, vaultName: "v" }, emptyTree());
    // Page 1 landed (N0..N9), then the app was killed: nothing persisted the
    // deferred set as done.
    for (let i = 0; i < 10; i++) first.markMaterialized(`Remote/N${i}.md`);
    expect(first.pendingFromBootstrapCount()).toBe(total - 10);

    // Next launch, no download resumes: the disk still lacks the rest, so the
    // pull writes their placeholders (lazy hydrate on open fills them).
    vi.mocked(ipc.materializeNotesBatch).mockClear();
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    const diskAfterPage1: TreeNode = {
      ...emptyTree(),
      children: [
        { id: "Remote", name: "Remote", path: "Remote", isDir: true, children: Array.from({ length: 10 }, (_, i) => ({
          id: `n${i}`, name: `N${i}.md`, path: `Remote/N${i}.md`, isDir: false,
        })) },
      ],
    };
    const second = new VaultRegistry(api);
    second.setInboundHost(host({ follows: false }).h);
    await reconcileWithTree(second, { organizationId: ORG, vaultName: "v" }, diskAfterPage1);
  }

  it("an interrupted bootstrap re-materializes the missing notes on the next pull", async () => {
    // 30 missing notes: at/above BULK_THRESHOLD_DOCS, so the batched IPC runs.
    await relaunchAfterPage1(40);
    expect(new Set(batchedPaths())).toEqual(
      new Set(Array.from({ length: 30 }, (_, i) => `Remote/N${i + 10}.md`)),
    );
  });

  it("below the bulk threshold the re-materialize uses the per-note write", async () => {
    // 20 missing notes: under BULK_THRESHOLD_DOCS, so no batched IPC.
    await relaunchAfterPage1(30);
    expect(batchedPaths()).toEqual([]);
    const written = vi.mocked(ipc.writeNoteIfMissing).mock.calls.map((c) => c[0]);
    expect(new Set(written)).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `Remote/N${i + 10}.md`)),
    );
  });

  it("a deferred note renamed before the flush gets its placeholder at the NEW path", async () => {
    const reg = new VaultRegistry(fakeApi(serverOnly(30)));
    reg.setInboundHost(host({ follows: true }).h);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, emptyTree());
    for (let i = 1; i < 30; i++) reg.markMaterialized(`Remote/N${i}.md`);
    const pathSpy = vi.spyOn(reg, "pathForDocId").mockImplementation((id) =>
      id === "srv-0" ? "Moved/N0.md" : null,
    );
    vi.mocked(ipc.materializeNotesBatch).mockClear();

    await reg.materializePendingFromBootstrap();

    expect(batchedPaths()).toEqual(["Moved/N0.md"]);
    pathSpy.mockRestore();
  });
});
