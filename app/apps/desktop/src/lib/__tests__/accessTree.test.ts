import { describe, expect, it } from "vitest";
import {
  accessRowName,
  ancestorPaths,
  folderChildrenLoaded,
  visibleAccessRows,
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

/** Everything registered — the ordinary synced vault. */
const allRegistered = {
  folderId: (p: string) => `folder-${p}`,
  docId: (p: string) => `doc-${p}`,
};

const root = (children: TreeNode[]): TreeNode => ({
  id: "",
  name: "vault",
  path: "",
  isDir: true,
  children,
  childrenLoaded: true,
});

describe("Access panel item tree", () => {
  const tree = root([
    dir("Docs", [file("Docs/spec.md"), dir("Docs/Specs", [file("Docs/Specs/deep.md")])]),
    file("readme.md"),
  ]);

  it("shows only top-level rows when nothing is expanded", () => {
    const rows = visibleAccessRows(tree, new Set(), allRegistered);
    expect(rows.map((r) => r.path)).toEqual(["Docs", "readme.md"]);
    expect(rows[0].expandable).toBe(true);
    expect(rows[1].expandable).toBe(false);
  });

  it("reveals a folder's contents when it is expanded, indented one level", () => {
    const rows = visibleAccessRows(tree, new Set(["Docs"]), allRegistered);
    expect(rows.map((r) => r.path)).toEqual([
      "Docs",
      "Docs/spec.md",
      "Docs/Specs",
      "readme.md",
    ]);
    expect(rows.find((r) => r.path === "Docs/spec.md")?.depth).toBe(1);
    // Its own children stay hidden until IT is expanded too.
    const deeper = visibleAccessRows(tree, new Set(["Docs", "Docs/Specs"]), allRegistered);
    expect(deeper.map((r) => r.path)).toContain("Docs/Specs/deep.md");
    expect(deeper.find((r) => r.path === "Docs/Specs/deep.md")?.depth).toBe(2);
  });

  it("treats an un-listed folder as expandable, not empty", () => {
    // The regression this whole tree exists for: the sidebar loads folders
    // lazily, so a folder nobody has clicked arrives with no children. Calling
    // that "empty" is what made the notes inside it unreachable here.
    const lazy = root([dir("Unopened", undefined, false)]);
    const rows = visibleAccessRows(lazy, new Set(), allRegistered);
    expect(rows).toHaveLength(1);
    expect(rows[0].expandable).toBe(true);
    expect(folderChildrenLoaded(lazy, "Unopened")).toBe(false);
  });

  it("offers no twisty for a folder known to be empty", () => {
    const empty = root([dir("Empty", [])]);
    expect(visibleAccessRows(empty, new Set(), allRegistered)[0].expandable).toBe(false);
    expect(folderChildrenLoaded(empty, "Empty")).toBe(true);
  });

  it("skips unregistered rows but still walks through them", () => {
    // A folder with no server id can't hold a share, yet the registered notes
    // beneath it must stay reachable.
    const rows = visibleAccessRows(tree, new Set(["Docs"]), {
      folderId: (p) => (p === "Docs" ? null : `folder-${p}`),
      docId: (p) => `doc-${p}`,
    });
    expect(rows.map((r) => r.path)).toEqual(["Docs/spec.md", "Docs/Specs", "readme.md"]);
  });

  it("keys rows by server id and strips .md from note names", () => {
    const rows = visibleAccessRows(tree, new Set(["Docs"]), allRegistered);
    expect(rows.find((r) => r.path === "Docs")?.key).toBe("folder:folder-Docs");
    const note = rows.find((r) => r.path === "Docs/spec.md");
    expect(note?.key).toBe("file:doc-Docs/spec.md");
    expect(note?.name).toBe("spec");
  });

  it("names ancestors so a nested item can be revealed", () => {
    expect(ancestorPaths("Docs/Specs/deep.md")).toEqual(["Docs", "Docs/Specs"]);
    expect(ancestorPaths("readme.md")).toEqual([]);
    expect(accessRowName("a/b/c.md", true)).toBe("c");
  });

  it("returns nothing for an empty vault", () => {
    expect(visibleAccessRows(null, new Set(), allRegistered)).toEqual([]);
  });
});
