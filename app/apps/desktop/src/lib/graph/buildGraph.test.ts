import { describe, expect, it } from "vitest";
import { assembleGraph } from "./buildGraph";
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
