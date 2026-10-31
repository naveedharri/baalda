import type { Force, Simulation } from "d3-force";
import type { Graph } from "./buildGraph";
import { layoutScale, type SimLink, type SimNode } from "./simulation";

/**
 * Redesign entrance seed: start every note where its cluster will be, so the
 * live simulation only has to bloom the clusters open rather than untangle a
 * spiral. Hubs go on a wide golden spiral spaced by how much they hold; each
 * other note starts beside its busiest already-placed neighbour; notes with no
 * placed neighbour go on an outer ring.
 */
export function seedByCluster(nodes: SimNode[], graph: Graph): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, SimNode[]>();
  for (const e of graph.edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push(b);
    (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push(a);
  }
  const order = [...nodes].sort((a, b) => b.linkCount - a.linkCount);
  const hubs = order.filter((n) => n.hub);
  const reach = (n: SimNode) => n.radius + 34 + 11 * Math.sqrt(n.linkCount);
  const step = hubs.length
    ? (hubs.reduce((sum, h) => sum + reach(h), 0) / hubs.length) * 1.15
    : 60;
  const placed = new Set<string>();
  hubs.forEach((h, k) => {
    const a = k * 2.399963;
    const r = Math.sqrt(k + 0.5) * step;
    h.x = Math.cos(a) * r;
    h.y = Math.sin(a) * r;
    placed.add(h.id);
  });
  // Deterministic jitter so a reopen forms the same way.
  const jitter = (i: number) => {
    const a = i * 2.399963;
    const d = 14 + ((i * 9301 + 49297) % 233280) / 233280 * 22;
    return [Math.cos(a) * d, Math.sin(a) * d];
  };
  let pending = order.filter((n) => !placed.has(n.id));
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const next: SimNode[] = [];
    pending.forEach((n, i) => {
      let anchor: SimNode | null = null;
      for (const m of adj.get(n.id) ?? []) {
        if (placed.has(m.id) && (!anchor || m.linkCount > anchor.linkCount)) anchor = m;
      }
      if (!anchor) return void next.push(n);
      const [jx, jy] = jitter(i + pass * 7919);
      n.x = anchor.x + jx;
      n.y = anchor.y + jy;
      n.cluster = anchor.hub ? anchor : anchor.cluster;
      placed.add(n.id);
    });
    pending = next;
  }
  const outer = (Math.sqrt(hubs.length + 1) + 1) * step;
  pending.forEach((n, i) => {
    const a = i * 2.399963;
    n.x = Math.cos(a) * outer;
    n.y = Math.sin(a) * outer;
  });
}

// Tuned 2026-10-30: ~170 live ticks. The faster 0.035 cooling (~75 ticks) stopped
// before the hubs had pushed their clusters apart, so the flowers never opened.
// Live bloom entrance (how force-graph and Obsidian do it: the visible settle IS
// the animation). From the cluster seed, a few warm-up ticks run before the
// first paint with collision off, then the loop ticks live from BLOOM_ALPHA with
// faster cooling; collision joins once things have spread, and the normal slow
// cooling comes back when the bloom is over.
const BLOOM_ALPHA = 0.6;
const BLOOM_DECAY = 0.02;
const BLOOM_WARMUP_TICKS = 15;
const BLOOM_COLLIDE_BELOW = 0.15;
const BLOOM_END_ALPHA = 0.03;
const BLOOM_SETTLE_SPEED = 0.0008;
const BLOOM_MAX_HOLD = 400;
export type BloomJob = {
  decay: number;
  collide: Force<SimNode, SimLink> | undefined;
  held: number;
  scale: number;
};

export function beginBloom(
  sim: Simulation<SimNode, SimLink>,
  running?: BloomJob | null,
): BloomJob {
  // A reseed can start a new bloom while one is still running, when collision is
  // detached and the cooling sped up: carry the originals over, or collision
  // would be lost for the rest of the session.
  const job: BloomJob = {
    decay: running?.decay ?? sim.alphaDecay(),
    collide: running?.collide ?? sim.force("collide"),
    held: 0,
    scale: 0,
  };
  sim.force("collide", null);
  sim.alpha(BLOOM_ALPHA).alphaDecay(BLOOM_DECAY);
  sim.tick(BLOOM_WARMUP_TICKS);
  return job;
}

/**
 * Called once per frame before the live tick; true once the bloom is over.
 *
 * The end is judged by MOTION, not by alpha alone: alpha reaching its floor
 * while the clusters were still pushing apart froze the view mid-bloom (a
 * click's drag reheat was what let it finish). Below BLOOM_END_ALPHA it holds
 * alpha there until the mean node speed drops under BLOOM_SETTLE_SPEED of the
 * layout's radius per tick, capped at BLOOM_MAX_HOLD ticks.
 */
export function bloomStep(sim: Simulation<SimNode, SimLink>, job: BloomJob): boolean {
  if (job.collide && !sim.force("collide") && sim.alpha() < BLOOM_COLLIDE_BELOW) {
    sim.force("collide", job.collide);
  }
  if (sim.alpha() > BLOOM_END_ALPHA) return false;
  const nodes = sim.nodes();
  if (job.held % 20 === 0) job.scale = layoutScale(nodes);
  job.held++;
  let speed = 0;
  for (const n of nodes) speed += Math.hypot(n.vx, n.vy);
  speed /= Math.max(1, nodes.length);
  if (job.held < BLOOM_MAX_HOLD && speed > job.scale * BLOOM_SETTLE_SPEED) {
    sim.alpha(BLOOM_END_ALPHA);
    return false;
  }
  sim.alphaDecay(job.decay);
  if (job.collide && !sim.force("collide")) sim.force("collide", job.collide);
  return true;
}
