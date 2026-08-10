import { describe, it, expect } from "vitest";
import {
  createSimulation,
  configureForces,
  layoutScale,
  nodeRadius,
  centerWeight,
  IDLE_ALPHA,
  DRAG_ALPHA,
  type FlowForce,
  type SimNode,
  type SimLink,
} from "./simulation";
import { DEFAULT_SETTINGS } from "./graphSettings";

/** A small hub-and-spokes graph, seeded on a spiral like the renderer does. */
function makeSim(count = 60) {
  const links: SimLink[] = [];
  for (let i = 1; i < count; i++) {
    links.push({ source: `n${Math.floor(i / 12) * 12}`, target: `n${i}` });
    if (i % 4 === 0) links.push({ source: `n${(i * 7) % count}`, target: `n${i}` });
  }
  const degree = new Map<string, number>();
  for (const l of links) {
    for (const id of [l.source as string, l.target as string]) {
      degree.set(id, (degree.get(id) ?? 0) + 1);
    }
  }
  const maxDegree = Math.max(...degree.values());
  const nodes: SimNode[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    const linkCount = degree.get(id) ?? 0;
    const a = i * 2.399963;
    nodes.push({
      id,
      title: id,
      path: `${id}.md`,
      linkCount,
      radius: nodeRadius(linkCount),
      weight: centerWeight(linkCount, maxDegree),
      x: Math.cos(a) * (20 + i * 4),
      y: Math.sin(a) * (20 + i * 4),
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    });
  }

  const sim = createSimulation(DEFAULT_SETTINGS).alphaTarget(IDLE_ALPHA);
  sim.nodes(nodes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sim.force("link") as any).links(links);
  configureForces(sim, DEFAULT_SETTINGS);
  return { sim, nodes, flow: sim.force("flow") as FlowForce };
}

/** Settle to the idle floor — the state the graph sits in when nobody touches it. */
function settled(count = 60) {
  const h = makeSim(count);
  h.sim.alpha(1);
  h.sim.tick(1200);
  h.flow.scale(layoutScale(h.nodes));
  return h;
}

