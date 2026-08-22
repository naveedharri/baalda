import { describe, expect, it } from "vitest";
import {
  accessRowName,
  ancestorPaths,
  entriesFromServer,
  entriesFromTree,
  folderChildrenLoaded,
  rowsFromEntries,
} from "../accessTree";
import type { TreeNode } from "../ipc";

const dir = (path: string, children?: TreeNode[], loaded = true): TreeNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  path,
  isDir: true,
  children,
  ...(loaded ? { childrenLoaded: true } : {}),
});

const file = (path: string): TreeNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  path,
  isDir: false,
});

const root = (children: TreeNode[]): TreeNode => ({
  id: "",
  name: "vault",
  path: "",
  isDir: true,
  children,
  childrenLoaded: true,
});

/** Everything registered — the ordinary synced vault. */
const allRegistered = {
  folderId: (p: string) => `folder-${p}`,
  docId: (p: string) => `doc-${p}`,
};

/** The server's structure listing for the tree used across these tests. */
const serverTree = {
  folders: [
    { id: "f-docs", path: "Docs" },
    { id: "f-specs", path: "Docs/Specs" },
  ],
  notes: [
    { id: "d-spec", relPath: "Docs/spec.md" },
    { id: "d-deep", relPath: "Docs/Specs/deep.md" },
    { id: "d-readme", relPath: "readme.md" },
  ],
};

describe("Access panel item tree", () => {
  const entries = entriesFromServer(serverTree);

  it("shows only top-level rows when nothing is expanded", () => {
    const rows = rowsFromEntries(entries, new Set());
    expect(rows.map((r) => r.path)).toEqual(["Docs", "readme.md"]);
    expect(rows[0].expandable).toBe(true);
    expect(rows[1].expandable).toBe(false);
  });

  it("reveals a folder's contents when expanded, indented one level", () => {
    const rows = rowsFromEntries(entries, new Set(["Docs"]));
    expect(rows.map((r) => r.path)).toEqual([
      "Docs",
      "Docs/Specs",
      "Docs/spec.md",
      "readme.md",
    ]);
    expect(rows.find((r) => r.path === "Docs/spec.md")?.depth).toBe(1);

    const deeper = rowsFromEntries(entries, new Set(["Docs", "Docs/Specs"]));
    expect(deeper.map((r) => r.path)).toContain("Docs/Specs/deep.md");
    expect(deeper.find((r) => r.path === "Docs/Specs/deep.md")?.depth).toBe(2);
  });

  it("lists an item the caller has shut themselves out of", () => {
    // The whole reason the panel reads the SERVER's structure. A Private item
    // leaves the local disk, and this list is where you go to change your mind —
    // sourcing it from the disk removed the row exactly when it was needed.
    const rows = rowsFromEntries(entries, new Set());
    expect(rows.map((r) => r.path)).toContain("Docs");
    // Nothing about the row depends on the file existing locally.
    expect(rows.find((r) => r.path === "readme.md")?.id).toBe("d-readme");
  });

  it("offers no twisty for a folder with nothing inside it", () => {
    const rows = rowsFromEntries(
      entriesFromServer({ folders: [{ id: "f", path: "Empty" }], notes: [] }),
      new Set(),
    );
    expect(rows[0].expandable).toBe(false);
  });

  it("sorts folders before notes at each level", () => {
    const rows = rowsFromEntries(
      entriesFromServer({
        folders: [{ id: "f", path: "Zebra" }],
        notes: [{ id: "d", relPath: "apple.md" }],
      }),
      new Set(),
    );
    expect(rows.map((r) => r.path)).toEqual(["Zebra", "apple.md"]);
  });

  it("keys rows by server id and strips .md from note names", () => {
    const rows = rowsFromEntries(entries, new Set(["Docs"]));
    expect(rows.find((r) => r.path === "Docs")?.key).toBe("folder:f-docs");
    const note = rows.find((r) => r.path === "Docs/spec.md");
    expect(note?.key).toBe("file:d-spec");
    expect(note?.name).toBe("spec");
  });

  it("names ancestors so a nested item can be revealed", () => {
    expect(ancestorPaths("Docs/Specs/deep.md")).toEqual(["Docs", "Docs/Specs"]);
    expect(ancestorPaths("readme.md")).toEqual([]);
    expect(accessRowName("a/b/c.md", true)).toBe("c");
  });

  it("returns nothing for an empty vault", () => {
    expect(rowsFromEntries([], new Set())).toEqual([]);
  });
});

describe("Access panel fallback to the local tree", () => {
  // Used only while the server listing is in flight or was refused. It carries
  // the lazy-loading rule the server source doesn't need.
  const tree = root([
    dir("Docs", [file("Docs/spec.md"), dir("Docs/Specs", [file("Docs/Specs/deep.md")])]),
    file("readme.md"),
  ]);

  it("treats an un-listed folder as expandable, not empty", () => {
    // The sidebar loads folders lazily, so a folder nobody has clicked arrives
    // with no children. Calling that "empty" hid every note inside it.
    const lazy = root([dir("Unopened", undefined, false)]);
    const rows = rowsFromEntries(entriesFromTree(lazy, allRegistered), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].expandable).toBe(true);
    expect(folderChildrenLoaded(lazy, "Unopened")).toBe(false);
  });

  it("offers no twisty for a folder known to be empty", () => {
    const empty = root([dir("Empty", [])]);
    const rows = rowsFromEntries(entriesFromTree(empty, allRegistered), new Set());
    expect(rows[0].expandable).toBe(false);
    expect(folderChildrenLoaded(empty, "Empty")).toBe(true);
  });

  it("skips unregistered rows but still walks through them", () => {
    // A folder with no server id can't hold a share, yet the registered notes
    // beneath it must stay reachable.
    const rows = rowsFromEntries(
      entriesFromTree(tree, {
        folderId: (p) => (p === "Docs" ? null : `folder-${p}`),
        docId: (p) => `doc-${p}`,
      }),
      new Set(["Docs"]),
    );
    expect(rows.map((r) => r.path)).toEqual(["Docs/Specs", "Docs/spec.md", "readme.md"]);
  });

  it("produces the same shape as the server source", () => {
    const fromDisk = rowsFromEntries(entriesFromTree(tree, allRegistered), new Set(["Docs"]));
    expect(fromDisk.map((r) => r.path)).toEqual([
      "Docs",
      "Docs/Specs",
      "Docs/spec.md",
      "readme.md",
    ]);
  });

  it("returns nothing for an empty vault", () => {
    expect(entriesFromTree(null, allRegistered)).toEqual([]);
  });
});
