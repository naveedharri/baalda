// Background graph layout (redesign). The graph view used to lay itself out
// only when opened, so the first look was a settle happening on screen. Here
// the same layout (cluster seed, bloom, settle: `formation.ts` and
// `simulation.ts`, unchanged) runs while the app is idle, in slices of a few
// milliseconds that yield back to the UI (or on a worker for a big vault), and
// the finished positions are kept per vault. The graph view then opens straight into that shape, and saves its
// own final shape back when it closes, so the next open matches exactly.
//
// Memory only: nothing is written to disk, and a layout that no longer fits
// the vault (notes added or removed, other filters) is simply recomputed.

import type { Graph } from "./buildGraph";
import { buildGraph } from "./buildGraph";
import type { GraphSettings } from "./graphSettings";
import { computeLayout, type LayoutPositions } from "./layoutCompute";
import type { SimNode } from "./simulation";

export type { LayoutPositions };

interface Cached {
  key: string;
  pos: LayoutPositions;
}

const cache = new Map<string, Cached>();
let running: { vault: string; key: string; done: Promise<void>; cancel: () => void } | null = null;

/** Above this a tick is too long to slice on the UI thread, so the layout gets a worker. */
export const PRELAYOUT_MAX_NODES = 8000;

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

/** Settles when the layout now being computed for this graph is over, if there is one. */
export function layoutPending(vault: string, graph: Graph, s: GraphSettings): Promise<void> | null {
  return running?.vault === vault && running.key === layoutKey(graph, s) ? running.done : null;
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
  let stopWorker = () => {};
  let finish = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const job = { vault, key, done, cancel: () => { cancelled = true; stopWorker(); finish(); } };
  running = job;
  const visible = Number(key.split("|")[0]);
  const pos =
    visible > PRELAYOUT_MAX_NODES
      ? await layoutInWorker(graph, settings, (stop) => { stopWorker = stop; })
      : await computeLayout(graph, settings, () => cancelled, yieldToUi);
  if (running === job) running = null;
  if (pos && !cancelled) cache.set(vault, { key, pos });
  finish();
}

/** The same layout on a worker of its own, thrown away once it has answered. */
function layoutInWorker(
  graph: Graph,
  settings: GraphSettings,
  onStart: (stop: () => void) => void,
): Promise<LayoutPositions | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./prelayoutWorker.ts", import.meta.url), { type: "module" });
    const finish = (pos: LayoutPositions | null) => {
      worker.terminate();
      resolve(pos);
    };
    onStart(() => finish(null));
    worker.onerror = () => finish(null);
    worker.onmessage = (e: MessageEvent<LayoutPositions | null>) => finish(e.data);
    worker.postMessage({ graph, settings });
  });
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 16);
  });
}