const snapshot = (nodes: SimNode[]) => nodes.map((n) => ({ x: n.x, y: n.y }));
const moved = (nodes: SimNode[], from: { x: number; y: number }[]) =>
  nodes.map((n, i) => Math.hypot(n.x - from[i].x, n.y - from[i].y));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("ambient flow", () => {
  it("keeps a fully settled layout in motion", () => {
    const { sim, nodes } = settled();
    const before = snapshot(nodes);
    sim.tick(60); // one second

    // The whole point: at rest, with no interaction, the graph is moving — and
    // by an amount that reads on screen rather than a sub-pixel jitter. The
    // resting drift is ~2% of the layout radius per second by design.
    expect(mean(moved(nodes, before))).toBeGreaterThan(layoutScale(nodes) * 0.012);
  });

  it("moves neighbours together — the flow is laminar, not a scatter", () => {
    const { sim, nodes } = settled();
    const before = snapshot(nodes);
    sim.tick(60);

    // Take the closest pairs and compare their travel directions. A per-node
    // wander (what this replaced) sends adjacent nodes opposite ways, which is
    // what the link and collision forces then spend every tick correcting —
    // felt as vibration. A shared velocity field carries them the same way.
    const pairs: [number, number][] = [];
    for (let i = 0; i < nodes.length; i++) {
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      pairs.push([i, best]);
    }
    const cosines = pairs.map(([i, j]) => {
      const ax = nodes[i].x - before[i].x;
      const ay = nodes[i].y - before[i].y;
      const bx = nodes[j].x - before[j].x;
      const by = nodes[j].y - before[j].y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la === 0 || lb === 0) return 1;
      return (ax * bx + ay * by) / (la * lb);
    });
    // Perfect agreement isn't the bar — the layout's own slow creep rides along
    // on top and it is not coherent. Without the field this measures ~0.3.
    expect(mean(cosines)).toBeGreaterThan(0.6);
  });

  it("travels smoothly — no frame-to-frame direction flipping", () => {
    const { sim, nodes } = settled();
    const probe = nodes[Math.floor(nodes.length / 2)];
    const steps: [number, number][] = [];
    for (let i = 0; i < 180; i++) {
      const px = probe.x;
      const py = probe.y;
      sim.tick();
      steps.push([probe.x - px, probe.y - py]);
    }
    // Angle between one frame's step and the next. Smooth motion turns slowly;
    // a shaky node reverses, which shows up here as angles near 180°.
    let turn = 0;
    let counted = 0;
    for (let i = 1; i < steps.length; i++) {
      const [ax, ay] = steps[i - 1];
      const [bx, by] = steps[i];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const c = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
      turn += (Math.acos(c) * 180) / Math.PI;
      counted++;
    }
    expect(turn / counted).toBeLessThan(12);
  });

  it("settles smoothly after a drag — this is the one that used to buzz", () => {
    const { sim, nodes, flow } = settled(160);
    const radius = layoutScale(nodes);
    // Grab the smallest, least-anchored node there is (the ones that shook
    // worst) and haul it across a good fraction of the graph.
    const target = nodes.reduce((a, b) => (a.linkCount <= b.linkCount ? a : b));
    sim.alphaTarget(DRAG_ALPHA);
    target.fx = target.x;
    target.fy = target.y;
    for (let f = 0; f < 60; f++) {
      target.fx! += radius * 0.02;
      target.fy! += radius * 0.01;
      sim.tick();
    }
    target.fx = null;
    target.fy = null;
    sim.alphaTarget(IDLE_ALPHA);
    flow.energy(1);

    // Then watch the whole field for three seconds.
    let last = snapshot(nodes);
    const prev = nodes.map(() => ({ x: 0, y: 0 }));
    const stats = nodes.map(() => ({ turn: 0, reversals: 0, frames: 0 }));
    for (let f = 0; f < 180; f++) {
      sim.tick();
      for (let i = 0; i < nodes.length; i++) {
        const dx = nodes[i].x - last[i].x;
        const dy = nodes[i].y - last[i].y;
        const la = Math.hypot(prev[i].x, prev[i].y);
        const lb = Math.hypot(dx, dy);
        if (la > 1e-9 && lb > 1e-9) {
          const c = Math.min(
            1,
            Math.max(-1, (prev[i].x * dx + prev[i].y * dy) / (la * lb)),
          );
          stats[i].turn += (Math.acos(c) * 180) / Math.PI;
          if (c < 0) stats[i].reversals++; // took a step back the way it came
          stats[i].frames++;
        }
        prev[i] = { x: dx, y: dy };
      }
      last = snapshot(nodes);
    }
    const live = stats.filter((s) => s.frames > 90);
    // At the old drag alpha of 0.3 these came out at ~26° and ~14%: every node
    // in the neighbourhood jittering back and forth as the layout re-solved.
    expect(mean(live.map((s) => s.turn / s.frames))).toBeLessThan(5);
    expect(mean(live.map((s) => s.reversals / s.frames))).toBeLessThan(0.03);
  });

  it("is a drift, not a slow escape", () => {
    // A settled d3 layout is never perfectly still — it keeps creeping toward a
    // slightly better arrangement for as long as it runs. So the question isn't
    // "does anything move over a long session" (it always did) but "does the
    // flow ADD to that". A field that carried nodes out and never back would
    // show up here as an excursion far beyond the layout's own.
    const wander = (withFlow: boolean) => {
      const h = settled();
      if (!withFlow) h.flow.scale(0);
      const home = snapshot(h.nodes);
      let worst = 0;
      for (let i = 0; i < 90; i++) {
        h.sim.tick(60); // 90 seconds, sampled every second
        for (const d of moved(h.nodes, home)) worst = Math.max(worst, d);
      }
      return worst;
    };
    expect(wander(true)).toBeLessThan(wander(false) * 1.35);
  });

  it("scales the entrance above the resting drift", () => {
    const calm = settled();
    const calmBefore = snapshot(calm.nodes);
    calm.sim.tick(60);
    const calmSpeed = mean(moved(calm.nodes, calmBefore));

    const lively = settled();
    lively.flow.energy(5);
    const livelyBefore = snapshot(lively.nodes);
    lively.sim.tick(60);
    const livelySpeed = mean(moved(lively.nodes, livelyBefore));

    expect(livelySpeed).toBeGreaterThan(calmSpeed * 2);
  });

  it("leaves a pinned (dragged) node exactly where it is put", () => {
    const { sim, nodes } = settled();
    const pinned = nodes[5];
    pinned.fx = 123;
    pinned.fy = -456;
    sim.tick(120);
    expect(pinned.x).toBe(123);
    expect(pinned.y).toBe(-456);
  });

  it("never lets alpha fall to a dead stop while the view is open", () => {
    const { sim } = settled();
    sim.tick(5000);
    expect(sim.alpha()).toBeGreaterThanOrEqual(IDLE_ALPHA * 0.99);
  });

  it("stays quiet until the renderer tells it how big the layout is", () => {
    const unsized = makeSim();
    unsized.sim.alpha(1);
    unsized.sim.tick(1200);
    unsized.flow.scale(0); // never sized — no field, so nothing to float in
    const unsizedBefore = snapshot(unsized.nodes);
    unsized.sim.tick(60);

    const sized = settled();
    const sizedBefore = snapshot(sized.nodes);
    sized.sim.tick(60);

    expect(mean(moved(unsized.nodes, unsizedBefore))).toBeLessThan(
      mean(moved(sized.nodes, sizedBefore)) * 0.25,
    );
  });
});
