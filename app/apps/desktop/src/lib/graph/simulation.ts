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

/** Spoke length past the hub's own edge, in world units. */
export const SPOKE_LENGTH = 44;
/** Spokes are stiff so leaves ring their hub instead of trailing off. */
export const SPOKE_STRENGTH = 0.5;
/** Note–note ties: weak, so a cross-cluster link can't haul clusters together. */
const NOTE_LINK_STRENGTH = 0.3;
/** A link between notes of two different clusters (see configureForces). */
const CROSS_CLUSTER_STRENGTH = 0.1;
/** How far one note's repulsion reaches, in world units. */
const CHARGE_REACH = 90;
/** Push of a note that is not a hub (see configureForces). */
const LEAF_CHARGE = -45;
const SMALL_VAULT_FULL = 5000;
/**
 * Collision radius. Capped: d3's collide visits every quadtree cell within the
 * LARGEST radius in it, so a few 40-unit hubs made each tick scan a wide area
 * around every note (~35ms at 5k). Spokes and hub separation already keep space
 * around hubs, so collision only has to stop neighbours overlapping.
 */
const COLLIDE_MAX = 18;
function collideRadius(r: number): number {
  const c = Math.min(r, COLLIDE_MAX);
  return c + 4 + c * 0.35;
}

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
  /** One of the vault's busiest notes (see markHubs): a starburst centre. */
  hub?: boolean;
  /** The hub this note's cluster belongs to (set by the seed); moves with it. */
  cluster?: SimNode;
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

/**
 * Inertia by weight. d3 treats every node as the same mass, so a 300-link hub
 * gets shoved around by its leaves exactly as hard as they get shoved by it.
 * Dividing each node's velocity change this tick by a mass that grows with its
 * size makes a hub hold its ground and the leaves do the moving around it.
 * Area-proportional like the charge, capped so a giant hub is not immovable.
 */
export const MASS_MAX = 5;
function createMass() {
  let nodes: SimNode[] = [];
  let mass = new Float32Array(0);
  let lastVx = new Float32Array(0);
  let lastVy = new Float32Array(0);
  const force = (alpha: number) => {
    // At rest the layout only drifts; weight there would just make hubs lag.
    const active = alpha > IDLE_ALPHA * 2;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const m = active ? mass[i] : 1;
      if (m <= 1) {
        lastVx[i] = n.vx * VELOCITY_RETAINED;
        lastVy[i] = n.vy * VELOCITY_RETAINED;
        continue;
      }
      // Only the change since last tick is scaled, so a heavy node keeps its
      // momentum (and its share of the drift) instead of being frozen.
      n.vx = lastVx[i] + (n.vx - lastVx[i]) / m;
      n.vy = lastVy[i] + (n.vy - lastVy[i]) / m;
      lastVx[i] = n.vx * VELOCITY_RETAINED;
      lastVy[i] = n.vy * VELOCITY_RETAINED;
    }
  };
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
    mass = new Float32Array(ns.length);
    lastVx = new Float32Array(ns.length);
    lastVy = new Float32Array(ns.length);
    for (let i = 0; i < ns.length; i++) {
      const rel = ((ns[i].radius || MIN_RADIUS) / MIN_RADIUS) ** 2;
      mass[i] = Math.min(MASS_MAX, Math.max(1, Math.sqrt(rel)));
    }
  };
  return force;
}

/**
 * Hub separation. Repulsion is cut off at a short range (see configureForces),
 * which keeps a big cloud filled but lets whole clusters slide over each other,
 * and gravity pulls the heaviest hubs hardest to the centre: together that
 * stacks every starburst into one round mass. This pushes the hubs (the most
 * linked notes, few enough for an O(h²) pass) apart until each one's cluster
 * has room, sized from how many leaves it has to hold.
 */
export const HUB_MIN_LINKS = 6;

