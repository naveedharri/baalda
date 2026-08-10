import { describe, expect, it } from "vitest";
import type { TreeNode } from "../ipc";
import {
  applyOrder,
  childrenAt,
  clearOrderAt,
  computeReorder,
  moveSubtreeOrder,
  narrowPins,
  removeFromOrder,
  renameInOrder,
  type ItemOrder,
} from "../ordering";

function dir(path: string, children: TreeNode[]): TreeNode {
  const name = path.split("/").pop() ?? path;
  return { id: path, name, path, isDir: true, children };
}
function file(path: string): TreeNode {
  const name = path.split("/").pop() ?? path;
  return { id: path, name, path, isDir: false };
}

describe("applyOrder", () => {
  it("keeps the incoming (Rust) order when nothing is ranked", () => {
    const nodes = [dir("A", []), file("a.md"), file("b.md")];
    expect(applyOrder(nodes, "", {}).map((n) => n.path)).toEqual(["A", "a.md", "b.md"]);
  });

  it("re-sorts by the saved rank, unranked items falling to the end", () => {
    const nodes = [dir("A", []), file("a.md"), file("b.md"), file("c.md")];
    const order: ItemOrder = { "": ["c.md", "a.md"] };
    // c, a ranked; A and b keep their relative incoming order after them.
    expect(applyOrder(nodes, "", order).map((n) => n.path)).toEqual([
      "c.md",
      "a.md",
      "A",
      "b.md",
    ]);
  });

  it("applies recursively to nested folders", () => {
    const nodes = [dir("A", [file("A/x.md"), file("A/y.md")])];
    const order: ItemOrder = { A: ["A/y.md", "A/x.md"] };
    const out = applyOrder(nodes, "", order);
    expect(out[0].children!.map((n) => n.path)).toEqual(["A/y.md", "A/x.md"]);
  });
});

describe("computeReorder", () => {
  const siblings = ["a.md", "b.md", "c.md"];

  it("moves an item down within the same folder", () => {
    // drag a.md to index 2 (between b and c in the pre-move list)
    expect(computeReorder(siblings, ["a.md"], ["a.md"], 2)).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("moves an item up within the same folder", () => {
    expect(computeReorder(siblings, ["c.md"], ["c.md"], 0)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("inserts an item dragged in from another folder at the drop index", () => {
    expect(computeReorder(siblings, ["z.md"], ["dest/z.md"], 1)).toEqual([
      "a.md",
      "dest/z.md",
      "b.md",
      "c.md",
    ]);
  });
});

describe("moveSubtreeOrder", () => {
  it("re-prefixes the moved folder's own order entries and drops old refs", () => {
    const order: ItemOrder = {
      "": ["A", "b.md"],
      A: ["A/x.md", "A/y.md"],
    };
    const next = moveSubtreeOrder(order, "A", "B/A");
    expect(next["B/A"]).toEqual(["B/A/x.md", "B/A/y.md"]);
    expect(next[""]).toEqual(["b.md"]); // A dropped from its old parent list
    expect(next.A).toBeUndefined();
  });
});

describe("renameInOrder", () => {
  it("keeps the item's rank and reprefixes its subtree", () => {
    const order: ItemOrder = {
      "": ["A", "b.md"],
      A: ["A/x.md"],
    };
    const next = renameInOrder(order, "A", "Renamed");
    expect(next[""]).toEqual(["Renamed", "b.md"]);
    expect(next.Renamed).toEqual(["Renamed/x.md"]);
  });
});

describe("removeFromOrder", () => {
  it("drops the item and its subtree everywhere", () => {
    const order: ItemOrder = {
      "": ["A", "b.md"],
      A: ["A/x.md"],
    };
    const next = removeFromOrder(order, "A");
    expect(next[""]).toEqual(["b.md"]);
    expect(next.A).toBeUndefined();
  });
});

describe("clearOrderAt", () => {
  it("forgets one folder's order and leaves the rest untouched", () => {
    const order: ItemOrder = { "": ["b.md", "a.md"], A: ["A/y.md", "A/x.md"] };
    const next = clearOrderAt(order, "A");
    expect(next.A).toBeUndefined();
    expect(next[""]).toEqual(["b.md", "a.md"]);
  });

  it("returns the same object when there's nothing to clear", () => {
    const order: ItemOrder = { "": ["a.md"] };
    expect(clearOrderAt(order, "Nope")).toBe(order);
  });
});

describe("childrenAt", () => {
  const root = [dir("A", [file("A/x.md"), dir("A/Sub", [file("A/Sub/z.md")])]), file("a.md")];
  it("returns root children for the empty dir", () => {
    expect(childrenAt(root, "").map((n) => n.path)).toEqual(["A", "a.md"]);
  });
  it("walks into nested folders", () => {
    expect(childrenAt(root, "A/Sub").map((n) => n.path)).toEqual(["A/Sub/z.md"]);
  });
  it("returns [] for a missing path", () => {
    expect(childrenAt(root, "Nope")).toEqual([]);
  });
});

// A pin is permanent: anything named in the saved order stops following the
// sidebar's sort. So a drop should name as little as it can. The case that
// matters is the common one — reordering top-level FOLDERS shouldn't quietly
// freeze that level's notes out of "Recently modified" forever.
describe("narrowPins", () => {
  const isDir = (p: string) => p === "A" || p === "B" || p === "C";

  it("pins only the folders when the drag was folders-only", () => {
    expect(
      narrowPins(["B", "A", "n1.md", "n2.md"], isDir, ["B"], undefined),
    ).toEqual(["B", "A"]);
  });

  it("pins everything when a note was dragged", () => {
    // A note can legitimately be placed above a folder, and that arrangement
    // only holds if every sibling is ranked.
    expect(
      narrowPins(["n2.md", "A", "B", "n1.md"], isDir, ["n2.md"], undefined),
    ).toEqual(["n2.md", "A", "B", "n1.md"]);
  });

  it("pins everything on a mixed drag", () => {
    expect(narrowPins(["B", "n1.md", "A"], isDir, ["B", "n1.md"], undefined)).toEqual([
      "B",
      "n1.md",
      "A",
    ]);
  });

  it("keeps the full list when this folder's notes are ALREADY arranged", () => {
    // Narrowing here would silently discard the note arrangement the user made
    // on an earlier drag.
    expect(
      narrowPins(["B", "A", "n2.md", "n1.md"], isDir, ["B"], ["A", "B", "n2.md", "n1.md"]),
    ).toEqual(["B", "A", "n2.md", "n1.md"]);
  });

  it("narrows when the existing arrangement is folders-only", () => {
    expect(narrowPins(["B", "A", "n1.md"], isDir, ["B"], ["A", "B"])).toEqual(["B", "A"]);
  });

  // The point of narrowing, stated as the behaviour it buys: folders stay put,
  // notes keep sorting — and folders still come first, because they are the
  // ranked ones and applyOrder puts unranked items after.
  it("leaves the notes free to re-sort under applyOrder", () => {
    const pins = narrowPins(["B", "A", "n1.md", "n2.md"], isDir, ["B"], undefined);
    // Later, "Recently modified" hands the level over with n2 before n1.
    const sorted = [dir("A", []), dir("B", []), file("n2.md"), file("n1.md")];
    expect(applyOrder(sorted, "", { "": pins }).map((n) => n.path)).toEqual([
      "B",
      "A",
      "n2.md",
      "n1.md",
    ]);
  });
});
