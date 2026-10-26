import { describe, expect, it } from "vitest";
import { buildFileTree, middleTruncate, visibleRows, type TreeFolder } from "../fileTree";

const names = (nodes: { name: string }[]) => nodes.map((n) => n.name);

describe("buildFileTree", () => {
  const paths = ["scripts/run.py", "LICENSE.txt", "agents/b.md", "SKILL.md", "agents/a.md", "scripts/lib/util.py", "README.md"];

  it("pins SKILL.md, then folders, then files, each sorted", () => {
    const tree = buildFileTree(paths);
    expect(names(tree)).toEqual(["SKILL.md", "agents", "scripts", "LICENSE.txt", "README.md"]);
    const scripts = tree[2] as TreeFolder;
    expect(names(scripts.children)).toEqual(["lib", "run.py"]);
    expect((scripts.children[0] as TreeFolder).children[0]).toMatchObject({ name: "util.py", path: "scripts/lib/util.py" });
  });

  it("marks changed files and every folder above them", () => {
    const tree = buildFileTree(paths, new Set(["scripts/lib/util.py"]));
    const scripts = tree[2] as TreeFolder;
    expect(scripts.changed).toBe(true);
    expect((scripts.children[0] as TreeFolder).changed).toBe(true);
    expect((tree[1] as TreeFolder).changed).toBe(false);
  });

  it("only pins SKILL.md at the root", () => {
    expect(names((buildFileTree(["x/SKILL.md", "x/a.md"])[0] as TreeFolder).children)).toEqual(["a.md", "SKILL.md"]);
  });

  it("sorts numbers naturally", () => {
    expect(names(buildFileTree(["f10.md", "f2.md"]))).toEqual(["f2.md", "f10.md"]);
  });
});

describe("visibleRows", () => {
  it("hides the children of collapsed folders and reports depth", () => {
    const tree = buildFileTree(["SKILL.md", "a/b/c.md", "a/d.md"]);
    expect(visibleRows(tree, new Set()).map((r) => [r.node.name, r.depth])).toEqual([
      ["SKILL.md", 0], ["a", 0], ["b", 1], ["c.md", 2], ["d.md", 1],
    ]);
    expect(visibleRows(tree, new Set(["a/b"])).map((r) => r.node.name)).toEqual(["SKILL.md", "a", "b", "d.md"]);
  });
});

describe("middleTruncate", () => {
  it("keeps both ends", () => {
    expect(middleTruncate("short.py")).toBe("short.py");
    const t = middleTruncate("aggregate_benchmark_results.py", 20);
    expect(t).toHaveLength(20);
    expect(t.endsWith("results.py")).toBe(true);
    expect(t).toContain("…");
  });

});