/**
 * Mark the hubs: the busiest notes BY RANK, not every note past a fixed link
 * count. With a fixed bar a 5k vault had hundreds of "hubs", each drawn big and
 * each pushing the others away, which is a fog, not a set of starbursts. About
 * √n/2 of them (6..60), and never one with fewer than HUB_MIN_LINKS links.
 */
export function markHubs(nodes: SimNode[]): void {
  const want = Math.max(6, Math.min(60, Math.round(Math.sqrt(nodes.length) * 0.5)));
  const degrees = nodes.map((n) => n.linkCount ?? 0).sort((a, b) => b - a);
  const bar = Math.max(HUB_MIN_LINKS, degrees[Math.min(want, degrees.length) - 1] ?? Infinity);
  for (const n of nodes) n.hub = (n.linkCount ?? 0) >= bar;
}
const HUB_MAX = 80;
const HUB_SEPARATION_STRENGTH = 0.5;
const HUB_CENTER_MAX = 0.06;
const NOTE_CENTER_MAX = 0.02;
/** World units of cluster radius per √(links): leaves pack a disc around the hub. */
const CLUSTER_SPREAD = 13;
/** Clear space kept between neighbouring clusters, in world units. */
const CLUSTER_GAP = -120;
/** How far past SPOKE_LENGTH the longest spokes reach (see configureForces). */
const SPOKE_REACH = 1.9;
/** A stable 0..1 per note, so a leaf keeps its spoke length between runs. */
function spokeJitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
/** How much room a hub's whole cluster claims, gap included. */
function clusterReach(n: SimNode): number {
  return n.radius + SPOKE_LENGTH + CLUSTER_SPREAD * Math.sqrt(n.linkCount) + CLUSTER_GAP / 2;
}
function createHubSeparation() {
  let hubs: SimNode[] = [];
  let members: SimNode[] = [];
  let reach = new Float32Array(0);
  let push = new Map<SimNode, { x: number; y: number }>();
  const force = (alpha: number) => {
    // Shapes the layout while it forms; at rest it would only fight the drift.
    if (alpha <= IDLE_ALPHA * 2) return;
    for (const p of push.values()) p.x = p.y = 0;
    for (let i = 0; i < hubs.length; i++) {
      for (let j = i + 1; j < hubs.length; j++) {
        const a = hubs[i];
        const b = hubs[j];
        let dx = b.x + b.vx - a.x - a.vx;
        let dy = b.y + b.vy - a.y - a.vy;
        let d = Math.hypot(dx, dy);
        const want = reach[i] + reach[j];
        if (d >= want) continue;
        if (d < 1e-3) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d = Math.hypot(dx, dy);
        }
        const k = ((want - d) / d) * HUB_SEPARATION_STRENGTH * alpha * 0.5;
        const pa = push.get(a)!;
        const pb = push.get(b)!;
        pa.x -= dx * k;
        pa.y -= dy * k;
        pb.x += dx * k;
        pb.y += dy * k;
      }
    }
    // Move each cluster as one body: a hub pushed alone left its notes trailing
    // behind it, and every starburst read as a comet with the hub on its rim.
    for (const [h, p] of push) {
      h.vx += p.x;
      h.vy += p.y;
    }
    for (const n of members) {
      const p = push.get(n.cluster!);
      if (!p) continue;
      n.vx += p.x;
      n.vy += p.y;
    }
  };
  force.initialize = (ns: SimNode[]) => {
    hubs = ns
      .filter((n) => n.hub)
      .sort((a, b) => b.linkCount - a.linkCount)
      .slice(0, HUB_MAX);
    push = new Map(hubs.map((h) => [h, { x: 0, y: 0 }]));
    members = ns.filter((n) => !n.hub && n.cluster && push.has(n.cluster));
    reach = Float32Array.from(hubs, clusterReach);
  };
  return force;
}

