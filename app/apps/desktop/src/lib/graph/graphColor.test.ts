import { describe, expect, it } from "vitest";
import { assignColors, PALETTE } from "./graphColor";
import type { GraphNode } from "./buildGraph";

// The degree ramp's job is to make link-degree *visible*. It was doing the
// opposite on any real vault, and the reason was arithmetic rather than taste:
// linear tiers over a heavy-tailed distribution put nearly every node in one
// bucket, so almost the whole graph drew in a single shade.

const node = (id: string, linkCount: number, path = `${id}.md`): GraphNode =>
  ({ id, title: id, path, linkCount }) as GraphNode;

/**
 * A vault shaped like a real one: a power-law spread, not a barbell. Degrees have
 * to be *continuous* for this fixture to mean anything — an earlier version had
 * leaves at 1–5 and mids at 300+ with nothing between, which left the middle tier
 * empty for the honest reason that no node lived there. Real link counts don't
 * have holes like that, and testing against a hole tests nothing.
 */
function heavyTailed(): GraphNode[] {
  const nodes = [node("hub", 1259)];
  // ~1..500, dense at the bottom and thinning out — a Zipf-ish tail.
  for (let i = 1; i <= 220; i++) {
    nodes.push(node(`n${i}`, Math.max(1, Math.round(500 / i))));
  }
  return nodes;
}

describe("assignColors — degree", () => {
  it("spreads a heavy-tailed vault across tiers instead of piling into one", () => {
    // The regression: with linear thirds of [1, 1259] the tiers came out as
    // 1–420 → everything, 421–839 → nothing, 840–1259 → the hub. Log tiers put
    // the boundaries where the nodes actually are, so no tier holds ~all of them.
    const { legend } = assignColors(heavyTailed(), "degree", "#7f73ff");
    const populated = legend.filter((l) => l.count > 0);
    expect(populated.length).toBeGreaterThanOrEqual(3);

    const total = legend.reduce((n, l) => n + l.count, 0);
    const biggest = Math.max(...legend.map((l) => l.count));
    expect(biggest / total).toBeLessThan(0.95);
  });

  it("gives the top hub a different colour from the leaves", () => {
    const { colorById } = assignColors(heavyTailed(), "degree", "#7f73ff");
    expect(colorById.get("hub")).not.toBe(colorById.get("leaf0"));
  });

  it("puts orphans in their own tier, distinct from linked nodes", () => {
    const { colorById } = assignColors(
      [node("orphan", 0), node("linked", 1)],
      "degree",
      "#7f73ff",
    );
    expect(colorById.get("orphan")).not.toBe(colorById.get("linked"));
  });

  it("is monotonic: more links never means a colder tier", () => {
    const nodes = [1, 2, 5, 20, 100, 900].map((d) => node(`n${d}`, d));
    const { legend, colorById } = assignColors(nodes, "degree", "#7f73ff");
    const rank = new Map(legend.map((l, i) => [l.color, i]));
    const ranks = nodes.map((n) => rank.get(colorById.get(n.id)!)!);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  it("survives a single-node graph without dividing by zero", () => {
    const { colorById, legend } = assignColors([node("only", 0)], "degree", "#7f73ff");
    expect(colorById.get("only")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(legend).toHaveLength(4);
  });
});

describe("assignColors — folder", () => {
  it("gives each top-level folder its own palette colour, stable by name", () => {
    const nodes = [
      node("a", 1, "Work/a.md"),
      node("b", 1, "Work/b.md"),
      node("c", 1, "Personal/c.md"),
      node("d", 1, "d.md"), // root
    ];
    const { colorById, legend } = assignColors(nodes, "folder", "#7f73ff");
    expect(colorById.get("a")).toBe(colorById.get("b"));
    expect(colorById.get("a")).not.toBe(colorById.get("c"));
    expect(legend.map((l) => l.label).sort()).toEqual(["Personal", "Root", "Work"]);
    for (const l of legend) expect(PALETTE).toContain(l.color);
  });
});
