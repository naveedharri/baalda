import { describe, expect, it } from "vitest";
import { CURVE_SEGMENTS, templateLayout, writeCurve } from "./templates";

const nodes = Array.from({ length: 300 }, (_, i) => ({
  id: `n${i}`,
  path: `${["A", "B", "C"][i % 3]}/n${i}.md`,
  linkCount: (i * 7) % 23,
}));

describe("graph templates", () => {
  it("draws the same picture every time", () => {
    const a = templateLayout(nodes, "radial");
    const b = templateLayout(nodes, "radial");
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
  });

  it("keeps radial notes inside the disc and ring notes on the band", () => {
    const radial = templateLayout(nodes, "radial");
    const ring = templateLayout(nodes, "ring");
    for (let i = 0; i < nodes.length; i++) {
      expect(Math.hypot(radial.pos[i * 2], radial.pos[i * 2 + 1])).toBeLessThanOrEqual(radial.r * 1.05);
      expect(Math.hypot(ring.pos[i * 2], ring.pos[i * 2 + 1])).toBeGreaterThanOrEqual(ring.r * 0.99);
    }
  });

  it("gives each folder its own group", () => {
    const { group } = templateLayout(nodes, "ring");
    expect(new Set(group).size).toBe(3);
    expect(group[0]).not.toBe(group[1]);
  });

  it("writes a link as connected pieces from one end to the other", () => {
    const out = new Float32Array(CURVE_SEGMENTS * 4);
    writeCurve(10, 0, 0, 10, 0.5, out, 0);
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(0);
    expect(out[out.length - 2]).toBeCloseTo(0);
    expect(out[out.length - 1]).toBeCloseTo(10);
  });
});
