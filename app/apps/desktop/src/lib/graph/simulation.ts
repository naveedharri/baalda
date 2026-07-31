import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type ForceCollide,
} from "d3-force";
import type { GraphSettings } from "./graphSettings";
import type { GraphNode } from "./buildGraph";

/**
 * d3-force wrapper driven MANUALLY by the canvas renderer.
 *
 * WHY manual ticks: d3-force normally owns an internal timer that fires
 * `tick` events on its own schedule. We stop that timer (`.stop()`) and call
 * `sim.tick()` ourselves from the renderer's requestAnimationFrame loop. This
 * keeps physics and painting on a single frame clock — no double scheduling,
 * no tearing between "where a node is" and "where we drew it", and it lets the
 * renderer pause/resume the sim (e.g. when the tab is hidden or fully settled).
 *
 * d3 INIT ORDER the renderer must follow:
 *   1. sim.nodes(simNodes)            // seed nodes FIRST — forces read this array
 *   2. link.links(simLinks)           // then set links; forceLink resolves the
 *                                     //   {source,target} id strings into node
 *                                     //   refs IN PLACE against the current nodes
 * Setting links before nodes (or swapping nodes without re-setting links) leaves
 * the link force pointing at stale/missing refs. Order matters.
 */

export const MIN_RADIUS = 4;
export const MAX_RADIUS = 24;

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  /** BASE radius from linkCount; renderer applies the nodeSize multiplier later. */
  radius: number;
  /**
   * Centering "mass" derived from a node's degree. It scales the strength of the
   * gravity toward the single center point (0,0): heavier (more edges) → stronger
   * pull → settles closer to the exact center; orphans → weak pull → drift to the
   * edge. Set by the renderer on (re)build; consumed by the x/y forces.
   */
  weight: number;
}

export interface SimLink {
  // Renderer supplies {source: id, target: id}; forceLink().id() rewrites these
  // to SimNode refs during resolution, so the type spans both states.
  source: string | SimNode;
  target: string | SimNode;
}

/** Sublinear growth so hubs stay bounded; clamped to the visual radius band. */
export function nodeRadius(linkCount: number): number {
  return Math.max(
    MIN_RADIUS,
    Math.min(MIN_RADIUS + Math.sqrt(linkCount) * 2.2, MAX_RADIUS),
  );
}

/**
 * Centering mass for a node, from its degree. Real-physics feel: the heaviest
 * node (most edges) gets the strongest pull toward the one center point and
 * settles dead-center; equal-weight nodes settle at an equal distance (they can
 * crowd close but repulsion/collision keeps them apart); orphans get the weakest
 * pull and are left on the rim. Consumed as an x/y force strength multiplier.
 */
export function centerWeight(linkCount: number, maxDegree: number): number {
  const importance = maxDegree > 0 ? linkCount / maxDegree : 0;
  // Floor so even orphans drift gently inward; exponent < 1 spreads the mid-tier.
  return 0.12 + Math.pow(importance, 0.7) * 1.4;
}

export function createSimulation(
  settings: GraphSettings,
): Simulation<SimNode, SimLink> {
  const sim = forceSimulation<SimNode, SimLink>()
    .force("charge", forceManyBody<SimNode>())
    .force(
      "link",
      forceLink<SimNode, SimLink>().id((d) => d.id),
    )
    // Centering: gravity toward the ONE center point (0,0), with per-node
    // strength scaled by mass (weight). Heavier nodes are pulled harder and
    // settle dead-center; light ones barely feel it and stay out.
    .force("x", forceX<SimNode>(0))
    .force("y", forceY<SimNode>(0))
    .force("collide", forceCollide<SimNode>())
    // Slow, calm cooling (~650 ticks to settle). Stretched 1.5x vs the baseline
    // 0.0155 so the (now more damped) motion still reaches equilibrium.
    .alphaDecay(0.0103)
    // Damping: 0.70 — heavy friction so nodes drift back slowly and calmly after
    // a drag (~2x slower again vs 0.52; steady velocity ∝ (1-vd)/vd).
    .velocityDecay(0.7)
    // CRUCIAL: renderer ticks manually inside its own rAF loop.
    .stop();

  configureForces(sim, settings);
  return sim;
}

/**
 * Re-apply tunable params WITHOUT touching node positions — safe to call live
 * as sliders move. Only force parameters change; nodes()/links() are untouched.
 */
export function configureForces(
  sim: Simulation<SimNode, SimLink>,
  settings: GraphSettings,
): void {
  // Repulsion scales with graph size. A fixed strength that spaces a ~20-node
  // local graph nicely lets a 5k global graph collapse into a dense ball, so we
  // grow it ~√n (identity for small graphs, much stronger for large ones). This
  // keeps node spacing roughly consistent as the vault grows.
  const n = Math.max(1, sim.nodes().length);
  const chargeScale = Math.max(1, Math.sqrt(n) / 3);
  // Clamp the scaled repulsion so an extreme slider value on a big graph can't
  // send nodes to infinity (with weak/zero gravity the layout would explode).
  const scaledCharge = Math.max(-6000, settings.charge * chargeScale);
  const charge = sim.force("charge") as ForceManyBody<SimNode>;
  charge.strength(scaledCharge);
  // CRUCIAL for large graphs: cap the RANGE of repulsion so each node only
  // pushes against nearby neighbors, not every node in the vault. Without a
  // cutoff, global many-body repulsion on thousands of nodes evacuates the
  // center and blows the layout out into a hollow shell/ring, and the O(n)
  // far-field never lets the sim cool (it looks "stuck"). A local cutoff keeps
  // the cloud filled and lets it settle quickly. Scaled to the natural node
  // spacing (collide keeps nodes ~radius+5 apart) so it stays local as the
  // graph grows; floored so tiny graphs still get a sensible neighborhood.
  const spacing = MAX_RADIUS + 5;
  charge.distanceMin(1).distanceMax(Math.max(120, spacing * 8));

  const link = sim.force("link") as ForceLink<SimNode, SimLink>;
  link.distance(settings.linkDistance).strength(settings.linkStrength);

  // Gravity slider scales the center pull; each node's own mass (weight) makes
  // heavier nodes pull harder toward the single center point. A small floor
  // keeps *some* centering even at gravity 0, so strong repulsion can't fling
  // the graph off-screen. Clamp to [0,1] so the force never overshoots.
  const gravity = Math.max(0.04, settings.gravity);
  const centerStrength = (d: SimNode) =>
    Math.max(0, Math.min(1, gravity * (d.weight ?? 0.12)));
  (sim.force("x") as ForceX<SimNode>).strength(centerStrength);
  (sim.force("y") as ForceY<SimNode>).strength(centerStrength);

  // A little extra margin beyond each node's visual radius so nodes keep some
  // breathing room instead of touching — the even, spaced look of a good graph.
  (sim.force("collide") as ForceCollide<SimNode>)
    .radius((d) => d.radius + 5)
    .strength(0.85);
}
