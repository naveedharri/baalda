// The background layout itself, kept free of anything UI-side so it can run on
// the main thread in slices (`prelayout.ts`) or whole in a worker
// (`prelayoutWorker.ts`) for vaults too big to slice.

import type { Graph } from "./buildGraph";
import { beginBloom, bloomStep, seedByCluster } from "./formation";
import type { GraphSettings } from "./graphSettings";
import {
  centerWeight,
  configureForces,
  createSimulation,
  IDLE_ALPHA,
  markHubs,
  nodeRadius,
  type SimLink,
  type SimNode,
} from "./simulation";

export type LayoutPositions = Map<string, { x: number; y: number }>;

/** Each slice of background work stays under this, then yields. */
const SLICE_MS = 8;
/** The settle is done once the layout has cooled to this. */
const DONE_ALPHA = 0.025;

/** The graph view's own pipeline, run headless and sliced. */
export async function computeLayout(
  graph: Graph,
  s: GraphSettings,
  isCancelled: () => boolean,
  pause: () => Promise<void>,
): Promise<LayoutPositions | null> {
  const maxDegree = graph.nodes.reduce((m, n) => Math.max(m, n.linkCount), 0);
  const all: SimNode[] = graph.nodes.map((n) => ({
    ...n,
    radius: nodeRadius(n.linkCount),
    weight: centerWeight(n.linkCount, maxDegree),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
  markHubs(all);
  seedByCluster(all, graph);
  const nodes = all.filter((n) => !(s.hideOrphans && n.linkCount === 0) && n.linkCount >= s.minDegree);
  if (nodes.length === 0) return null;
  const visible = new Set(nodes.map((n) => n.id));
  const links: SimLink[] = graph.edges
    .filter((e) => visible.has(e.source) && visible.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  const sim = createSimulation(s).alphaTarget(IDLE_ALPHA);
  sim.nodes(nodes);
  (sim.force("link") as unknown as { links: (l: SimLink[]) => void }).links(links);
  configureForces(sim, s);
  const job = beginBloom(sim);
  let blooming = true;
  for (let guard = 0; guard < 4000; ) {
    if (isCancelled()) return null;
    const until = performance.now() + SLICE_MS;
    while (performance.now() < until && guard < 4000) {
      if (blooming && bloomStep(sim, job)) blooming = false;
      sim.tick();
      guard++;
      if (!blooming && sim.alpha() <= DONE_ALPHA) {
        const pos: LayoutPositions = new Map();
        for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });
        return pos;
      }
    }
    await pause();
  }
  return null;
}
