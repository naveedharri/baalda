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

// A wider band than before (was 4..24). The point of sizing by degree is that a
// hub should be unmistakable next to a leaf, and a 6× span reads as "one of these
// is a sun and those are pebbles" where 6..24 read as "all roughly the same".
export const MIN_RADIUS = 3.2;
export const MAX_RADIUS = 40;

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

/**
 * Velocity retained per tick — the complement of `.velocityDecay(0.7)` below.
 * The flow force needs it to convert "how fast a node should drift" into the
 * per-tick pull that produces that speed once damping is applied.
 */
const VELOCITY_RETAINED = 0.3;

/**
 * Floor the alpha never falls below while the graph is on screen.
 *
 * A d3 layout that reaches equilibrium is *motionless*, and alpha alone can't
 * change that: at equilibrium the forces cancel, so a "hot" settled graph looks
 * exactly like a cold one. What keeps it alive is the flow force below; this
 * floor keeps the restoring forces (link/gravity) barely awake alongside it so
 * the drift stays a drift and never becomes a deformation of the layout.
 *
 * Deliberately TINY. The alpha-scaled forces are the shaky ones at rest:
 * many-body is a Barnes–Hut approximation, so a node crossing a quadtree cell
 * boundary gets a small discontinuous kick, and at any meaningful alpha those
 * kicks are what read as vibration. At 0.012 they are a whisper and the smooth
 * flow field is what you actually see.
 */
export const IDLE_ALPHA = 0.012;

/**
 * Alpha held while a node is being dragged, and the ceiling for any other live
 * disturbance (a settings change, a data refresh).
 *
 * This number IS the smoothness of the whole view, and it used to be 0.3.
 * d3 integrates with a plain explicit step, so alpha is effectively the step
 * size on a stiff system of springs and inverse-square repulsion: past a point
 * every correction overshoots, the next one over-corrects back, and the graph
 * buzzes. Measured over the three seconds after a drag, the mean frame-to-frame
 * direction change of a node goes 18.7° at alpha 0.3 → 5.6° at 0.12 → 2.7° at
 * 0.06, and outright reversals (the thing seen as vibration) go 9.7% → 1.8% →
 * 0.5% of frames. 0.06 is where the motion stops reading as shake and starts
 * reading as weight, while the neighbours still visibly give way — collision is
 * not alpha-scaled, so a dragged node keeps shouldering its neighbours aside
 * exactly as hard as before.
 */
export const DRAG_ALPHA = 0.06;

/**
 * Alpha for a change that genuinely needs the layout to rearrange — a physics
 * slider, or new notes arriving. Higher than a drag because something structural
 * actually has to move, still far below the old 0.3.
 */
export const REARRANGE_ALPHA = 0.15;

/**
 * Resting drift speed, as a fraction of the layout's own radius per second.
 * Relative rather than absolute so a 40-note vault and a 5000-note one drift by
 * the same amount *on screen* — the camera fits the graph, so a fixed
 * world-unit speed would be obvious on one and invisible on the other.
 */
const FLOW_SPEED_FRACTION = 0.017;

/**
 * The flow asks for a velocity; the layout's own springs pull some of it back
 * on the same tick, so a node never reaches the asked-for speed. This is the
 * measured shortfall on settled layouts (see the drift tests), applied so that
 * FLOW_SPEED_FRACTION means what it says on screen rather than four times less.
 */
const FLOW_SPRING_LOSS = 1.9;

/** How hard a node is pulled toward the local flow velocity, per tick. */
const FLOW_RELAX = 0.12;

/**
 * Fraction of the field velocity a node actually reaches in steady state.
 * From v' = (v(1−F) + V·F)·d  ⇒  v = dFV / (1 − d(1−F)).
 */
const FLOW_GAIN =
  (VELOCITY_RETAINED * FLOW_RELAX) /
  (1 - VELOCITY_RETAINED * (1 - FLOW_RELAX));

/**
 * Three long plane waves whose curl makes up the flow. `wavelength` is in units
 * of the layout radius — all of them are BIGGER than the gaps between nodes, on
 * purpose: that is what makes neighbours move together instead of shouldering
 * into each other. `period` is the time (seconds) for the wave to reverse, which
 * is also what bounds how far a node can travel before it is carried back.
 */
