// The tab strip's contract, at the store level (the strip itself is a React
// component and this repo has no `@testing-library/react` — see
// docs/INTERACTIONS.md "Known gaps").
//
// Three things are pinned here:
//   1. `openTabs` is most-recently-active FIRST, so the active card is always the
//      leftmost one and `closeTab` lands on the note you came from;
//   2. `createNoteIn` names a new note `Untitled`, `Untitled 1`, … and arms the
//      sidebar's inline rename through a reveal request;
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
  it("puts the active tab first and keeps the rest in most-recent order", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md");
    expect(useStore.getState().openTabs).toEqual(["c.md", "b.md", "a.md"]);

    await open("a.md");
    expect(useStore.getState().openTabs).toEqual(["a.md", "c.md", "b.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("never duplicates a tab when the same note is re-opened", async () => {
    await open("a.md");
    await open("a.md");
    expect(useStore.getState().openTabs).toEqual(["a.md"]);
  });

  it("closing the active tab lands on the previously active one", async () => {
    await open("a.md");
    await open("b.md"); // active, so openTabs === ["b.md", "a.md"]
    useStore.getState().closeTab("b.md");
    await flush();
    expect(useStore.getState().openTabs).toEqual(["a.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("closing the last tab clears the editor", async () => {
    await open("a.md");
    useStore.getState().closeTab("a.md");
    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().openNote).toBeNull();
  });

  it("closeTabsToRight on the active (leading) tab keeps only it", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md"); // ["c","b","a"], active "c"
    useStore.getState().closeTabsToRight("c.md");
    await flush();
    expect(useStore.getState().openTabs).toEqual(["c.md"]);
    expect(useStore.getState().openNote?.path).toBe("c.md");
  });
});

describe("createNoteIn / createNoteAt", () => {
  it("names the note Untitled, then Untitled 1 when that is taken", async () => {
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled.md");
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled 1.md");
    expect(await useStore.getState().createNoteIn("Work")).toBe("Work/Untitled.md");
  });

  it("opens the new note and reveals its row in inline rename", async () => {
    const path = await useStore.getState().createNoteIn("");
    expect(useStore.getState().openNote?.path).toBe(path);
    // New notes are created EMPTY, so the rename box is the naming affordance.
    expect(useStore.getState().revealRequest).toMatchObject({ path, edit: true });
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
