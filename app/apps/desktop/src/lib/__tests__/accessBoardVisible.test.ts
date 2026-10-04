// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { expandableKeys, visibleBoardRows, type BoardRow } from "../accessBoard";
import type { AccessRow } from "../accessTree";

/** A column fixture in tree order; a leading "~" marks a grey path row. */
function column(spec: string[]): BoardRow[] {
  return spec.map((s) => {
    const grey = s.startsWith("~");
    const path = grey ? s.slice(1) : s;
    const folder = !path.endsWith(".md");
    const depth = path.split("/").length - 1;
    const row = {
      kind: folder ? "folder" : "note", id: path, path, key: path,
      name: path.split("/").pop()!, depth, expandable: folder,
    } as unknown as AccessRow;
    return { row, grey, indent: Math.min(depth, 4) };
  });
}

const paths = (rows: ReturnType<typeof visibleBoardRows>) => rows.map((v) => v.item.row.path);

const fixture = column([
  "A",
  "A/B",
  "A/B/x.md",
  "A/B/C",
  "A/B/C/y.md",
  "A/z.md",
  "~G",
  "~G/H",
  "G/H/I",
  "G/H/I/w.md",
  "G/h.md",
  "Empty",
  "root.md",
]);

describe("visibleBoardRows", () => {
  it("collapsed by default: only top-level rows and grey paths with their direct members", () => {
    expect(paths(visibleBoardRows(fixture, new Set()))).toEqual(["A", "~G", "~G/H", "G/H/I", "G/h.md", "Empty", "root.md"].map((p) => p.replace("~", "")));
  });

  it("expanding a folder shows its children; nested folders stay collapsed", () => {
    expect(paths(visibleBoardRows(fixture, new Set(["A"])))).toEqual(
      ["A", "A/B", "A/z.md", "G", "G/H", "G/H/I", "G/h.md", "Empty", "root.md"],
    );
    expect(paths(visibleBoardRows(fixture, new Set(["A", "A/B"])))).toEqual(
      ["A", "A/B", "A/B/x.md", "A/B/C", "A/z.md", "G", "G/H", "G/H/I", "G/h.md", "Empty", "root.md"],
    );
  });

  it("a child expanded under a collapsed parent stays hidden", () => {
    expect(paths(visibleBoardRows(fixture, new Set(["A/B", "A/B/C"])))).toEqual(
      ["A", "G", "G/H", "G/H/I", "G/h.md", "Empty", "root.md"],
    );
  });

  it("expand all shows every row; grey rows are never toggles", () => {
    const all = visibleBoardRows(fixture, new Set(expandableKeys(fixture)));
    expect(all).toHaveLength(fixture.length);
    expect(all.map((v) => v.index)).toEqual(fixture.map((_, i) => i));
    expect(expandableKeys(fixture)).toEqual(["A", "A/B", "A/B/C", "G/H/I"]);
    expect(all.filter((v) => v.item.grey).every((v) => !v.expandable)).toBe(true);
  });

  it("toggles only folders with rows under them, and counts interactive descendants", () => {
    const view = visibleBoardRows(fixture, new Set(expandableKeys(fixture)));
    const at = (p: string) => view.find((v) => v.item.row.path === p)!;
    expect(at("A")).toMatchObject({ expandable: true, descendants: 5 });
    expect(at("A/B/C")).toMatchObject({ expandable: true, descendants: 1 });
    expect(at("G")).toMatchObject({ expandable: false, descendants: 3 });
    expect(at("Empty")).toMatchObject({ expandable: false, descendants: 0 });
    expect(at("root.md").expandable).toBe(false);
  });

  it("keeps the position in the full list for every visible row", () => {
    const view = visibleBoardRows(fixture, new Set());
    expect(view.map((v) => v.index)).toEqual([0, 6, 7, 8, 10, 11, 12]);
  });

  it("stays linear on a large column", () => {
    const big: string[] = [];
    for (let i = 0; i < 300; i++) {
      big.push(`F${i}`);
      for (let j = 0; j < 49; j++) big.push(`F${i}/n${j}.md`);
    }
    const rows = column(big);
    const t = performance.now();
    const collapsed = visibleBoardRows(rows, new Set());
    const open = visibleBoardRows(rows, new Set(expandableKeys(rows)));
    expect(collapsed).toHaveLength(300);
    expect(open).toHaveLength(15_000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
