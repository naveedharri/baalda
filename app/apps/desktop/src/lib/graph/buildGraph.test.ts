import { describe, expect, it } from "vitest";
import { assembleGraph, applyGraphDelta } from "./buildGraph";
import type { NoteTitle } from "../ipc";

function title(id: string, path: string, titleText: string): NoteTitle {
  return { id, path, title: titleText };
}

const edge = (source: string, target: string) => ({ source, target });

describe("assembleGraph", () => {
  it("keeps source -> target edges between known notes", () => {
    // Alpha links to Beta (A -> B).
    const titles = [title("a", "alpha.md", "Alpha"), title("b", "beta.md", "Beta")];

    const graph = assembleGraph(titles, [edge("a", "b")]);

    expect(graph.edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("computes linkCount as the number of distinct edges touching a node", () => {
    const titles = [
      title("a", "a.md", "A"),
      title("b", "b.md", "B"),
      title("c", "c.md", "C"),
    ];
    // a -> b, a -> c, b -> c
    const graph = assembleGraph(titles, [edge("a", "b"), edge("a", "c"), edge("b", "c")]);

    const counts = Object.fromEntries(graph.nodes.map((n) => [n.id, n.linkCount]));
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it("dedupes repeated links between the same pair of notes", () => {
    const titles = [title("a", "a.md", "A"), title("b", "b.md", "B")];

    const graph = assembleGraph(titles, [edge("a", "b"), edge("a", "b")]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.find((n) => n.id === "a")?.linkCount).toBe(1);
    expect(graph.nodes.find((n) => n.id === "b")?.linkCount).toBe(1);
  });

  it("drops self-loops and edges to unknown notes", () => {
    const titles = [title("a", "a.md", "A")];

    const graph = assembleGraph(titles, [edge("a", "a"), edge("a", "ghost")]);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes[0].linkCount).toBe(0);
  });

  it("falls back to the filename when a note has no title", () => {
    const titles = [title("a", "folder/untitled.md", "")];

    const graph = assembleGraph(titles, []);

    expect(graph.nodes[0].title).toBe("untitled.md");
  });

  it("returns an empty graph for an empty vault", () => {
    const graph = assembleGraph([], []);
    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});

describe("applyGraphDelta (#83)", () => {
  const titles = [
    { id: "a", path: "A.md", title: "A" },
    { id: "b", path: "B.md", title: "B" },
    { id: "c", path: "C.md", title: "C" },
  ];
  const base = () =>
    assembleGraph(titles, [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);

  it("replaces a changed note's edges and refreshes its title without touching the rest", () => {
    // A's edit dropped its link to B and added one to C; its title changed too.
    const next = applyGraphDelta(base(), {
      nodes: [{ id: "a", path: "A.md", title: "Alpha" }],
      edges: [{ source: "a", target: "c" }],
    });
    expect(next).not.toBeNull();
    expect(next!.edges).toEqual([
      { source: "b", target: "c" }, // untouched: neither end changed
      { source: "a", target: "c" },
    ]);
    const byId = new Map(next!.nodes.map((n) => [n.id, n]));
    expect(byId.get("a")).toMatchObject({ title: "Alpha", linkCount: 1 });
    expect(byId.get("b")).toMatchObject({ title: "B", linkCount: 1 }); // lost a→b
    expect(byId.get("c")).toMatchObject({ linkCount: 2 });
  });

  it("keeps edges INTO a changed note only if the delta still reports them", () => {
    // B changed; the delta says a→b still exists but b→c is gone.
    const next = applyGraphDelta(base(), {
      nodes: [{ id: "b", path: "B.md", title: "B" }],
      edges: [{ source: "a", target: "b" }],
    });
    expect(next!.edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("refuses a delta naming a note the graph does not have (caller rebuilds)", () => {
    expect(
      applyGraphDelta(base(), {
        nodes: [{ id: "new", path: "New.md", title: "New" }],
        edges: [],
      }),
    ).toBeNull();
  });

  it("is a no-op for a delta that changes nothing", () => {
    const g = base();
    const next = applyGraphDelta(g, {
      nodes: [{ id: "a", path: "A.md", title: "A" }],
      edges: [{ source: "a", target: "b" }],
    });
    // Same nodes and counts; edge ORDER may differ (kept edges first), which the
    // renderer does not depend on.
    expect(next!.nodes).toEqual(g.nodes);
    expect(new Set(next!.edges.map((e) => `${e.source}->${e.target}`))).toEqual(
      new Set(g.edges.map((e) => `${e.source}->${e.target}`)),
    );
  });
});