const FLOW_WAVES = [
  { angle: 0.35, wavelength: 1.4, period: 12, amp: 1.0 },
  { angle: 2.31, wavelength: 0.9, period: 17, amp: 0.55 },
  { angle: 4.19, wavelength: 0.6, period: 8, amp: 0.3 },
];
/**
 * Typical magnitude of the summed waves. RMS, not the sum of the amplitudes:
 * the waves are at different phases and angles, so they never all peak at once
 * and adding them up would over-state the speed by better than a factor of two.
 */
const FLOW_AMP_NORM = Math.sqrt(
  FLOW_WAVES.reduce((s, w) => s + w.amp * w.amp, 0) / 2,
);
/** Mass factor for the lightest nodes — the ones the drift speed is quoted for. */
const FLOW_MASS_BIAS = 0.35;
const LEAF_MASS = 1 / (1 + FLOW_MASS_BIAS * 0.12);
const TAU = Math.PI * 2;
const TICKS_PER_SECOND = 60;

export interface FlowForce {
  (alpha: number): void;
  initialize(nodes: SimNode[]): void;
  /** Layout radius in world units — sets both wavelength and speed. 0 disables. */
  scale(rms: number): FlowForce;
  /** Multiplier on the drift speed. 1 at rest; higher during the entrance. */
  energy(multiplier: number): FlowForce;
}

/**
 * The "alive" force: a slow, perpetual current the whole graph floats in.
 *
 * WHY it exists: everything else here converges. Once the layout settles, a
 * force graph is a still photograph — which is what the graph used to open as,
 * and it read as broken until you grabbed a node and woke it up. This force
 * never converges and never scales with alpha, so the field keeps drifting at
 * rest while the real forces continue to hold the shape.
 *
 * WHY a field and not per-node wander: the first version gave every node its own
 * phase, which meant adjacent nodes routinely drifted in opposite directions —
 * so the link springs and the collision force spent every tick correcting them
 * and the whole graph vibrated. Here the velocity is read from ONE smooth
 * spatial field, so a cluster moves almost as a body and there is nothing for
 * the other forces to fight. It is the curl of a scalar potential, which makes
 * it divergence-free: the flow shears and swirls but never compresses nodes
 * into each other. That is the laminar part.
 *
 * Bounded by construction: each wave reverses on its own period, so a node is
 * carried out and then carried back rather than wandering off.
 *
 * The pull is a relaxation toward the field velocity, not a shove: it doubles as
 * a smoother, bleeding off any high-frequency jitter a node picked up elsewhere.
 */
export function createFlow(): FlowForce {
  let nodes: SimNode[] = [];
  let layout = 0;
  let energy = 1;
  let tick = 0;
  const force = (() => {
    tick += 1;
    if (layout <= 0 || nodes.length === 0) return;
    const seconds = tick / TICKS_PER_SECOND;
    // World units per tick a light node should actually travel at energy 1,
    // converted into the field velocity that produces it.
    const speed =
      ((FLOW_SPEED_FRACTION * layout * energy) / TICKS_PER_SECOND) *
      (FLOW_SPRING_LOSS / (FLOW_GAIN * FLOW_AMP_NORM * LEAF_MASS));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.fx != null || n.fy != null) continue; // pinned (dragged) — leave alone
      let vx = 0;
      let vy = 0;
      for (let w = 0; w < FLOW_WAVES.length; w++) {
        const { angle, wavelength, period, amp } = FLOW_WAVES[w];
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const k = TAU / (wavelength * layout);
        const phase = k * (n.x * ca + n.y * sa) + (TAU * seconds) / period;
        // v = curl(ψ) for ψ = (amp/k)·sin(phase): perpendicular to the wave
        // vector, constant along it — a sheet of fluid sliding past its
        // neighbour rather than a scatter of independent wanderers.
        const c = Math.cos(phase) * amp;
        vx += sa * c;
        vy += -ca * c;
      }
      // Heavier nodes are less carried: a hub holds its place while the leaves
      // around it drift, which is what makes the motion read as orbital rather
      // than as the whole picture sliding sideways.
      const m = speed * (1 / (1 + FLOW_MASS_BIAS * (n.weight ?? 0.12)));
      n.vx += (vx * m - n.vx) * FLOW_RELAX;
      n.vy += (vy * m - n.vy) * FLOW_RELAX;
    }
  }) as unknown as FlowForce;
  force.initialize = (n: SimNode[]) => {
    nodes = n;
  };
  force.scale = (rms: number) => {
    layout = rms;
    return force;
  };
  force.energy = (multiplier: number) => {
    energy = multiplier;
    return force;
  };
  return force;
}