/**
 * Centring only while the layout forms. Left on at rest it kept drawing hubs
 * inward after hub separation had switched off, and over half a minute the
 * middle clusters slid back together into one compact ball.
 */
function formingOnly<F extends ForceX<SimNode> | ForceY<SimNode>>(f: F): F {
  const gated = ((alpha: number) => {
    if (alpha > IDLE_ALPHA * 2) f(alpha);
  }) as unknown as F;
  gated.initialize = (nodes: SimNode[], random: () => number) => f.initialize!(nodes, random);
  (gated as { strength: unknown }).strength = (...args: unknown[]) => {
    const r = (f.strength as (...a: unknown[]) => unknown)(...args);
    return r === f ? gated : r;
  };
  return gated;
}

/** Pull toward the middle of a note's own folder (see createFolderCohesion). */
const FOLDER_PULL = 0.2;
/**
 * Folder regions. Without it a vault whose notes link across folders became one
 * mixed web with the same colour scattered in several places. Each note is
 * drawn gently toward the centre of its folder, so the web stays one blended
 * whole but every folder holds its own region, sharing borders with the next.
 * Notes at the vault root form no region. O(n) per tick.
 */
function createFolderCohesion() {
  let groups: SimNode[][] = [];
  const force = (alpha: number) => {
    const k = FOLDER_PULL * alpha;
    for (const g of groups) {
      let cx = 0;
      let cy = 0;
      for (const n of g) {
        cx += n.x;
        cy += n.y;
      }
      cx /= g.length;
      cy /= g.length;
      for (const n of g) {
        n.vx += (cx - n.x) * k;
        n.vy += (cy - n.y) * k;
      }
    }
  };
  force.initialize = (ns: SimNode[]) => {
    const by = new Map<string, SimNode[]>();
    for (const n of ns) {
      const cut = n.path.lastIndexOf("/");
      if (cut <= 0) continue;
      const dir = n.path.slice(0, cut);
      let g = by.get(dir);
      if (!g) by.set(dir, (g = []));
      g.push(n);
    }
    groups = [...by.values()].filter((g) => g.length > 1);
  };
  return force;
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
    .force("x", formingOnly(forceX<SimNode>(0)))
    .force("y", formingOnly(forceY<SimNode>(0)))
    .force("collide", forceCollide<SimNode>())
    // The one force that never converges — see createFlow(). Starts disabled;
    // the renderer sizes it to the layout on every rebuild.
    // After the layout forces, before the drift: heavy notes resist being
    // pushed, but the ambient drift carries every note alike.
    .force("mass", createMass())
    .force("flow", createFlow())
    // Keeps whole starbursts apart, not just their nodes.
    .force("hubs", createHubSeparation())
    // Groups each folder into its own region of the one shared web.
    .force("folders", createFolderCohesion())
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
  // The clamp grows with the vault: the default repulsion is tuned on a 5k
  // vault, where it sits at the full -6000, and at that strength a few dozen
  // notes buzz instead of settling. Below SMALL_VAULT_FULL notes the ceiling
  // shrinks in proportion, so a small vault keeps the calm it always had.
  const ceiling = 6000 * Math.min(1, n / SMALL_VAULT_FULL) ** 1.25;
  const scaledCharge = Math.max(-ceiling, settings.charge * chargeScale);
  const charge = sim.force("charge") as ForceManyBody<SimNode>;
  // Repulsion PER NODE, scaled by its own size — the solar-system half of the
  // model. A uniform charge made every node push equally hard, so a hub and a
  // leaf cleared the same space and the layout had no sense of scale; giving the
  // big ones a bigger field means they hold open a neighbourhood and the small
  // ones settle into orbit around them. Area-proportional (r²/rMin², capped) so
  // it tracks the visual size rather than fighting it.
  const rMin = MIN_RADIUS;
  // Starburst layout: only hubs carry the strong, size-scaled push. A note
  // inside a cluster gets a small one, just enough to keep its neighbours off
  // it; a strong push on every note made neighbouring flowers' notes shove each
  // other harder than their spokes could hold them, and the flowers blended.
  charge.strength((d: SimNode) => {
    if (!d.hub) return Math.max(scaledCharge, LEAF_CHARGE);
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
  // Redesign: hub separation (createHubSeparation) now keeps whole clusters
  // apart, so repulsion only has to space neighbours. A short reach and a
  // coarser Barnes–Hut cut it from ~40ms to a few ms a tick on 5k notes, which
  // is what lets the graph settle in about a second instead of tens.
  charge.distanceMin(1).distanceMax(CHARGE_REACH).theta(1.2);

  // Starburst layout: a link that ends at a leaf (one or two links) is a short,
  // stiff spoke that holds the leaf close around its hub; links between two
  // connected notes keep the long, soft spring so clusters sit well apart.
  const link = sim.force("link") as ForceLink<SimNode, SimLink>;
  // Three kinds of link: hub–hub keeps the long soft spring (clusters apart),
  // hub–note is a short stiff spoke (notes hug their hub), and note–note is a
  // short weak tie so neighbours sit near each other without dragging clusters
  // together across the map.
  const ends = (l: SimLink) => [l.source as SimNode, l.target as SimNode] as const;
  link
    .distance((l) => {
      const [s, t] = ends(l);
      // Never shorter than the room both clusters claim: a shorter hub link
      // undid hub separation the moment the layout came to rest.
      if (s.hub && t.hub) return Math.max(settings.linkDistance, clusterReach(s) + clusterReach(t));
      if (s.hub || t.hub) {
        const hub = s.hub ? s : t;
        const leaf = s.hub ? t : s;
        // Each leaf gets its own spoke length, most short and a few long, so a
        // cluster is dense at the hub and thins out into loose rays at the
        // edge instead of ending in a hard rim.
        return hub.radius * 1.6 + SPOKE_LENGTH * (0.7 + SPOKE_REACH * spokeJitter(leaf.id) ** 2);
      }
      return SPOKE_LENGTH * 1.5;
    })
    .strength((l) => {
      const [s, t] = ends(l);
      if (s.hub && t.hub) return settings.linkStrength;
      // A tie that crosses into another cluster stays a hint: at full strength
      // hundreds of them hauled every cluster back into one compact ball once
      // the layout came to rest.
      const sc = s.hub ? s : s.cluster;
      const tc = t.hub ? t : t.cluster;
      if (sc && tc && sc !== tc) return CROSS_CLUSTER_STRENGTH;
      if (s.hub || t.hub) return SPOKE_STRENGTH;
      return NOTE_LINK_STRENGTH;
    });

  // Gravity slider scales the center pull; each node's own mass (weight) makes
  // heavier nodes pull harder toward the single center point. A small floor
  // keeps *some* centering even at gravity 0, so strong repulsion can't fling
  // the graph off-screen. Clamp to [0,1] so the force never overshoots.
  const gravity = Math.max(0.04, settings.gravity);
  // Hubs get a capped pull: weight made the busiest hubs the most strongly
  // centred, which beat hub separation and stacked every cluster into a ball.
  // Like the reference apps, centring is only there to stop drift off-screen.
  // Leaves are capped too: pulled harder than their hub, they trailed inward
  // and every starburst became a comet with its hub on the rim.
  // A note that belongs to a cluster feels no centre pull: it moves with its
  // hub (hub separation carries the cluster), so gravity can't drag it out of
  // its flower toward the middle. Hubs and loose notes keep a capped pull.
  const centerStrength = (d: SimNode) =>
    d.cluster && !d.hub ? 0 : Math.min(d.hub ? HUB_CENTER_MAX : NOTE_CENTER_MAX, gravity * (d.weight ?? 0.12));
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
    .radius((d) => collideRadius(d.radius))
    .strength(0.7);
}
