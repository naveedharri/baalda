import { describe, expect, it } from "vitest";
import type { TreeNode } from "../ipc";
import { loadedFolderPaths, setChildrenAt, implicatedFolders, mergeChildren, nodeAt } from "./lazyTree";

// The sidebar folds itself up if a refresh forgets which folders were expanded.
// `refreshTree` runs on every `file-changed` burst and every sync registry pull
// — i.e. constantly while you type — so a refresh that rebuilt from the top
// level alone dropped every expanded folder back to an unloaded placeholder:
// open a folder, click through its notes, watch it empty out under you. These
// tests pin the two halves that stop that: finding what was loaded, and putting
// it back in an order where parents exist before their children are filled.

const dir = (path: string, children?: TreeNode[], loaded?: boolean): TreeNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  path,
  isDir: true,
  ...(children ? { children } : {}),
  ...(loaded === undefined ? {} : { childrenLoaded: loaded }),
});

const file = (path: string): TreeNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  path,
  isDir: false,
});

/** The shape `refreshTree` starts from: root listed, subfolders placeholders. */
const rootWith = (children: TreeNode[]): TreeNode => ({
  id: "",
  name: "vault",
  path: "",
  isDir: true,
  children,
  childrenLoaded: true,
});

describe("loadedFolderPaths", () => {
  it("finds expanded folders and ignores placeholders", () => {
    const tree = rootWith([
      dir("Expanded", [file("Expanded/a.md")], true),
      dir("Untouched", [], false),
      file("top.md"),
    ]);
    expect(loadedFolderPaths(tree)).toEqual(["Expanded"]);
  });

  it("omits the root, which is always listed and never re-fetched", () => {
    expect(loadedFolderPaths(rootWith([]))).toEqual([]);
  });

  it("treats an absent childrenLoaded flag as not loaded", () => {
    // `children: []` alone is ambiguous — an empty folder and an unexpanded one
    // look identical — so only the explicit flag counts as listed.
    expect(loadedFolderPaths(rootWith([dir("Maybe", [])]))).toEqual([]);
  });

  it("keeps a genuinely empty folder, which IS loaded", () => {
    expect(loadedFolderPaths(rootWith([dir("Empty", [], true)]))).toEqual(["Empty"]);
  });

  it("orders parents before their children", () => {
    const tree = rootWith([
      dir("A", [dir("A/B", [dir("A/B/C", [file("A/B/C/deep.md")], true)], true)], true),
    ]);
    expect(loadedFolderPaths(tree)).toEqual(["A", "A/B", "A/B/C"]);
  });

  it("survives a null tree (nothing open yet)", () => {
    expect(loadedFolderPaths(null)).toEqual([]);
  });
});

describe("setChildrenAt", () => {
  it("fills a folder and marks it loaded", () => {
    const next = setChildrenAt(rootWith([dir("Notes", [], false)]), "Notes", [
      file("Notes/a.md"),
    ]);
    const notes = next.children?.[0];
    expect(notes?.childrenLoaded).toBe(true);
    expect(notes?.children?.map((c) => c.path)).toEqual(["Notes/a.md"]);
  });

  it("leaves siblings untouched", () => {
    // By value, not by reference: the walk rebuilds every node it passes
    // through. What matters is that B's loaded children survive A being filled.
    const before = rootWith([dir("A", [], false), dir("B", [file("B/keep.md")], true)]);
    const next = setChildrenAt(before, "A", [file("A/new.md")]);
    expect(next.children?.[1]).toEqual(before.children?.[1]);
  });

  it("no-ops for a path that is gone (deleted or renamed folder)", () => {
    const before = rootWith([dir("A", [], false)]);
    expect(setChildrenAt(before, "Vanished", [file("Vanished/x.md")])).toEqual(before);
  });
});