/**
 * The layout's own radius: RMS distance from its centroid. Everything
 * scale-relative (flow speed, flow wavelength) is measured against this, so the
 * graph behaves identically whether it holds 40 notes or 5000.
 */
export function layoutScale(nodes: SimNode[]): number {
  if (nodes.length === 0) return 0;
  let cx = 0;
  let cy = 0;
  for (const n of nodes) {
    cx += n.x;
    cy += n.y;
  }
  cx /= nodes.length;
  cy /= nodes.length;
  let sum = 0;
  for (const n of nodes) {
    const dx = n.x - cx;
    const dy = n.y - cy;
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / nodes.length);
}

/**
 * Radius from degree. Still sublinear — a 1200-link hub cannot be 1200× a leaf —
 * but on a gentler exponent than √ so the mid-tier actually spreads out.
 *
 * `^0.62` rather than `^0.5`: with √, degrees 1 and 9 differ by 3× in radius
 * while 100 and 900 also differ by 3×, which flattens exactly the range most
 * notes live in. The higher exponent keeps pulling the low-to-mid range apart
 * before the clamp catches the true outliers.
 */
export function nodeRadius(linkCount: number): number {
  return Math.max(
    MIN_RADIUS,
    Math.min(MIN_RADIUS + Math.pow(Math.max(0, linkCount), 0.62) * 2.4, MAX_RADIUS),
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
  // Floor so even orphans drift gently inward. The exponent is well under 1
  // because `importance` is a ratio against the single biggest hub: on a
  // heavy-tailed vault almost every node scores near 0, so a linear (or worse,
  // super-linear) curve would give the entire graph the floor weight and only the
  // one hub any mass at all. 0.45 lifts the middle of the distribution enough
  // that a moderately-linked note is meaningfully heavier than a leaf.
  return 0.12 + Math.pow(importance, 0.45) * 1.9;
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
    // The one force that never converges — see createFlow(). Starts disabled;
    // the renderer sizes it to the layout on every rebuild.
    .force("flow", createFlow())
    // Slow, calm cooling (~650 ticks to settle). Stretched 1.5x vs the baseline
    // 0.0155 so the (now more damped) motion still reaches equilibrium.
    .alphaDecay(0.0103)
    // Damping: 0.70 — heavy friction so nodes drift back slowly and calmly after
    // a drag (~2x slower again vs 0.52; steady velocity ∝ (1-vd)/vd).
    // Keep VELOCITY_RETAINED (= 1 - this) in step: the drift force inverts it.
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
  // Repulsion PER NODE, scaled by its own size — the solar-system half of the
  // model. A uniform charge made every node push equally hard, so a hub and a
  // leaf cleared the same space and the layout had no sense of scale; giving the
  // big ones a bigger field means they hold open a neighbourhood and the small
  // ones settle into orbit around them. Area-proportional (r²/rMin², capped) so
  // it tracks the visual size rather than fighting it.
  const rMin = MIN_RADIUS;
  charge.strength((d: SimNode) => {
    const rel = Math.min(6, ((d.radius || rMin) / rMin) ** 2);
    return scaledCharge * (0.5 + rel * 0.5);
  });
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
  // Clearance scales with the node too, so a sun keeps its planets at a distance
  // instead of letting them touch its surface the way a leaf's neighbours do.
  // Strength is deliberately short of 1: collision is the one force d3 does NOT
  // scale by alpha, so at rest it is the loudest thing in the sim. Resolving an
  // overlap in one hard step made settled neighbours trade tiny corrections
  // every tick, which is felt as vibration; easing them apart over several ticks
  // reads as weight instead.
  (sim.force("collide") as ForceCollide<SimNode>)
    .radius((d) => d.radius + 4 + d.radius * 0.35)
    .strength(0.7);
}
