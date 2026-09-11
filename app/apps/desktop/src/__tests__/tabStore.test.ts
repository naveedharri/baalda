// The tab strip's contract, at the store level (the strip itself is a React
// component and this repo has no `@testing-library/react` — see
// docs/INTERACTIONS.md "Known gaps").
//
// Three things are pinned here:
//   1. `openTabs` keeps its order — a tab never moves once open, only the
//      highlight does — and `closeTab` lands on the neighbour;
//   2. `createNoteIn` names a new note `Untitled`, `Untitled 1`, … reveals its
//      row, and arms the note's own inline title (`pendingTitleFocus`);
//   3. a reveal is an EVENT: the same path requested twice must re-fire, which is
//      what `revealRequest.token` is for.
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `bootStore.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const authManager = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  init: vi.fn(async () => null as unknown),
  currentSession: vi.fn(async () => null as unknown),
  signOut: vi.fn(async () => {}),
  getServerUrl: () => "http://localhost:3010",
}));

vi.mock("../lib/auth/authManager", () => ({ authManager, api: {} }));

const sync = vi.hoisted(() => ({
  registry: {
    vaultId: null as string | null,
    getMapping: () => null,
    registerNote: vi.fn(async () => null),
  },
  isSyncable: vi.fn(() => false),
  disable: vi.fn(), // `adoptOpenedVault` → `leaveVaultSync`
  setViewing: vi.fn(),
  handleRegistryChanged: vi.fn(),
  willSync: vi.fn(() => false),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

vi.mock("../lib/bridge", () => ({
  bridgeManager: { currentBridge: () => null },
}));

/** Files the fake vault holds — `createNote` refuses a duplicate, like Rust. */
const existing = new Set<string>();

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
  createNote: vi.fn(async (dir: string, name: string) => {
    const path = dir === "" ? `${name}.md` : `${dir}/${name}.md`;
    if (existing.has(path)) throw new Error("a note with that name already exists");
    existing.add(path);
    return path;
  }),
}));

vi.mock("../lib/ipc", () => ipcMock);

import { useStore } from "../store";

const open = (path: string) => useStore.getState().openNoteByPath(path);

/** `closeTab` activates the survivor through an un-awaited `openNoteByPath`. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  existing.clear();
  useStore.setState({
    openNote: null,
    openTabs: [],
    openingNotePath: null,
    openFolderIsSynced: null,
    revealRequest: null,
    revealedPath: null,
    rootFrozen: false,
    syncEnabled: false,
    authStatus: "signed-out",
    session: null,
    vault: null,
    tree: null,
  });
});

describe("openTabs ordering", () => {
  it("appends new tabs and never moves an existing one when it is re-activated", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md");
    expect(useStore.getState().openTabs).toEqual(["a.md", "b.md", "c.md"]);

    await open("a.md");
    expect(useStore.getState().openTabs).toEqual(["a.md", "b.md", "c.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("never duplicates a tab when the same note is re-opened", async () => {
    await open("a.md");
    await open("a.md");
    expect(useStore.getState().openTabs).toEqual(["a.md"]);
  });

  it("closing the active tab lands on its neighbour", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md");
    await open("b.md"); // active, in the middle: ["a", "b", "c"]
    useStore.getState().closeTab("b.md");
    await flush();
    expect(useStore.getState().openTabs).toEqual(["a.md", "c.md"]);
    // The tab to its right slid into its slot.
    expect(useStore.getState().openNote?.path).toBe("c.md");
  });

  it("closing the last tab clears the editor", async () => {
    await open("a.md");
    useStore.getState().closeTab("a.md");
    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().openNote).toBeNull();
  });

  it("closeTabsToRight keeps the anchor and everything before it", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md"); // ["a","b","c"], active "c"
    useStore.getState().closeTabsToRight("a.md");
    await flush();
    expect(useStore.getState().openTabs).toEqual(["a.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });
});

describe("createNoteIn / createNoteAt", () => {
  it("names the note Untitled, then Untitled 1 when that is taken", async () => {
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled.md");
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled 1.md");
    expect(await useStore.getState().createNoteIn("Work")).toBe("Work/Untitled.md");
  });

  it("opens the new note, reveals its row, and arms its inline title", async () => {
    const path = await useStore.getState().createNoteIn("");
    expect(useStore.getState().openNote?.path).toBe(path);
    // The row is revealed but NOT put into the sidebar's rename box: a new note
    // is created EMPTY and its name is its title, so the cursor waits in the
    // note's own inline title instead (consumed by `InlineTitle` on mount).
    expect(useStore.getState().revealRequest).toMatchObject({ path, edit: false });
    expect(useStore.getState().pendingTitleFocus).toBe(path);
  });

  it("refuses the vault root while the freeze latch is on, and creates nothing", async () => {
    useStore.setState({ rootFrozen: true });
    expect(await useStore.getState().createNoteIn("")).toBeNull();
    expect(await useStore.getState().createNoteAt("", "Named")).toBeNull();
    expect(ipcMock.createNote).not.toHaveBeenCalled();
    // …but a folder is still fair game.
    expect(await useStore.getState().createNoteAt("Work", "Named")).toBe("Work/Named.md");
  });

  it("takes the explicit-name path without arming a rename", async () => {
    // What a dangling `[[wikilink]]` does: the name is already chosen.
    const path = await useStore.getState().createNoteAt("", "Some New Note");
    expect(path).toBe("Some New Note.md");
    expect(useStore.getState().revealRequest).toMatchObject({ path, edit: false });
  });
});

describe("requestReveal", () => {
  it("bumps a token so the SAME path re-fires — a reveal is an event", async () => {
    await open("a.md");
    const first = useStore.getState().revealRequest!;
    expect(first.path).toBe("a.md");

    await open("a.md");
    const second = useStore.getState().revealRequest!;
    expect(second.path).toBe("a.md");
    expect(second.token).toBeGreaterThan(first.token);
    // A new object identity is what re-runs the FileTree effect.
    expect(second).not.toBe(first);
  });

  it("is fired by every note open, whatever the caller", async () => {
    await open("Deep/Folder/note.md");
    expect(useStore.getState().revealRequest).toMatchObject({
      path: "Deep/Folder/note.md",
      edit: false,
    });
  });
});

describe("open gate after a vault switch", () => {
  // NonNullable: `setVault` accepts `VaultInfo | null`, `adoptOpenedVault` does
  // not, and both are called with this below.
  const vaultAt = (path: string) =>
    ({ path, epoch: 1, name: path.split("/").pop() }) as unknown as NonNullable<
      Parameters<ReturnType<typeof useStore.getState>["setVault"]>[0]
    >;

  it("answers 'never synced' for an unstamped folder so an open does not sit out the gate", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null });
    ipcMock.peekVaultStamp.mockResolvedValueOnce(null);
    useStore.getState().setVault(vaultAt("/vaults/local"));
    await flush();
    expect(useStore.getState().openFolderIsSynced).toBe(false);

    // Signed in + not syncable used to mean "wait SYNC_GATE_MS (3s)" per open.
    const t0 = Date.now();
    await open("a.md");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("answers for a vault adopted from the picker/create flow too (bypasses setVault)", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null, openFolderIsSynced: true });
    ipcMock.peekVaultStamp.mockResolvedValueOnce(null);
    await useStore.getState().adoptOpenedVault(vaultAt("/vaults/brand-new"));
    await flush();
    // The previous vault's answer (`true`) must not survive the adoption.
    expect(useStore.getState().openFolderIsSynced).toBe(false);
    const t0 = Date.now();
    await open("a.md");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("keeps waiting for the prime when the folder IS stamped", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null });
    ipcMock.peekVaultStamp.mockResolvedValueOnce({ organizationId: "org-1" } as never);
    useStore.getState().setVault(vaultAt("/vaults/synced"));
    await flush();
    expect(useStore.getState().openFolderIsSynced).toBe(true);
  });
});
