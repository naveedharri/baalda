import { describe, expect, it } from "vitest";
import type { TreeNode } from "../../ipc";
import { pinModified, sortTree } from "../sort";
import { applyOrder } from "../../ordering";

const dir = (name: string, modified: number, children: TreeNode[] = []): TreeNode => ({
  id: name,
  name,
  path: name,
  isDir: true,
  modified,
  children,
  childrenLoaded: true,
});

const file = (path: string, modified: number): TreeNode => ({
  id: path,
  name: path.split("/").pop()!,
  path,
  isDir: false,
  modified,
});

const names = (ns: TreeNode[]) => ns.map((n) => n.name);

describe("sortTree", () => {
  it("puts folders before files in both modes", () => {
    const nodes = [file("z.md", 9), dir("Archive", 1), file("a.md", 1), dir("Work", 9)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["Archive", "Work", "z.md", "a.md"]);
    expect(names(sortTree(nodes, "name"))).toEqual(["Archive", "Work", "a.md", "z.md"]);
  });

  it("orders files newest first under 'recent'", () => {
    const nodes = [file("old.md", 100), file("newest.md", 300), file("mid.md", 200)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["newest.md", "mid.md", "old.md"]);
  });

  // A folder's mtime moves whenever anything inside it is saved, so sorting
  // folders by recency would reshuffle the sidebar's skeleton on every edit.
  it("keeps folders alphabetical even under 'recent'", () => {
    const nodes = [dir("Zoo", 999), dir("Apple", 1)];
    expect(names(sortTree(nodes, "recent"))).toEqual(["Apple", "Zoo"]);
  });

  it("breaks ties (and missing mtimes) by name so the result is stable", () => {
    const nodes = [file("b.md", 5), file("a.md", 5), { ...file("c.md", 0), modified: undefined }];
    expect(names(sortTree(nodes, "recent"))).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("compares names naturally and case-insensitively", () => {
    const nodes = [file("note 10.md", 1), file("note 9.md", 1), file("Note 1.md", 1)];
    expect(names(sortTree(nodes, "name"))).toEqual(["Note 1.md", "note 9.md", "note 10.md"]);
  });

  it("sorts every level, not just the top", () => {
    // "a.md" is oldest, so the two modes disagree — which is the point.
    const tree = [dir("Work", 1, [file("Work/a.md", 1), file("Work/z.md", 9)])];
    expect(names(sortTree(tree, "recent")[0].children!)).toEqual(["z.md", "a.md"]);
    expect(names(sortTree(tree, "name")[0].children!)).toEqual(["a.md", "z.md"]);
  });

  it("does not mutate the input", () => {
    const nodes = [file("b.md", 1), file("a.md", 2)];
    const snapshot = names(nodes);
    sortTree(nodes, "name");
    expect(names(nodes)).toEqual(snapshot);
  });
});

// The contract the whole feature rests on: changing the sort must never undo a
// drag-and-drop arrangement, while still reaching everything nobody arranged.
describe("sortTree + applyOrder — the two layers", () => {
  // Inside Alpha, "a.md" is the OLDEST and "z.md" the newest, so the two sort
  // modes must produce opposite orders there.
  const build = () => [
    dir("Alpha", 1, [file("Alpha/a.md", 10), file("Alpha/z.md", 90)]),
    dir("Beta", 1, []),
    file("loose.md", 50),
  ];

  it("keeps a hand-arranged root while sorting inside the folders", () => {
    // The user dragged Beta above Alpha at the root — reversing the alphabetical
    // order the sort would give — and never touched Alpha's contents.
    const order = { "": ["Beta", "Alpha"] };

    const recent = applyOrder(sortTree(build(), "recent"), "", order);
    expect(names(recent).slice(0, 2)).toEqual(["Beta", "Alpha"]);
    expect(names(recent.find((n) => n.name === "Alpha")!.children!)).toEqual([
      "z.md",
      "a.md",
    ]);

    // Flipping the sort rearranges the unpinned inside, and ONLY that: the root
    // still reads Beta, Alpha.
    const byName = applyOrder(sortTree(build(), "name"), "", order);
    expect(names(byName).slice(0, 2)).toEqual(["Beta", "Alpha"]);
    expect(names(byName.find((n) => n.name === "Alpha")!.children!)).toEqual([
      "a.md",
      "z.md",
    ]);
  });

  it("leaves unranked siblings to the sort, after the pinned ones", () => {
    // Only "loose.md" is pinned — to the top, above the folders it would
    // normally sit below.
    const out = applyOrder(sortTree(build(), "recent"), "", { "": ["loose.md"] });
    expect(names(out)).toEqual(["loose.md", "Alpha", "Beta"]);
  });
});

describe("pinModified", () => {
  it("keeps a row where it was when its mtime moves under the pointer", () => {
    const pins = new Map<string, number>();
    const before = [file("a.md", 10), file("b.md", 20), file("c.md", 30)];
    // First pass records what each row was placed with.
    expect(names(sortTree(pinModified(before, pins), "recent"))).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);

    // A sync run rewrites a.md, so the disk now says it is the newest file. With
    // the order pinned, the rows do NOT move — which is the whole point: the row
    // under the cursor stays the row the user aimed at.
    const after = [file("a.md", 99), file("b.md", 20), file("c.md", 30)];
    expect(names(sortTree(pinModified(after, pins), "recent"))).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);

    // Thawing (a fresh, empty memory) reveals the true order.
    expect(names(sortTree(pinModified(after, new Map()), "recent"))).toEqual([
      "a.md",
      "c.md",
      "b.md",
    ]);
  });

  it("still places a file created mid-wave at its real position", () => {
    const pins = new Map<string, number>();
    pinModified([file("a.md", 10), file("b.md", 20)], pins);
    const withNew = [file("a.md", 10), file("b.md", 20), file("new.md", 50)];
    expect(names(sortTree(pinModified(withNew, pins), "recent"))).toEqual([
      "new.md",
      "b.md",
      "a.md",
    ]);
  });

  it("pins inside folders too, and leaves folder order alone", () => {
    const pins = new Map<string, number>();
    const level = [dir("Work", 1, [file("Work/x.md", 1), file("Work/y.md", 2)])];
    pinModified(level, pins);
    const moved = [dir("Work", 9, [file("Work/x.md", 99), file("Work/y.md", 2)])];
    const sorted = sortTree(pinModified(moved, pins), "recent");
    expect(names(sorted)).toEqual(["Work"]);
    expect(names(sorted[0].children!)).toEqual(["Work/y.md", "Work/x.md"].map((p) =>
      p.split("/").pop()!,
    ));
  });

  it("returns the same arrays when nothing moved, so a memo downstream holds", () => {
    const pins = new Map<string, number>();
    const level = [dir("Work", 1, [file("Work/x.md", 1)]), file("a.md", 2)];
    pinModified(level, pins);
    expect(pinModified(level, pins)).toBe(level);
  });
});
