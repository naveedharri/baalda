// An in-app rename re-points the open note as soon as the disk move lands,
// BEFORE the server PATCH resolves. The watcher reports the old path as
// `removed` ~150ms after the move; while a slow PATCH was still in flight the
// open note sat on a vanished path and flashed the "was removed" banner.
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `tabStore.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const authManager = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  init: vi.fn(async () => null as unknown),
  currentSession: vi.fn(async () => null as unknown),
  signOut: vi.fn(async () => {}),
  getServerUrl: () => "http://localhost:3010",
}));

vi.mock("../lib/auth/authManager", () => ({ authManager, api: {} }));

/** The PATCH, held open until the test releases it. */
const patch = vi.hoisted(() => ({
  release: (() => {}) as (ok: boolean) => void,
}));

const sync = vi.hoisted(() => ({
  registry: {
    vaultId: null as string | null,
    getMapping: () => null,
    registerNote: vi.fn(async () => null),
    renamePath: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          patch.release = (ok) => (ok ? resolve() : reject(new Error("boom")));
        }),
    ),
  },
  isSyncable: vi.fn(() => false),
  disable: vi.fn(),
  setViewing: vi.fn(),
  handleRegistryChanged: vi.fn(),
  willSync: vi.fn(() => false),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

vi.mock("../lib/bridge", () => ({
  bridgeManager: { currentBridge: () => null },
}));

const ipcMock = vi.hoisted(() => ({
  isVaultMismatch: () => false,
  peekVaultStamp: vi.fn(async () => null),
  getNoteMeta: vi.fn(async (path: string) => ({ path, id: `local-${path}`, title: path })),
  getBacklinks: vi.fn(async () => []),
  listChildren: vi.fn(async () => []),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  clearLastVault: vi.fn(async () => {}),
  getVaultEpoch: vi.fn(async () => 1),
  renamePath: vi.fn(async () => {}),
}));

vi.mock("../lib/ipc", () => ipcMock);

import { useStore } from "../store";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    openNote: null,
    openTabs: [],
    noteRemoved: false,
    vault: null,
    tree: null,
  });
});

describe("renameNoteFileExact", () => {
  it("re-points the open note before the server rename resolves", async () => {
    await useStore.getState().openNoteByPath("a.md");
    expect(useStore.getState().openNote?.path).toBe("a.md");

    const done = useStore.getState().renameNoteFileExact("a.md", "b.md");
    await flush();
    // The PATCH is still pending, and the note already follows the move.
    expect(sync.registry.renamePath).toHaveBeenCalledWith("a.md", "b.md");
    expect(useStore.getState().openNote?.path).toBe("b.md");
    expect(useStore.getState().openTabs).toEqual(["b.md"]);
    expect(useStore.getState().noteRemoved).toBe(false);

    patch.release(true);
    await expect(done).resolves.toBe(true);
    expect(useStore.getState().openNote?.path).toBe("b.md");
  });

  it("keeps the disk rename and the new path when the PATCH fails", async () => {
    await useStore.getState().openNoteByPath("a.md");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const done = useStore.getState().renameNoteFileExact("a.md", "b.md");
    await flush();
    patch.release(false);
    await expect(done).resolves.toBe(true);
    expect(useStore.getState().openNote?.path).toBe("b.md");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