describe("restoring an expanded tree the way refreshTree does", () => {
  // The regression itself: take a tree with nested folders open, rebuild from a
  // fresh top-level listing, and replay the loaded paths in the order
  // loadedFolderPaths hands back. Everything the user had open must come back.
  it("re-expands nested folders after a top-level-only rebuild", () => {
    const expanded = rootWith([
      dir("A", [dir("A/B", [file("A/B/note.md")], true), file("A/x.md")], true),
    ]);
    const loaded = loadedFolderPaths(expanded);

    // What Rust returns after the refresh: subfolders are placeholders again.
    let rebuilt = rootWith([dir("A", [], false)]);
    const listing: Record<string, TreeNode[]> = {
      A: [dir("A/B", [], false), file("A/x.md")],
      "A/B": [file("A/B/note.md")],
    };
    for (const path of loaded) rebuilt = setChildrenAt(rebuilt, path, listing[path]);

    expect(loadedFolderPaths(rebuilt)).toEqual(["A", "A/B"]);
    const b = rebuilt.children?.[0].children?.[0];
    expect(b?.path).toBe("A/B");
    expect(b?.children?.map((c) => c.path)).toEqual(["A/B/note.md"]);
  });

  it("shows changes made on disk while a folder was open", () => {
    // Re-listing rather than carrying the old children over is the whole point:
    // the folder you are looking at is the one most likely to have just changed.
    const expanded = rootWith([dir("A", [file("A/old.md")], true)]);
    let rebuilt = rootWith([dir("A", [], false)]);
    for (const path of loadedFolderPaths(expanded)) {
      rebuilt = setChildrenAt(rebuilt, path, [file("A/old.md"), file("A/added.md")]);
    }
    expect(rebuilt.children?.[0].children?.map((c) => c.path)).toEqual([
      "A/old.md",
      "A/added.md",
    ]);
  });

  it("drops a folder that disappeared while it was open", () => {
    const expanded = rootWith([dir("Gone", [file("Gone/n.md")], true)]);
    // refreshTree skips paths whose listing failed, so nothing is replayed.
    const rebuilt = rootWith([]);
    expect(loadedFolderPaths(expanded)).toEqual(["Gone"]);
    expect(rebuilt.children).toEqual([]);
  });
});

describe("targeted refresh helpers (#82)", () => {
  const dir = (path: string, extra: Partial<TreeNode> = {}): TreeNode => ({
    id: path,
    name: path.split("/").pop() ?? path,
    path,
    isDir: true,
    children: [],
    ...extra,
  });
  const file = (path: string): TreeNode => ({
    id: path,
    name: path.split("/").pop() ?? path,
    path,
    isDir: false,
  });

  it("implicatedFolders: a file change implicates only its parent; structure means everything", () => {
    expect(
      implicatedFolders([
        { path: "Daily/2026-09-04.md", kind: "modified" },
        { path: "Root.md", kind: "removed" },
        { path: "Daily/notes.md", kind: "modified" },
      ]),
    ).toEqual(new Set(["Daily", ""]));
    expect(
      implicatedFolders([
        { path: "Daily/x.md", kind: "modified" },
        { path: "Archive", kind: "tree" },
      ]),
    ).toBeNull();
  });

  it("mergeChildren keeps an expanded sub-folder loaded across a fresh listing", () => {
    const previous = [
      dir("A/inner", { childrenLoaded: true, children: [file("A/inner/n.md")] }),
      dir("A/stale", { childrenLoaded: true, children: [file("A/stale/old.md")] }),
      file("A/gone.md"),
    ];
    // The fresh listing: `inner` (as a placeholder), a new folder, a new file;
    // `stale` and `gone.md` left the disk.
    const fresh = [dir("A/inner", { childrenLoaded: false }), dir("A/new"), file("A/new.md")];
    const merged = mergeChildren(previous, fresh);
    expect(merged.map((n) => n.path)).toEqual(["A/inner", "A/new", "A/new.md"]);
    const inner = merged[0];
    expect(inner.childrenLoaded).toBe(true);
    expect(inner.children?.map((c) => c.path)).toEqual(["A/inner/n.md"]);
    expect(merged[1].childrenLoaded).toBeFalsy();
  });

  it("nodeAt finds a loaded folder by path and returns null for an unloaded one", () => {
    const root: TreeNode = dir("", {
      childrenLoaded: true,
      children: [
        dir("A", { childrenLoaded: true, children: [dir("A/inner", { childrenLoaded: true })] }),
        dir("B"),
      ],
    });
    expect(nodeAt(root, "")?.path).toBe("");
    expect(nodeAt(root, "A/inner")?.path).toBe("A/inner");
    expect(nodeAt(root, "B")?.path).toBe("B");
    expect(nodeAt(root, "B/deeper")).toBeNull();
    expect(nodeAt(root, "Absent")).toBeNull();
  });
});
