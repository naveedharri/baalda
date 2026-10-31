// Background graph layout (redesign). The graph view used to lay itself out
// only when opened, so the first look was a settle happening on screen. Here
// the same layout (cluster seed, bloom, settle: `formation.ts` and
// `simulation.ts`, unchanged) runs while the app is idle, in slices of a few
// milliseconds that yield back to the UI, and the finished positions are kept
// per vault. The graph view then opens straight into that shape, and saves its
// own final shape back when it closes, so the next open matches exactly.
//
// Memory only: nothing is written to disk, and a layout that no longer fits
// the vault (notes added or removed, other filters) is simply recomputed.

import type { Graph } from "./buildGraph";
import { buildGraph } from "./buildGraph";
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

interface Cached {
  key: string;
  pos: LayoutPositions;
}

const cache = new Map<string, Cached>();
let running: { vault: string; key: string; cancel: () => void } | null = null;

/** Above this the graph uses its Web Worker path, which settles on its own. */
export const PRELAYOUT_MAX_NODES = 8000;
/** Each slice of background work stays under this, then yields to the UI. */
const SLICE_MS = 8;
/** The settle is done once the layout has cooled to this. */
const DONE_ALPHA = 0.025;

/** What a layout depends on: the visible notes, their links and the physics. */
export function layoutKey(graph: Graph, s: GraphSettings): string {
  const visible = graph.nodes.filter(
    (n) => !(s.hideOrphans && n.linkCount === 0) && n.linkCount >= s.minDegree,
  );
  return [
    visible.length,
    graph.edges.length,
    s.charge,
    s.linkDistance,
    s.linkStrength,
    s.gravity,
    s.hideOrphans,
    s.minDegree,
  ].join("|");
}

/** A finished layout for this vault and graph, if one is ready and still fits. */
export function takeLayout(vault: string, graph: Graph, s: GraphSettings): LayoutPositions | null {
  const hit = cache.get(vault);
  return hit && hit.key === layoutKey(graph, s) ? hit.pos : null;
}

/** Remember the graph view's own settled shape (on close). */
export function saveLayout(vault: string, graph: Graph, s: GraphSettings, nodes: readonly SimNode[]): void {
  if (nodes.length === 0) return;
  const pos: LayoutPositions = new Map();
  for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });
  cache.set(vault, { key: layoutKey(graph, s), pos });
}

/** Drop everything (vault closed or switched). */
export function forgetLayouts(): void {
  running?.cancel();
  running = null;
  cache.clear();
}

/**
 * Compute this vault's layout in the background unless one that still fits is
 * cached or already being computed. Never blocks: every slice yields.
 */
export async function prewarmGraphLayout(vault: string, settings: GraphSettings): Promise<void> {
  if (settings.scope !== "global") return;
  let graph: Graph;
  try {
    graph = await buildGraph();
  } catch {
    return;
  }
  const key = layoutKey(graph, settings);
  if (cache.get(vault)?.key === key) return;
  if (running && running.vault === vault && running.key === key) return;
  running?.cancel();
  let cancelled = false;
  const job = { vault, key, cancel: () => { cancelled = true; } };
  running = job;
  const pos = await computeLayout(graph, settings, () => cancelled);
  if (running === job) running = null;
  if (pos && !cancelled) cache.set(vault, { key, pos });
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 16);
  });
}

/** The graph view's own pipeline, run headless and sliced. */
async function computeLayout(
  graph: Graph,
  s: GraphSettings,
  isCancelled: () => boolean,
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
  if (nodes.length === 0 || nodes.length > PRELAYOUT_MAX_NODES) return null;
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
    await yieldToUi();
  }
  return null;
}
