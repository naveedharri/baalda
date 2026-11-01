import { useCallback, useEffect, useRef, useState } from "react";
import type { Simulation, ForceLink } from "d3-force";
import type { Graph } from "../lib/graph/buildGraph";
import { beginBloom, bloomStep, seedByCluster, type BloomJob } from "../lib/graph/formation";
import { saveLayout, takeLayout } from "../lib/graph/prelayout";
import {
  createSimulation,
  configureForces,
  nodeRadius,
  markHubs,
  centerWeight,
  layoutScale,
  IDLE_ALPHA,
  DRAG_ALPHA,
  REARRANGE_ALPHA,
  type FlowForce,
  type SimNode,
  type SimLink,
} from "../lib/graph/simulation";
import { assignColors, type LegendEntry } from "../lib/graph/graphColor";
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type GraphSettings,
} from "../lib/graph/graphSettings";
import { useGraphData } from "../lib/graph/useGraphData";
import { WebGLGraphRenderer, type RenderNode } from "../lib/graph/webglRenderer";
import { SimClient } from "../lib/graph/simClient";
import { graphDebugEnabled } from "../lib/graph/graphDebug";
import {
  GLOBE_MIN_NODES,
  GLOBE_SPIN,
  clampPitch,
  faceRotation,
  facing,
  frameOf,
  toSphere,
  yawToward,
  type GlobeFrame,
  type GlobeRotation,
  type SpherePoint,
} from "../lib/graph/globe";
import {
  CURVE_SEGMENTS,
  curvePull,
  templateLayout,
  writeCurve,
  type TemplateShape,
} from "../lib/graph/templates";
import type { GraphShape } from "../lib/graph/graphSettings";
import { useStore } from "../store";
import { GraphControls } from "./GraphControls";
import { Spinner } from "./Spinner";
import "./graph.css";

// ---------------------------------------------------------------------------
// Immersive, physics-driven note graph. Physics is d3-force (see simulation.ts),
// but we own the clock: the sim's internal timer is stopped and we call
// sim.tick() ourselves inside a requestAnimationFrame loop so painting and
// physics share one frame. React owns only React-y things — data loading, the
// settings panel, the counts the loading states use. Camera / hover / drag / positions all live in
// refs so interaction never triggers a reconciliation pass.
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
const CLICK_DRAG_THRESHOLD = 4; // px moved before a pointerdown counts as a drag
const LABEL_FADE_START = 1.5; // camera.k at which labels begin to appear (labelScale 1)
const LABEL_FADE_END = 2.4; // camera.k at which labels are fully opaque (labelScale 1)
const DEFAULT_FONT_FAMILY = "sans-serif";
const FALLBACK_ACCENT = "#7f73ff";

// How the graph opens (redesign): every note starts where its cluster will be
// (seedByCluster in lib/graph/formation.ts), and the forces then bloom the
// clusters open live on screen, one tick per frame (beginBloom / bloomStep), the
// way force-graph and Obsidian do it. The bloom ends once the notes have stopped
// moving, after which the physics rests at a whisper (IDLE_ALPHA / DRAG_ALPHA)
// and the flow field in simulation.ts carries the gentle resting drift.
// Must match the `graph-heartbeat` keyframes duration in graph.css — the CSS
// drives the scale pulse, this drives the light pulse, and they have to peak
// together or the graph reads as two effects rather than one heartbeat.
const INTRO_MS = 1150;


const CAMERA_EASE = 0.08;
// Opening from a ready layout: how long the notes take to grow into place, and
// how close to the middle they start.
const ASSEMBLE_MS = 900;
const ASSEMBLE_FROM = 0.35;

// Below this alpha the layout is done moving into place, so the auto-fit camera
// locks — a couple of seconds after open, or immediately after a refresh. Without the lock the ambient drift keeps nudging the
// bounding box and the whole viewport breathes its zoom by a percent or two,
// which reads as the picture wobbling rather than the nodes drifting.
const FIT_LOCK_ALPHA = 0.02;
// Redesign: below this the layout's motion is invisible, so the graph rests
// (no ticks, no frames) until something wakes it.
const REST_ALPHA = 0.025;

// How hard a *data refresh* re-energizes the layout. The first build needs real
// energy to find a shape from seeded positions; later rebuilds already have a
// settled layout and only need to absorb what changed, so they get a small warm
// nudge. Reheating those to 1 was what made the graph appear to "reset": every
// `file-changed` event (a whole storm of them while a vault syncs) threw the
// entire layout back to maximum energy and it visibly flew apart and re-settled.
const REHEAT_FIRST = 1;
const REHEAT_REFRESH = 0.1;

// Smallest a node may be drawn on screen, in CSS px of radius. Applied in
// quadrature by the shader (see webglRenderer's VERT), so it is a lift for the
// leaves rather than a ceiling everything piles up against.
const MIN_NODE_PX = 2.1;

// Largest a node is DRAWN, in world units. The physics radius (MAX_RADIUS in
// simulation.ts) also sets collision clearance and the repulsion range, so it
// stays large to keep clusters apart; only the painted disc is capped.
const DRAW_MAX_RADIUS = 40;
// Hubs (the notes the others connect to) are drawn this much bigger than their
// physics radius alone would make them, so each starburst has an obvious centre.
// Collision clearance (simulation.ts) already leaves this much room around them.
const HUB_DRAW_BOOST = 2.6;
function drawRadius(n: SimNode): number {
  const r = Math.min(n.radius, DRAW_MAX_RADIUS);
  return n.hub ? r * HUB_DRAW_BOOST : r;
}

// Fallback cap for the global scope on the 2D canvas, which only stays smooth
// up to a few hundred nodes. The GPU (WebGL) renderer draws the whole vault, so
// this cap only applies when WebGL is unavailable.
const GLOBAL_2D_CAP = 600;
const WEBGL_ENABLED = true;

/**
 * Redesign: the graph's backdrop and edge colours follow the page theme (warm
 * charcoal in dark, cream in light), cached per theme so a frame never reads
 * computed styles.
 */
type GraphTheme = Parameters<WebGLGraphRenderer["setTheme"]>[0];
let graphThemeCache: { key: string; value: GraphTheme } | null = null;
function graphTheme(): GraphTheme {
  const key = document.documentElement.dataset.theme ?? "light";
  if (graphThemeCache?.key === key) return graphThemeCache.value;
  const dark = key === "dark";
  const value: GraphTheme = dark
    ? {
        core: [0.106, 0.1, 0.094], // #1b1a18
        mid: [0.09, 0.086, 0.078],
        rim: [0.071, 0.067, 0.062],
        line: [1, 0.97, 0.925, 0.3],
        hl: [0.65, 0.59, 1, 0.85],
      }
    : {
        core: [1, 1, 1],
        mid: [0.992, 0.984, 0.969],
        rim: [0.976, 0.965, 0.945],
        line: [0.043, 0.039, 0.063, 0.38],
        hl: [0.486, 0.361, 1, 0.75],
      };
  graphThemeCache = { key, value };
  return value;
}

// Links thin out as their number grows. Every line at one fixed opacity piles
// up: a few hundred read as crisp threads, ten thousand as a grey haze that
// hides where one cluster ends and the next begins. √ falloff from
// EDGE_DENSITY_REF links, floored so a huge vault keeps visible connections.
const EDGE_DENSITY_REF = 800;
const EDGE_DENSITY_FLOOR = 0.5;
function edgeDensityScale(edges: number): number {
  return Math.max(EDGE_DENSITY_FLOOR, Math.min(1, Math.sqrt(EDGE_DENSITY_REF / Math.max(1, edges))));
}
let densityThemeCache: { base: GraphTheme; edges: number; value: GraphTheme } | null = null;
function themeForEdges(edges: number): GraphTheme {
  const base = graphTheme();
  if (densityThemeCache?.base === base && densityThemeCache.edges === edges) {
    return densityThemeCache.value;
  }
  const [r, g, b, a] = base.line!;
  const value = { ...base, line: [r, g, b, a * edgeDensityScale(edges)] as typeof base.line };
  densityThemeCache = { base, edges, value };
  return value;
}

// Above this node count, the global graph runs its force layout in a Web Worker
// (see simWorker.ts) so a huge vault (50k+) can settle without freezing the UI
// thread. At or below it, the sim runs inline — proven smooth up to ~5.5k and it
// keeps drag/interaction latency zero. If the Worker API is unavailable, the
// global sim is capped to this size so the main thread can never lock up.
const WORKER_THRESHOLD = 8000;


const SPRITE_SIZE = 256; // resolution of the baked shading / shadow / glow sprites

// Edges are quiet connective threads (source-over), not the old additive bloom
// that washed the whole field into a purple haze.

/**
 * The heartbeat envelope, 0 at rest and peaking on each beat. Two Gaussian bumps
 * at the same instants as the `graph-heartbeat` keyframes: a strong one at 16%
 * and a weaker one at 40%.
 *
 * Gaussians rather than the triangular ramps the keyframes use, because a
 * brightness change wants softer shoulders than a scale change — a linear light
 * ramp has a visible corner at the peak where a size ramp does not.
 */
function heartbeatEnvelope(t: number): number {
  const bump = (center: number, width: number) =>
    Math.exp(-(((t - center) / width) ** 2));
  return Math.min(1, bump(0.16, 0.075) + 0.55 * bump(0.4, 0.06));
}


// Hubs that carry an always-on name tag: the most-linked notes, so each
// starburst is named the way a map names its cities.
const HUB_LABEL_MAX = 24;

/** Rebuild the hub name tags in `layer`; positions are set per frame. */
function syncHubLabels(
  layer: HTMLDivElement | null,
  nodes: SimNode[],
  colorById: Map<string, string>,
): { node: SimNode; el: HTMLDivElement; w: number; h: number }[] {
  if (!layer) return [];
  layer.replaceChildren();
  const hubs = nodes
    .filter((n) => n.hub)
    .sort((a, b) => b.linkCount - a.linkCount)
    .slice(0, HUB_LABEL_MAX);
  return hubs.map((node) => {
    const el = document.createElement("div");
    el.className = "graph-hub-label";
    el.textContent = node.title;
    el.style.setProperty("--hub-color", colorById.get(node.id) ?? "var(--accent)");
    layer.appendChild(el);
    return { node, el, w: 0, h: 0 };
  }).map((label) => {
    // Measured once per rebuild; the per-frame pass only moves them.
    label.w = label.el.offsetWidth;
    label.h = label.el.offsetHeight;
    return label;
  });
}

type Box = { x0: number; x1: number; y0: number; y1: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Screen box of a hover tag (centred under its node, `top: y + 10`). */
function tipBox(x: number, y: number, title: string, main: boolean): Box {
  const w = Math.min(220, title.length * (main ? 7 : 6.4) + (main ? 18 : 14));
  const h = main ? 22 : 19;
  return { x0: x - w / 2 - 2, x1: x + w / 2 + 2, y0: y + 10, y1: y + 10 + h };
}

/** Parse "#rgb"/"#rrggbb" or "rgb()/rgba()" into [r,g,b] 0–255; grey on failure. */
function parseColor(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length >= 6) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v));
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  return [150, 150, 160];
}


/** A soft radial sprite (used for contact shadows and ambient glow). */
function makeRadialSprite(
  size: number,
  rgb: [number, number, number],
  stops: [number, number][],
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  for (const [o, a] of stops)
    grd.addColorStop(o, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

type Drag =
  // On the globe a press never grabs a note: dragging spins the globe, and
  // `pick` is the note under the press, opened if the press turns out a click.
  | { type: "pan"; lastX: number; lastY: number; moved: boolean; pick?: SimNode | null }
  | {
      type: "node";
      node: SimNode;
      startX: number;
      startY: number;
      moved: boolean;
    }
  // Radial / Ring: a note dragged off its fixed spot. It follows the pointer
  // and springs back to its place when let go.
  | {
      type: "spot";
      node: SimNode;
      startX: number;
      startY: number;
      fromDx: number;
      fromDy: number;
      moved: boolean;
    };

/** A note's place on the globe this frame: screen-world position and depth. */
type Placed = SimNode & { gx?: number; gy?: number; gz?: number };

/** Seconds a released Radial / Ring note takes to spring back to its spot. */
const TEMPLATE_SPRING_S = 1.1;

/** Switching shape glides every note from where it was to where it goes. */
const MORPH_MS = 850;

/** A note this far round the edge is turned to face you before it opens. */
const GLOBE_FACE_TO_OPEN = 0.55;
/** Spin rests this long after the last touch before turning again. */
const GLOBE_SPIN_REST_MS = 3500;
/** Radians of turn per pixel dragged. */
const GLOBE_DRAG_TURN = 0.006;
/** The sphere is drawn at this share of the flat layout's radius. */
const GLOBE_SCALE = 0.92;

interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Colors {
  edge: string;
  edgeHighlight: string;
  nodeFallback: string;
  accent: string;
  label: string;
  labelActive: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Read the resolved (var()-free) colors the canvas paints with. */
function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  return {
    edge: get("--border-strong") || "rgba(120,120,140,0.25)",
    edgeHighlight: get("--accent") || FALLBACK_ACCENT,
    nodeFallback: get("--text-tertiary") || "#9a9aa5",
    accent: get("--accent") || FALLBACK_ACCENT,
    // Labels sit on the always-dark void, so they use fixed light-on-dark tones
    // (not theme text vars, which are dark in light mode → invisible). Resting
    // labels stay muted; the open/hover label brightens to full.
    // Redesign: the canvas follows the theme now (cream in light), so labels do too.
    label: document.documentElement.dataset.theme === "dark" ? "rgba(231, 226, 217, 0.55)" : "rgba(26, 25, 32, 0.55)",
    labelActive: document.documentElement.dataset.theme === "dark" ? "#f3eee6" : "#1a1920",
  };
}

/**
 * Build the full SimNode array for a graph, reusing existing node objects so
 * positions/velocities survive a data refresh. New nodes are seeded on a
 * golden-angle spiral near the origin (never all stacked at 0,0, which would
 * blow up the repulsion force on the first tick).
 */
function buildSimNodes(
  graph: Graph,
  previous: Map<string, SimNode>,
  seededEdges: number,
): { nodes: SimNode[]; reseeded: boolean } {
  const built = buildSimNodesRaw(graph, previous);
  markHubs(built);
  // Reseed when most of the graph is new, not only on the very first build:
  // the vault index often lands in stages (an empty or partial first answer,
  // then the rest), and notes arriving after the seed used to be dropped on
  // the old spiral with no cluster, settling into a cloud instead of flowers.
  const arrived = built.reduce((c, n) => c + (previous.has(n.id) ? 0 : 1), 0);
  // Same for links: notes can land before their links do, and a seed with no
  // links has no hubs to gather around.
  const linksArrived = graph.edges.length > seededEdges * 2 + 10;
  const reseeded = arrived > built.length * 0.5 || linksArrived;
  if (reseeded) seedByCluster(built, graph);
  return { nodes: built, reseeded };
}

function buildSimNodesRaw(graph: Graph, previous: Map<string, SimNode>): SimNode[] {
  const n = Math.max(graph.nodes.length, 1);
  const spread = 60 + Math.sqrt(n) * 40;
  const maxDegree = graph.nodes.reduce((m, node) => Math.max(m, node.linkCount), 0);
  return graph.nodes.map((node, i) => {
    // Degree drives BOTH the visual size (bigger = more links) and the centering
    // mass (heavier → stronger pull to the single center point).
    const weight = centerWeight(node.linkCount, maxDegree);
    const prev = previous.get(node.id);
    if (prev) {
      prev.title = node.title;
      prev.path = node.path;
      prev.linkCount = node.linkCount;
      prev.radius = nodeRadius(node.linkCount);
      prev.weight = weight;
      return prev;
    }
    // Seed by weight: heavy nodes near the center, light ones farther out (on a
    // golden-angle spoke) so they drift only a little into their resting orbit.
    const angle = i * 2.399963;
    const r = spread * (1 - Math.min(weight, 1)) + 12;
    return {
      id: node.id,
      title: node.title,
      path: node.path,
      linkCount: node.linkCount,
      radius: nodeRadius(node.linkCount),
      weight,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
  });
}

// Undirected adjacency (node id -> neighbor ids), memoized per Graph instance so
// navigating between notes doesn't rebuild it from the full edge list each time.
const adjacencyCache = new WeakMap<Graph, Map<string, string[]>>();
function adjacencyOf(graph: Graph): Map<string, string[]> {
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of graph.edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  adjacencyCache.set(graph, adj);
  return adj;
}

/** Ids within `depth` link-hops of `startId` (inclusive), following links in
 *  both directions — the node set of the local graph. */
function neighborhoodIds(graph: Graph, startId: string, depth: number): Set<string> {
  const adj = adjacencyOf(graph);
  const seen = new Set<string>([startId]);
  let frontier = [startId];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export function GraphView({ onClose }: { onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hubLayerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Separate GPU canvas for the global scope (a canvas can hold only one context
  // type, so WebGL gets its own; the 2D canvas keeps the local view).
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Whether the GPU renderer initialized. Read imperatively by `rebuild` to
  // decide the global fallback; mirrored to state (`webglError`) for the UI.
  const webglOkRef = useRef(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  // On-screen WebGL diagnostic (updated imperatively, sampled to state below).
  // Shown only in dev builds or with the explicit flag (see graphDebug.ts).
  const [showDiag] = useState(() => graphDebugEnabled());
  const diagRef = useRef("");
  const [diag, setDiag] = useState("");
  // Hover tooltip for the WebGL global view: the hovered note's name + position
  // (canvas-local px). Set only when the hovered node changes.
  // Hover: the hovered note's name plus one tag per linked note, at each
  // node's screen position (canvas-local px). Set only when the hovered node changes.
  const [hoverTips, setHoverTips] = useState<
    { id: string; title: string; x: number; y: number; main: boolean }[]
  >([]);
  // Bounded self-heal: the graph can mount before the vault is fully open and
  // come back empty; retry a few times so it fills in instead of getting stuck.
  const emptyRetriesRef = useRef(0);
  // One-shot: fit the WebGL camera to the graph on (re)entry, then the user's
  // pan/zoom (shared `S.camera`) takes over.
  const webglNeedsFitRef = useRef(true);

  const { graph, loading, error, refresh } = useGraphData();
  // Only the Web Worker path (8k+ nodes) can set this. Inline layouts are
  // pre-settled synchronously before their first frame, so there is no window
  // in which they'd need to hide; the worker has one, and this covers it.
  const [settling, setSettling] = useState(false);

  // Settings live in BOTH a ref (read from inside the imperative canvas/sim
  // code, which can't see React state closures) and React state (drives the
  // controls panel). applyPatch keeps them in lockstep.
  const settingsRef = useRef<GraphSettings>(loadSettings());
  const [settings, setSettings] = useState<GraphSettings>(settingsRef.current);

  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const [showControls, setShowControls] = useState(false);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0, total: 0 });
  const [refreshSpin, setRefreshSpin] = useState(false);

  const openNotePath = useStore((s) => s.openNote?.path ?? null);
  const openNotePathRef = useRef(openNotePath);
  openNotePathRef.current = openNotePath;

  // One d3 simulation for the component's whole life (survives re-renders and
  // StrictMode remounts because refs persist). It is deliberately never allowed
  // to go cold: the alpha target floors at IDLE_ALPHA so the restoring forces
  // stay awake under the perpetual drift (see simulation.ts).
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  if (!simRef.current) {
    simRef.current = createSimulation(settingsRef.current).alphaTarget(IDLE_ALPHA);
  }

  const graphRef = useRef<Graph | null>(null);
  const vaultPath = useStore((st) => st.vault?.path ?? null);
  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  // Closing keeps this layout, so the next open is the same shape at once.
  useEffect(
    () => () => {
      const g = graphRef.current;
      const nodes = S.visNodes;
      if (!vaultPathRef.current || !g || S.bloom || S.assemble || settingsRef.current.scope !== "global") return;
      saveLayout(vaultPathRef.current, g, settingsRef.current, nodes);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Mutable, non-reactive state driving the canvas.
  const S = useRef({
    nodesById: new Map<string, SimNode>(),
    visNodes: [] as SimNode[],
    // Same array objects we hand to forceLink().links(): d3 rewrites their
    // source/target from id strings to SimNode refs IN PLACE, so after the call
    // we can read them as resolved links for drawing.
    visEdges: [] as SimLink[],
    // visNodes sorted small→large radius, so bigger ("nearer") orbs paint over
    // smaller ones and depth reads correctly. Order only changes on rebuild.
    drawOrder: [] as SimNode[],
    // One-shot: has the 2D canvas been wiped since the GPU renderer took over?
    cleared2d: false,
    colorById: new Map<string, string>(),
    hubLabels: [] as { node: SimNode; el: HTMLDivElement; w: number; h: number }[],
    camera: { x: 0, y: 0, k: 1 } as Camera,
    hoveredId: null as string | null,
    drag: null as Drag | null,
    rafId: null as number | null,
    needsDraw: true,
    restFrames: 0,
    bloom: null as BloomJob | null,
    // Opening from a background layout: notes grow from near the middle to
    // their finished spots (positions are final; only the view animates in).
    assemble: null as { t0: number; nodes: SimNode[]; to: Float32Array } | null,
    cameraFitted: false,
    // Bumped whenever note positions change (a sim tick, a worker frame, the
    // assemble step). Per-frame caches compare against it, so a spinning globe
    // or a resting template reuses work instead of redoing it every frame.
    layoutRev: 0,
    lastSpinDraw: 0,
    // The camera re-frames until this time after a shape switch, even at rest.
    fitUntil: 0,
    // The shape drawn last frame; a change starts a morph from where notes were.
    view: "flat" as GraphShape,
    morph: null as { t0: number; from: Float32Array; nodes: SimNode[] } | null,
    // Radial / Ring positions for the current visible set (they never move).
    template: null as
      | { shape: TemplateShape; nodes: SimNode[]; pos: Float32Array; group: Int32Array; r: number; index: Map<SimNode, number> }
      | null,
    // Radial / Ring: notes the user dragged off their spot, as world offsets.
    templateOffsets: new Map<SimNode, { dx: number; dy: number }>(),
    // Released notes springing back to their Radial / Ring spot.
    templateSprings: new Map<SimNode, { dx: number; dy: number; t0: number }>(),
    seededEdges: 0,
    idleTimer: 0,
    // Large global graphs offload the force sim to a Web Worker so the UI thread
    // never blocks. `useWorker` is set per-rebuild; `workerActive` mirrors the
    // worker's "still settling" state (drives redraws); `workerGen` drops stale
    // position buffers after a rebuild; `indexById` maps a node id to its slot
    // in the position buffer for drag fix/release.
    useWorker: false,
    workerActive: false,
    workerGen: 0,
    indexById: new Map<string, number>(),
    // Startup "come to life" burst: timestamp when the graph first got data, and
    // a one-time flag so the energizing velocity kick is applied only once.
    introStart: 0,
    introKicked: false,
    colors: {
      edge: "rgba(120,120,140,0.25)",
      edgeHighlight: FALLBACK_ACCENT,
      nodeFallback: "#9a9aa5",
      accent: FALLBACK_ACCENT,
      label: "rgba(205, 210, 224, 0.6)",
      labelActive: "#f2f4fb",
    } as Colors,
    fontFamily: DEFAULT_FONT_FAMILY,
    // Globe view: rotation, an eased turn toward a note, the smoothed frame the
    // flat layout is unfolded in, and when the person last touched it.
    globe: {
      rot: { yaw: 0.35, pitch: -0.22 } as GlobeRotation,
      target: null as GlobeRotation | null,
      frame: null as GlobeFrame | null,
      lastTouch: 0,
      lastT: 0,
      on: false,
    },
  }).current;

  // Set by the canvas effect once it defines the real draw scheduler. Starts as
  // a no-op so callers (rebuild, applyPatch) are safe before that effect runs.
  const requestDrawRef = useRef<() => void>(() => {});
  // Recomputes per-node colors from the current visible set + accent, and pushes
  // the legend to React state. Also set by the canvas effect (needs S.accent).
  const recolorRef = useRef<() => void>(() => {});

  // Force-layout Web Worker for large global graphs. Created once, lives for the
  // component's whole life (like simRef). Its streamed positions are written
  // straight into the current render nodes, so the renderer/edges/hover code all
  // keep reading the same objects — the only difference is the sim math happens
  // off-thread. Created lazily and defensively: if Worker isn't available the
  // ref stays null and rebuild() caps the global sim so the main thread is safe.
  const workerRef = useRef<SimClient | null>(null);
  if (workerRef.current === null && typeof Worker !== "undefined") {
    try {
      workerRef.current = new SimClient(
        (buf, alpha, gen) => {
          if (gen !== S.workerGen) return; // stale layout, ignore
          const vn = S.visNodes;
          if (buf.length !== vn.length * 2) return; // set changed under us
          for (let i = 0; i < vn.length; i++) {
            S.layoutRev++;
            vn[i].x = buf[i * 2];
            vn[i].y = buf[i * 2 + 1];
          }
          S.workerActive = alpha > 0.005;
          S.needsDraw = true;
          requestDrawRef.current();
        },
        (gen) => {
          if (gen !== S.workerGen) return;
          S.workerActive = false;
          S.needsDraw = true;
          // Settled: restart the entrance clock so the fade begins now rather
          // than having elapsed invisibly while the worker was still working.
          S.introStart = performance.now();
          setSettling(false);
          requestDrawRef.current();
        },
      );
    } catch {
      workerRef.current = null;
    }
  }
  // Tear the worker down for good on final unmount.
  useEffect(() => () => workerRef.current?.dispose(), []);

  // Recompute visible nodes/edges from the latest graph + filter settings, feed
  // them to the simulation, refresh colors, and reheat. Called on data change
  // and whenever a filter setting changes.
  const rebuild = useCallback(() => {
    const sim = simRef.current;
    const g = graphRef.current;
    if (!sim || !g) return;
    const s = settingsRef.current;

    const { nodes: all, reseeded } = buildSimNodes(g, S.nodesById, S.seededEdges);
    if (reseeded) S.seededEdges = g.edges.length;
    S.nodesById = new Map(all.map((n) => [n.id, n]));

    // Local scope: draw only the open note's neighborhood (a handful of nodes,
    // so it stays smooth on any vault and re-centers as you move between notes).
    // Falls back to the global overview when nothing is open.
    const openNode =
      s.scope === "local"
        ? all.find((n) => n.path === openNotePathRef.current)
        : undefined;

    let visNodes: SimNode[];
    if (openNode) {
      const keep = neighborhoodIds(g, openNode.id, Math.max(1, s.localDepth));
      visNodes = all.filter((n) => keep.has(n.id));
    } else {
      // Global overview: HIDE by degree/orphans (search DIMS at draw-time). With
      // the GPU renderer we draw the whole set; without it (WebGL unavailable) we
      // fall back to the 2D canvas and cap to the most-connected nodes so it
      // stays smooth. The header reports the full total, so the cap is visible.
      visNodes = all.filter(
        (n) => !(s.hideOrphans && n.linkCount === 0) && n.linkCount >= s.minDegree,
      );
      if (!webglOkRef.current && visNodes.length > GLOBAL_2D_CAP) {
        visNodes = [...visNodes]
          .sort((a, b) => b.linkCount - a.linkCount)
          .slice(0, GLOBAL_2D_CAP);
      } else if (
        workerRef.current === null &&
        visNodes.length > WORKER_THRESHOLD
      ) {
        // No Web Worker available to offload the layout — cap the live sim so a
        // huge vault can't lock up the main thread. (When the worker exists, the
        // full set goes to it below instead of being capped.)
        visNodes = [...visNodes]
          .sort((a, b) => b.linkCount - a.linkCount)
          .slice(0, WORKER_THRESHOLD);
      }
    }
    const visible = new Set(visNodes.map((n) => n.id));
    const links: SimLink[] = g.edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    // d3 init order: nodes() BEFORE link.links() so the link force resolves
    // {source,target} ids against the current node array.
    sim.nodes(visNodes);
    (sim.force("link") as ForceLink<SimNode, SimLink>).links(links);
    // Re-apply forces now that the node count is known — repulsion scales with
    // it, so a 5k global graph spreads while a small local one stays compact.
    configureForces(sim, s);

    // Only the first build gets a full reheat. After that, warm the layout just
    // enough to absorb the change (and never *cool* one that's already hotter).
    const first = !S.introKicked;
    sim.alpha(first ? REHEAT_FIRST : Math.max(sim.alpha(), REHEAT_REFRESH));

    // When real data lands (or most of it arrives late and was reseeded), the
    // seed already holds the cluster skeleton: a short warm-up takes out the
    // first jolt, then the loop blooms it live, one tick per frame. Not for the
    // worker path (8k+ notes), which settles off-thread instead (see
    // `worker.init(..., first)` below).
    if ((first || reseeded) && visNodes.length > 0) {
      const willUseWorker =
        !openNode && workerRef.current !== null && visNodes.length > WORKER_THRESHOLD;
      const ready =
        !willUseWorker && !openNode && vaultPathRef.current
          ? takeLayout(vaultPathRef.current, g, s)
          : null;
      const covered = ready ? visNodes.filter((n) => ready.has(n.id)).length : 0;
      if (ready && covered >= visNodes.length * 0.95) {
        // The background layout is finished: open straight into it.
        const to = new Float32Array(visNodes.length * 2);
        visNodes.forEach((n, i) => {
          const p = ready.get(n.id);
          if (p) { n.x = p.x; n.y = p.y; }
          n.vx = n.vy = 0;
          to[i * 2] = n.x;
          to[i * 2 + 1] = n.y;
        });
        sim.alpha(IDLE_ALPHA);
        S.bloom = null;
        S.assemble = { t0: performance.now(), nodes: visNodes, to };
      } else if (!willUseWorker) {
        S.bloom = beginBloom(sim, S.bloom);
      }
      S.introKicked = true;
      S.introStart = performance.now();
    }

    S.visNodes = visNodes;
    S.visEdges = links; // now resolved in place by forceLink
    S.drawOrder = [...visNodes].sort((a, b) => a.radius - b.radius);

    // Size the flow to the layout we just built (its own radius sets both the
    // drift speed and the wavelength) so the motion looks the same whether this
    // vault is 40 notes or 5000. Measured after the pre-settle, when positions
    // mean something.
    (sim.force("flow") as FlowForce).scale(layoutScale(visNodes));

    // Large global graphs: run the force layout in a Web Worker so the UI thread
    // never blocks. The worker owns its own copy and streams positions back into
    // these same node objects (loop() skips the main-thread tick while active).
    const worker = workerRef.current;
    const useWorker =
      !openNode && worker !== null && visNodes.length > WORKER_THRESHOLD;
    S.useWorker = useWorker;
    if (useWorker && worker) {
      S.indexById = new Map(visNodes.map((n, i) => [n.id, i]));
      const nodeSpec = visNodes.map((n) => ({
        id: n.id,
        radius: n.radius,
        weight: n.weight,
      }));
      const linkSpec = links
        .map((l) => {
          const sid = typeof l.source === "string" ? l.source : l.source.id;
          const tid = typeof l.target === "string" ? l.target : l.target.id;
          return { source: S.indexById.get(sid)!, target: S.indexById.get(tid)! };
        })
        .filter((l) => l.source !== undefined && l.target !== undefined);
      S.workerGen = worker.init(nodeSpec, linkSpec, s, 1200, 800, first);
      S.workerActive = true;
      // A pre-settle is impossible here — blocking the thread for an 8k+ node
      // layout is exactly the freeze the worker exists to avoid. So the reveal
      // waits instead: hold the graph hidden through the FIRST settle and fade
      // it in cool, rather than showing a huge field rearranging itself. Only
      // the first build; later refreshes are small warm nudges (REHEAT_REFRESH)
      // that must not blank a graph the user is already looking at.
      if (first) setSettling(true);
    } else if (worker) {
      // Switched to local or a small enough set: park the worker.
      worker.stop();
      S.workerActive = false;
    }

    const accent = S.colors.accent || FALLBACK_ACCENT;
    const { colorById, legend: lg } = assignColors(visNodes, s.colorMode, accent);
    S.colorById = colorById;
    S.hubLabels = syncHubLabels(hubLayerRef.current, visNodes, colorById);
    setLegend(lg);
    setCounts({ nodes: visNodes.length, edges: links.length, total: g.nodes.length });

    requestDrawRef.current();
  }, [S]);

  // Merge a settings patch: persist, update both mirrors, and apply live with
  // the cheapest reaction the change requires.
  const applyPatch = useCallback(
    (patch: Partial<GraphSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      saveSettings(next);
      setSettings(next);

      const sim = simRef.current;
      if (!sim) return;

      const keys = Object.keys(patch) as (keyof GraphSettings)[];
      const touchesFilter = keys.some(
        (k) =>
          k === "minDegree" ||
          k === "hideOrphans" ||
          k === "scope" ||
          k === "localDepth",
      );
      const touchesForces = keys.some(
        (k) =>
          k === "charge" ||
          k === "linkDistance" ||
          k === "linkStrength" ||
          k === "gravity",
      );

      if (touchesFilter) {
        // Fewer/more nodes: rebuild the sim data and let it re-settle.
        rebuild();
        return;
      }
      if (touchesForces) {
        // Physics changed: re-apply params without disturbing positions, then
        // gently reheat so the layout eases into its new equilibrium.
        if (S.useWorker) {
          // The off-thread sim owns the layout here — hand it the new params.
          workerRef.current?.setSettings(next);
          S.workerActive = true;
        } else {
          configureForces(sim, next);
          sim.alpha(Math.max(sim.alpha(), REARRANGE_ALPHA));
        }
        requestDrawRef.current();
        return;
      }
      // Visual-only (nodeSize / edgeThickness / labelScale / colorMode / search):
      // no reheat — just recolor if needed and repaint one frame.
      if (keys.includes("colorMode")) recolorRef.current();
      if (keys.includes("shape")) {
        S.globe.frame = null;
        S.fitUntil = performance.now() + MORPH_MS + 150;
        S.cameraFitted = true;
      }
      requestDrawRef.current();
    },
    [rebuild],
  );

  const onReset = useCallback(() => {
    const next = { ...DEFAULT_SETTINGS };
    settingsRef.current = next;
    saveSettings(next);
    setSettings(next);
    const sim = simRef.current;
    if (sim) {
      configureForces(sim, next);
      rebuild(); // recolors + reheats with the reset filter/appearance
    }
  }, [rebuild]);

  // Feed freshly-built graph data into the running simulation.
  useEffect(() => {
    graphRef.current = graph;
    if (graph) {
      webglNeedsFitRef.current = true; // re-fit the WebGL camera to new data
      rebuild();
    }
  }, [graph, rebuild]);

  // Re-fit the WebGL camera each time Global scope is (re)entered.
  useEffect(() => {
    if (settings.scope === "global") webglNeedsFitRef.current = true;
  }, [settings.scope]);

  // Re-center the local graph when the open note changes (no-op in global scope,
  // where the view doesn't depend on which note is open).
  useEffect(() => {
    if (settingsRef.current.scope === "local" && graphRef.current) rebuild();
  }, [openNotePath, rebuild]);

  // Sample the imperative WebGL diagnostic into state a couple times a second
  // (diagnostic HUD only; avoids a per-frame setState). Dev builds or the
  // explicit debug flag only: a release build never shows the HUD.
  useEffect(() => {
    if (!WEBGL_ENABLED || !showDiag) return;
    const id = setInterval(() => setDiag(diagRef.current), 500);
    return () => clearInterval(id);
  }, [showDiag]);

  // Self-heal an empty graph: if the data came back with no nodes (the view can
  // mount before the vault's index is ready), retry a few times. A genuinely
  // empty vault just settles after the retries and shows the empty state.
  useEffect(() => {
    if (loading) return;
    if (graph && graph.nodes.length > 0) {
      emptyRetriesRef.current = 0;
      return;
    }
    if (graph && graph.nodes.length === 0 && emptyRetriesRef.current < 3) {
      emptyRetriesRef.current += 1;
      const id = setTimeout(refresh, 400);
      return () => clearTimeout(id);
    }
  }, [graph, loading, refresh]);

  // ---- Canvas setup: runs once; everything else flows through refs. ----
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current!;

    // GPU renderer for the global scope (best-effort; if WebGL2 is unavailable
    // we simply never switch to it). Its own canvas — a canvas can hold only one
    // context type.
    let webgl: WebGLGraphRenderer | null = null;
    const webglCanvas = webglCanvasRef.current;
    if (webglCanvas && WEBGL_ENABLED) {
      try {
        webgl = new WebGLGraphRenderer(webglCanvas);
      } catch (e) {
        webgl = null;
        setWebglError(e instanceof Error ? e.message : String(e));
        console.error("[graph] WebGL init failed:", e);
      }
    }
    webglOkRef.current = webgl !== null;

    // A tiny color-parse cache so the per-frame draw stays allocation-free.
    // (Redesign: the baked gloss sprites are no longer drawn.)
    const shadowSprite = makeRadialSprite(
      SPRITE_SIZE,
      [4, 5, 11],
      [
        [0, 0.55],
        [0.42, 0.24],
        [1, 0],
      ],
    );
    const glowSprite = makeRadialSprite(
      SPRITE_SIZE,
      [150, 170, 228],
      [
        [0, 0.5],
        [0.5, 0.12],
        [1, 0],
      ],
    );
    const rgbCache = new Map<string, [number, number, number]>();
    const getRgb = (c: string): [number, number, number] => {
      let v = rgbCache.get(c);
      if (!v) {
        v = parseColor(c);
        rgbCache.set(c, v);
      }
      return v;
    };

    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;

    S.colors = readColors(wrap);
    S.fontFamily =
      getComputedStyle(wrap).getPropertyValue("--font-body").trim() ||
      DEFAULT_FONT_FAMILY;

    function resize() {
      const rect = wrap!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      if (webgl) webgl.resize(width, height, dpr);
      requestDraw();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // Recompute per-node colors + legend. Registered so applyPatch/theme changes
    // can trigger it (degree/uniform palettes depend on the live accent color).
    function recolor() {
      const s = settingsRef.current;
      const accent = S.colors.accent || FALLBACK_ACCENT;
      const { colorById, legend: lg } = assignColors(
        S.visNodes,
        s.colorMode,
        accent,
      );
      S.colorById = colorById;
      S.hubLabels = syncHubLabels(hubLayerRef.current, S.visNodes, colorById);
      setLegend(lg);
    }
    recolorRef.current = recolor;

    // Re-read colors when the light/dark toggle flips data-theme, then recolor
    // (accent-derived palettes must follow the theme).
    const themeObserver = new MutationObserver(() => {
      S.colors = readColors(wrap!);
      recolor();
      requestDraw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    function screenToWorld(sx: number, sy: number) {
      return {
        x: (sx - width / 2 - S.camera.x) / S.camera.k,
        y: (sy - height / 2 - S.camera.y) / S.camera.k,
      };
    }

    function nodeAt(sx: number, sy: number): SimNode | null {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const nodeScale = settingsRef.current.nodeSize;
      let best: SimNode | null = null;
      let bestDist = Infinity;
      const onGlobe = S.globe.on;
      for (const node of S.visNodes) {
        const p = node as Placed;
        // The far side of the globe is out of reach: spin to it instead.
        if (onGlobe && (p.gz ?? 1) < 0) continue;
        const dx = (p.gx ?? node.x) - wx;
        const dy = (p.gy ?? node.y) - wy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const hitRadius = drawRadius(node) * nodeScale + 4 / S.camera.k;
        if (d <= hitRadius && d < bestDist) {
          best = node;
          bestDist = d;
        }
      }
      return best;
    }

    // ---- Globe ----
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /** The shape to draw: the chosen one, or Flat where it cannot apply. */
    function viewWanted(): GraphShape {
      const s = settingsRef.current;
      if (s.scope !== "global" || webgl == null) return "flat";
      if (s.shape === "globe" && S.visNodes.length < GLOBE_MIN_NODES) return "flat";
      return s.shape ?? "globe";
    }

    function morphing(): boolean {
      return S.morph != null && performance.now() - S.morph.t0 < MORPH_MS;
    }

    /** Radial / Ring: fixed spots from folder and link count, computed once per set. */
    function placeTemplate(shape: TemplateShape) {
      const nodes = S.visNodes;
      let t = S.template;
      if (!t || t.shape !== shape || t.nodes !== nodes) {
        const L = templateLayout(nodes, shape);
        t = { shape, nodes, ...L, index: new Map(nodes.map((n, i) => [n, i])) };
        S.template = t;
        S.templateOffsets.clear();
        S.templateSprings.clear();
      }
      const now = performance.now();
      for (const [n, sp] of S.templateSprings) {
        // A damped spring: overshoots a touch, then settles, like the flat graph.
        const t = (now - sp.t0) / 1000;
        if (t >= TEMPLATE_SPRING_S) {
          S.templateSprings.delete(n);
          S.templateOffsets.delete(n);
          continue;
        }
        const k = Math.exp(-6 * t) * Math.cos(11 * t);
        S.templateOffsets.set(n, { dx: sp.dx * k, dy: sp.dy * k });
      }
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i] as Placed;
        const off = S.templateOffsets.get(nodes[i]);
        p.gx = t.pos[i * 2] + (off?.dx ?? 0);
        p.gy = t.pos[i * 2 + 1] + (off?.dy ?? 0);
        p.gz = 1;
      }
    }

    function placeFlat() {
      for (const n of S.visNodes) {
        const p = n as Placed;
        p.gx = n.x;
        p.gy = n.y;
        p.gz = 1;
      }
    }

    /** Capture where every note is drawn now, as the start of a morph. */
    function startMorph() {
      const nodes = S.visNodes;
      const from = new Float32Array(nodes.length * 2);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i] as Placed;
        from[i * 2] = p.gx ?? p.x;
        from[i * 2 + 1] = p.gy ?? p.y;
      }
      S.morph = { t0: performance.now(), from, nodes };
    }

    /** Blend this frame's spots with where the morph started. */
    function applyMorph() {
      const m = S.morph;
      if (!m) return;
      if (m.nodes !== S.visNodes || !morphing()) {
        S.morph = null;
        return;
      }
      const t = (performance.now() - m.t0) / MORPH_MS;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const nodes = S.visNodes;
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i] as Placed;
        p.gx = m.from[i * 2] + (p.gx! - m.from[i * 2]) * e;
        p.gy = m.from[i * 2 + 1] + (p.gy! - m.from[i * 2 + 1]) * e;
      }
    }

    /** Where a note is drawn this frame: on the globe, or its flat spot. */
    function viewPos(n: SimNode): { x: number; y: number; z: number } {
      const p = n as Placed;
      if (p.gx !== undefined) return { x: p.gx, y: p.gy!, z: p.gz ?? 1 };
      return { x: n.x, y: n.y, z: 1 };
    }

    /** True while the globe still has motion to show: a turn or the idle spin. */
    function globeMoving(): boolean {
      if (!S.globe.on) return false;
      if (S.globe.target) return true;
      // Hovering a note holds it still, so its tags stay on the notes they name.
      return (
        !reducedMotion &&
        !S.drag &&
        S.hoveredId == null &&
        performance.now() - S.globe.lastTouch > GLOBE_SPIN_REST_MS
      );
    }

    let frameXs = new Float32Array(0);
    let frameYs = new Float32Array(0);
    const unit: SpherePoint = { x: 0, y: 0, z: 0 };
    /** Advance the rotation and place every note on the sphere for this frame. */
    function placeOnGlobe() {
      const g = S.globe;
      const nodes = S.visNodes;
      const now = performance.now();
      const dt = g.lastT ? Math.min(0.1, (now - g.lastT) / 1000) : 0;
      g.lastT = now;
      if (g.target) {
        g.rot.yaw += (g.target.yaw - g.rot.yaw) * 0.14;
        g.rot.pitch += (g.target.pitch - g.rot.pitch) * 0.14;
        if (Math.abs(g.target.yaw - g.rot.yaw) + Math.abs(g.target.pitch - g.rot.pitch) < 0.002) {
          g.target = null;
        }
      } else if (globeMoving()) {
        g.rot.yaw += GLOBE_SPIN * dt;
      }
      // Unfolding onto the sphere is the costly part (several trig calls per
      // note) and depends only on positions and the frame, so it is cached and
      // a plain spin only re-rotates.
      const cache = sphereCache;
      const fresh =
        cache.nodes === nodes && cache.rev === S.layoutRev && g.frame != null && cache.frame === g.frame;
      if (!fresh) unfoldOntoSphere(nodes);
      const fr = g.frame!;
      const R = fr.r * GLOBE_SCALE;
      const cyw = Math.cos(g.rot.yaw);
      const syw = Math.sin(g.rot.yaw);
      const cp = Math.cos(g.rot.pitch);
      const sp = Math.sin(g.rot.pitch);
      const ux = cache.x;
      const uy = cache.y;
      const uz = cache.z;
      for (let i = 0; i < nodes.length; i++) {
        const x = ux[i] * cyw + uz[i] * syw;
        const z1 = -ux[i] * syw + uz[i] * cyw;
        const p = nodes[i] as Placed;
        p.gx = fr.cx + x * R;
        p.gy = fr.cy + (uy[i] * cp - z1 * sp) * R;
        p.gz = uy[i] * sp + z1 * cp;
      }
    }

    const sphereCache = {
      nodes: null as SimNode[] | null,
      rev: -1,
      frame: null as GlobeFrame | null,
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
    };
    /** Recompute the frame (smoothed) and every note's unrotated sphere point. */
    function unfoldOntoSphere(nodes: SimNode[]) {
      const g = S.globe;
      // The frame is the finished shape while it assembles, so the notes gather
      // from the front of the globe out over its whole surface. At rest it is
      // smoothed, so the gentle drift cannot make the globe breathe.
      let f: GlobeFrame;
      if (S.assemble) {
        const to = S.assemble.to;
        const xs = new Float32Array(to.length / 2);
        const ys = new Float32Array(to.length / 2);
        for (let i = 0; i < xs.length; i++) {
          xs[i] = to[i * 2];
          ys[i] = to[i * 2 + 1];
        }
        f = frameOf(xs, ys, xs.length);
      } else {
        if (frameXs.length < nodes.length) {
          frameXs = new Float32Array(nodes.length);
          frameYs = new Float32Array(nodes.length);
        }
        for (let i = 0; i < nodes.length; i++) {
          frameXs[i] = nodes[i].x;
          frameYs[i] = nodes[i].y;
        }
        f = frameOf(frameXs, frameYs, nodes.length);
      }
      if (!g.frame || S.assemble) g.frame = f;
      else {
        // Ease toward the new frame, and land on it once close: an endless
        // asymptote would count as a change every frame and defeat the cache.
        const fr = g.frame;
        const d = Math.abs(f.cx - fr.cx) + Math.abs(f.cy - fr.cy) + Math.abs(f.r - fr.r);
        if (d < 0.5) g.frame = f;
        else g.frame = { cx: fr.cx + (f.cx - fr.cx) * 0.05, cy: fr.cy + (f.cy - fr.cy) * 0.05, r: fr.r + (f.r - fr.r) * 0.05 };
      }
      const fr = g.frame;
      const c = sphereCache;
      if (c.x.length !== nodes.length) {
        c.x = new Float32Array(nodes.length);
        c.y = new Float32Array(nodes.length);
        c.z = new Float32Array(nodes.length);
      }
      for (let i = 0; i < nodes.length; i++) {
        toSphere(nodes[i].x, nodes[i].y, fr, unit);
        c.x[i] = unit.x;
        c.y[i] = unit.y;
        c.z[i] = unit.z;
      }
      c.nodes = nodes;
      c.rev = S.layoutRev;
      c.frame = fr;
    }

    /** Turn the globe so this note faces the viewer. */
    function turnToFace(n: SimNode) {
      const fr = S.globe.frame;
      if (!fr) return;
      const target = faceRotation(toSphere(n.x, n.y, fr, { x: 0, y: 0, z: 0 }));
      target.yaw = yawToward(S.globe.rot.yaw, target.yaw);
      S.globe.target = target;
      S.globe.lastTouch = performance.now();
      requestDraw();
    }

    // ---- Drawing ----
    function draw() {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, height); // transparent → CSS backdrop shows through
      ctx!.save();
      ctx!.translate(width / 2 + S.camera.x, height / 2 + S.camera.y);
      ctx!.scale(S.camera.k, S.camera.k);

      const s = settingsRef.current;
      const colors = S.colors;
      const k = S.camera.k;

      const hovered = S.hoveredId
        ? S.nodesById.get(S.hoveredId) ?? null
        : null;
      const neighbors = new Set<string>();
      if (hovered) {
        neighbors.add(hovered.id);
        for (const e of S.visEdges) {
          const src = e.source as SimNode;
          const tgt = e.target as SimNode;
          if (src.id === hovered.id) neighbors.add(tgt.id);
          if (tgt.id === hovered.id) neighbors.add(src.id);
        }
      }

      const search = s.search.trim().toLowerCase();
      const matches = (n: SimNode) =>
        search === "" || n.title.toLowerCase().includes(search);

      // Label fade threshold scales inversely with labelScale — a higher
      // "Labels" setting reveals labels at lower zoom; 0 hides all but hover/open.
      const ls = s.labelScale;
      const start = LABEL_FADE_START / Math.max(ls, 0.0001);
      const end = LABEL_FADE_END / Math.max(ls, 0.0001);
      const zoomLabelAlpha =
        ls <= 0 ? 0 : clamp((k - start) / (end - start), 0, 1);

      // The light half of the heartbeat. The nodes brighten on the same two beats
      // the CSS scales on, so the brain looks like it pulses rather than like it
      // was merely animated in. The layout underneath does not move at all.
      const nowT = performance.now();
      const introT =
        S.introStart > 0 ? clamp((nowT - S.introStart) / INTRO_MS, 0, 1) : 1;
      const introEase = 1 - Math.pow(1 - introT, 3); // easeOutCubic
      const glowBoost = 1 + heartbeatEnvelope(introT) * 0.8;

      const nodeScale = s.nodeSize;
      const time = nowT / 1000;
      const drawNodes = S.drawOrder;
      const stamp = (
        sprite: CanvasImageSource,
        wx: number,
        wy: number,
        dd: number,
      ) => ctx!.drawImage(sprite, wx - dd / 2, wy - dd / 2, dd, dd);

      // ---- Edges: quiet connective threads (source-over, batched) ----
      ctx!.globalCompositeOperation = "source-over";
      const edgeWidth = s.edgeThickness / k;
      {
        const L = graphTheme().line!;
        ctx!.strokeStyle = `rgb(${Math.round(L[0] * 255)},${Math.round(L[1] * 255)},${Math.round(L[2] * 255)})`;
      }
      // Matched to the GPU path's edge alpha so the WebGL-unavailable fallback
      // doesn't look like a different, dimmer product.
      ctx!.globalAlpha =
        (hovered ? 0.3 : 1) * graphTheme().line![3] * edgeDensityScale(S.visEdges.length) * (0.5 + 0.5 * introEase);
      ctx!.lineWidth = edgeWidth;
      ctx!.beginPath();
      for (const e of S.visEdges) {
        const src = e.source as SimNode;
        const tgt = e.target as SimNode;
        if (hovered && (src.id === hovered.id || tgt.id === hovered.id)) continue;
        ctx!.moveTo(src.x, src.y);
        ctx!.lineTo(tgt.x, tgt.y);
      }
      ctx!.stroke();
      if (hovered) {
        // The hovered node's own links light up with the accent, drawn on top.
        ctx!.strokeStyle = colors.edgeHighlight;
        ctx!.globalAlpha = 0.85;
        ctx!.lineWidth = edgeWidth * 1.8;
        ctx!.beginPath();
        for (const e of S.visEdges) {
          const src = e.source as SimNode;
          const tgt = e.target as SimNode;
          if (src.id !== hovered.id && tgt.id !== hovered.id) continue;
          ctx!.moveTo(src.x, src.y);
          ctx!.lineTo(tgt.x, tgt.y);
        }
        ctx!.stroke();
      }

      // ---- Contact shadows: seat each orb over the void for real depth ----
      ctx!.globalCompositeOperation = "source-over";
      for (const node of drawNodes) {
        if (!matches(node)) continue;
        const dimmed = hovered != null && !neighbors.has(node.id);
        const base = drawRadius(node) * nodeScale;
        ctx!.globalAlpha = dimmed ? 0.12 : 0.4;
        stamp(shadowSprite, node.x + base * 0.16, node.y + base * 0.5, base * 2.3);
      }

      // ---- Ambient glow: the soft light each orb sheds, gently breathing ----
      ctx!.globalCompositeOperation = "lighter";
      for (let i = 0; i < drawNodes.length; i++) {
        const node = drawNodes[i];
        if (!matches(node)) continue;
        if (hovered != null && !neighbors.has(node.id)) continue;
        const base = drawRadius(node) * nodeScale;
        const breathe = 0.82 + 0.18 * Math.sin(time * 0.8 + i * 0.7);
        ctx!.globalAlpha = clamp(0.15 * glowBoost * breathe, 0, 0.7);
        stamp(glowSprite, node.x, node.y, base * 3);
      }

      // ---- Node bodies: flat color + baked matte 3D shading ----
      ctx!.globalCompositeOperation = "source-over";
      for (const node of drawNodes) {
        const isOpen = node.path === openNotePathRef.current;
        const isHovered = hovered?.id === node.id;
        const dimByHover = hovered != null && !neighbors.has(node.id);
        const dimBySearch = !matches(node);
        const dimmed = dimByHover || dimBySearch;

        const base = drawRadius(node) * nodeScale;
        const r = isHovered ? base * 1.3 : base;
        const color = isOpen
          ? colors.accent
          : S.colorById.get(node.id) ?? colors.nodeFallback;

        // A colored bloom for the open note / hovered orb — a little extra life.

        // Flat base disc, then the baked shadow + light sprites stamp matte
        // volume onto it. globalAlpha carries into the sprites, so a dimmed orb
        // simply shades fainter — no separate dim path needed.
        ctx!.globalAlpha = dimmed ? 0.24 : 1;
        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fill();
        // Redesign: flat matte discs (the baked gloss sprites are skipped).

        // The open note gets an accent ring so it's findable at a glance.
        if (isOpen) {
          ctx!.lineWidth = 2 / k;
          ctx!.strokeStyle = colors.accent;
          ctx!.globalAlpha = dimmed ? 0.4 : 1;
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, r + 3 / k, 0, Math.PI * 2);
          ctx!.stroke();
        }

        // Labels: fade in with zoom, always shown on hover and for the open note.
        const isLinked = hovered != null && !isHovered && neighbors.has(node.id);
        const wantLabel = isHovered || isOpen || isLinked || zoomLabelAlpha > 0.01;
        if (wantLabel) {
          let alpha = isHovered || isOpen ? 1 : isLinked ? 0.9 : zoomLabelAlpha;
          if (dimBySearch && !isHovered) alpha *= 0.2;
          else if (dimByHover) alpha *= 0.25;
          if (alpha > 0.01) {
            ctx!.globalAlpha = alpha;
            ctx!.fillStyle = isOpen ? colors.labelActive : colors.label;
            ctx!.font = `${11 / k}px ${S.fontFamily}`;
            ctx!.textAlign = "center";
            ctx!.textBaseline = "top";
            ctx!.fillText(node.title, node.x, node.y + r + 3 / k);
          }
        }
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
      ctx!.restore();

      // The full-screen additive light flash that used to fire here is gone. It
      // was the visual cover for the layout rearranging itself underneath, and
      // with the layout now settled before the first frame there is nothing to
      // cover — it just read as a flashbulb. The entrance is the wrapper's fade
      // (`.graph-intro`) plus `glowBoost` above, and that is deliberately all.
    }

    // Global scope: draw every node on the GPU. The instance buffer is rebuilt
    // every frame (the layout is always drifting), so the RenderNode wrappers
    // are POOLED and mutated in place — allocating a few thousand objects plus
    // their color arrays 60 times a second would hand the GC a steady diet for
    // as long as the graph is open.
    // Screen positions for the hovered note and every note it links to, capped
    // so a hub with hundreds of links doesn't bury the canvas in text.
    const HOVER_TIP_CAP = 40;
    function hoverTipsFor(hit: SimNode) {
      const cam = S.camera;
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      const toScreen = (n: SimNode) => {
        const at = viewPos(n);
        return { x: w / 2 + cam.x + at.x * cam.k, y: h / 2 + cam.y + at.y * cam.k };
      };
      const tips = [{ id: hit.id, title: hit.title, main: true, ...toScreen(hit) }];
      const taken = [tipBox(tips[0].x, tips[0].y, hit.title, true)];
      const ids = graphRef.current ? neighborhoodIds(graphRef.current, hit.id, 1) : new Set<string>();
      // S.indexById is only filled for the worker path, so scan the visible nodes.
      // Busiest neighbours first, and a tag that would cover one already placed
      // is skipped: a hub with hundreds of links must not stack its names.
      const linked = S.visNodes
        .filter((n) => n.id !== hit.id && ids.has(n.id) && viewPos(n).z >= 0)
        .sort((a, b) => b.linkCount - a.linkCount);
      for (const n of linked) {
        if (tips.length > HOVER_TIP_CAP) break;
        const pos = toScreen(n);
        const box = tipBox(pos.x, pos.y, n.title, false);
        if (taken.some((t) => boxesOverlap(t, box))) continue;
        taken.push(box);
        tips.push({ id: n.id, title: n.title, main: false, ...pos });
      }
      return tips;
    }

    // The tags sit at screen positions, so a pan or zoom would leave them
    // behind; drop them and let the next pointer move hover afresh.
    function clearHoverTips() {
      if (S.hoveredId == null) return;
      S.hoveredId = null;
      canvas!.classList.remove("is-hovering-node");
      setHoverTips([]);
    }

    /**
     * The sphere itself, on the 2D canvas under the GPU one: a soft lit disc
     * with a hairline rim, so the notes read as lying on a globe rather than
     * as a round scatter.
     */
    let sphereKey = "";
    function drawSphere(fr: GlobeFrame, cam: Camera) {
      const c = ctx!;
      const R = fr.r * GLOBE_SCALE * cam.k;
      const cx = width / 2 + cam.x + fr.cx * cam.k;
      const cy = height / 2 + cam.y + fr.cy * cam.k;
      const bg = graphTheme().mid ?? [1, 1, 1];
      const dark = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 < 0.5;
      // The sphere does not change as the globe turns: repaint only when the
      // camera, the size, the canvas or the theme does.
      const key = `${cx.toFixed(1)}|${cy.toFixed(1)}|${R.toFixed(1)}|${width}x${height}@${dpr}|${dark}`;
      if (key === sphereKey) return;
      sphereKey = key;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      const g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 1.02);
      if (dark) {
        g.addColorStop(0, "rgba(255,255,255,0.07)");
        g.addColorStop(0.7, "rgba(255,255,255,0.025)");
        g.addColorStop(1, "rgba(255,255,255,0.01)");
      } else {
        g.addColorStop(0, "rgba(255,255,255,0.75)");
        g.addColorStop(0.7, "rgba(120,100,70,0.04)");
        g.addColorStop(1, "rgba(90,70,40,0.1)");
      }
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(40,34,28,0.08)";
      c.stroke();
    }

    const webglNodes: RenderNode[] = [];
    let depthOrder = new Uint32Array(0);
    /** Note indices from the far side of the globe to the near side. */
    // A counting sort into depth buckets: linear, allocation-free, and fine
    // enough that no two visibly overlapping notes paint in the wrong order.
    const DEPTH_BUCKETS = 512;
    const bucketCount = new Uint32Array(DEPTH_BUCKETS + 1);
    let bucketOf = new Uint16Array(0);
    function globeOrder(): Uint32Array {
      const nodes = S.visNodes as Placed[];
      const n = nodes.length;
      if (depthOrder.length !== n) {
        depthOrder = new Uint32Array(n);
        bucketOf = new Uint16Array(n);
      }
      bucketCount.fill(0);
      for (let i = 0; i < n; i++) {
        const b = Math.min(DEPTH_BUCKETS - 1, Math.max(0, ((nodes[i].gz! + 1) / 2) * DEPTH_BUCKETS) | 0);
        bucketOf[i] = b;
        bucketCount[b + 1]++;
      }
      for (let b = 0; b < DEPTH_BUCKETS; b++) bucketCount[b + 1] += bucketCount[b];
      for (let i = 0; i < n; i++) depthOrder[bucketCount[bucketOf[i]]++] = i;
      return depthOrder;
    }
    const hoverCache = {
      id: null as string | null,
      graph: null as Graph | null,
      set: null as Set<string> | null,
    };
    // What the uploaded links were built from; unchanged means skip the rebuild
    // and the upload (Radial and Ring never move, so they upload once).
    let edgeKey = "";
    let highlightKey = "";
    const curveScratch = new Float32Array(CURVE_SEGMENTS * 4);
    let edgePositions = new Float32Array(0);
    function drawWebGL() {
      if (!webgl || !webglCanvas) return;
      // Wipe the 2D canvas the first time the GPU renderer paints. Both canvases
      // are stacked in the same box and the 2D one is never cleared once WebGL
      // owns the frame, so whatever it last drew just sits there underneath — and
      // any gap in the GPU layer (the entrance pulse briefly scaling under 1, a
      // dpr change, a lost context) reveals a stale graph behind the live one.
      // A canvas resize clears itself, so once is genuinely enough.
      if (!S.cleared2d && ctx) {
        ctx.clearRect(0, 0, canvas!.width, canvas!.height);
        S.cleared2d = true;
        sphereKey = ""; // the sphere was wiped with it
      }
      const fallback = S.colors.nodeFallback;
      const nodeScale = settingsRef.current.nodeSize;
      // Shrink nodes as the graph grows so a bigger vault reads as "smaller
      // dots, more space" rather than a compacted pile. The layout also spreads
      // (repulsion scales with n), so together the graph expands and keeps
      // breathing room. The constant is generous — it used to kick in at a few
      // hundred notes and stack on top of the on-screen minimum, which between
      // them squashed every node in a mid-size vault to the same floor size and
      // erased the hub-vs-leaf hierarchy entirely.
      const countScale = Math.min(1, 60 / Math.sqrt(Math.max(1, S.visNodes.length)));
      // Hover: light up the hovered node + its direct neighbors, dim the rest,
      // so you can see a note's connections at a glance.
      const hoveredId = S.hoveredId;
      // A note's neighbours only change with the hover or the data, never per
      // frame, so the lookup is kept between frames.
      if (hoverCache.id !== hoveredId || hoverCache.graph !== graphRef.current) {
        hoverCache.id = hoveredId;
        hoverCache.graph = graphRef.current;
        hoverCache.set =
          hoveredId && graphRef.current ? neighborhoodIds(graphRef.current, hoveredId, 1) : null;
      }
      const hlSet = hoverCache.set;
      const bg = graphTheme().mid ?? [1, 1, 1];
      const view = viewWanted();
      if (view !== S.view) {
        // Only a change between two drawn frames glides; the first frame just lands.
        if (S.visNodes.length > 0 && (S.visNodes[0] as Placed).gx !== undefined) startMorph();
        S.view = view;
        S.globe.frame = null;
        // Leaving the globe: wipe its sphere off the 2D canvas underneath.
        S.cleared2d = false;
      }
      const onGlobe = view === "globe";
      S.globe.on = onGlobe;
      if (onGlobe) placeOnGlobe();
      else if (view === "radial" || view === "ring") placeTemplate(view);
      else placeFlat();
      applyMorph();
      // On the globe the far side paints first, so the near side covers it.
      const order = onGlobe ? globeOrder() : null;
      webglNodes.length = S.visNodes.length;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let j = 0; j < S.visNodes.length; j++) {
        const i = order ? order[j] : j;
        const n = S.visNodes[i] as Placed;
        const c = getRgb(S.colorById.get(n.id) ?? fallback);
        // Facing the viewer: 1 at the front of the globe, 0 at the back.
        const face = onGlobe ? facing(n.gz!) : 1;
        const depthFade = onGlobe ? 0.12 + 0.88 * face * face : 1;
        const dim = (hlSet && !hlSet.has(n.id) ? 0.16 : 1) * depthFade;
        const big =
          n.id === hoveredId ? 1.3 : hlSet && hlSet.has(n.id) ? 1.1 : 1;
        let rn = webglNodes[j];
        if (!rn) {
          rn = { x: 0, y: 0, r: 0, color: [0, 0, 0] };
          webglNodes[j] = rn;
        }
        const px = n.gx!;
        const py = n.gy!;
        rn.x = px;
        rn.y = py;
        // Hubs skip the crowd shrink so the heavy centres stay heavy-looking.
        const crowd = n.hub ? 1 : countScale;
        rn.r = drawRadius(n) * nodeScale * crowd * big * (onGlobe ? 0.5 + 0.65 * face : 1);
        // Dim toward the canvas, not toward black: on the cream light theme a
        // plain multiply turned every unrelated note into a black dot.
        rn.color[0] = (c[0] / 255) * dim + bg[0] * (1 - dim);
        rn.color[1] = (c[1] / 255) * dim + bg[1] * (1 - dim);
        rn.color[2] = (c[2] / 255) * dim + bg[2] * (1 - dim);
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      webgl.setNodes(webglNodes);
      // Edges: two world-space vertices per link (source → target), read from
      // the sim nodes forceLink resolved in place.
      const edges = S.visEdges;
      const curved = view === "radial" || view === "ring" ? (view as TemplateShape) : null;
      const per = curved ? CURVE_SEGMENTS * 4 : 4;
      if (edgePositions.length < edges.length * per) {
        edgePositions = new Float32Array(edges.length * per);
      }
      // On the globe only links on the visible side are drawn; the far side
      // shows as faded notes alone, which is what reads as a sphere.
      // Radial and Ring bend each link toward the middle (Ring bundles the
      // links between folders across it).
      const moving = morphing() || S.assemble != null;
      const nextEdgeKey = onGlobe
        ? `g${S.layoutRev}:${S.globe.rot.yaw}:${S.globe.rot.pitch}:${moving ? performance.now() : 0}`
        : `${view}${S.layoutRev}:${edges.length}:${moving ? performance.now() : 0}:${curved ? S.template?.pos.length : 0}`;
      const edgesChanged = nextEdgeKey !== edgeKey || S.needsDraw;
      edgeKey = nextEdgeKey;
      let w = 0;
      const tpl = curved ? S.template : null;
      for (let i = 0; edgesChanged && i < edges.length; i++) {
        const src = edges[i].source as Placed;
        const tgt = edges[i].target as Placed;
        if (onGlobe && src.gz! + tgt.gz! < 0.1) continue;
        if (curved && tpl) {
          const a = tpl.index.get(src);
          const b = tpl.index.get(tgt);
          const same = a !== undefined && b !== undefined && tpl.group[a] === tpl.group[b];
          w = writeCurve(src.gx!, src.gy!, tgt.gx!, tgt.gy!, curvePull(curved, same), edgePositions, w);
          continue;
        }
        edgePositions[w++] = src.gx!;
        edgePositions[w++] = src.gy!;
        edgePositions[w++] = tgt.gx!;
        edgePositions[w++] = tgt.gy!;
      }
      if (edgesChanged) webgl.setEdges(edgePositions.subarray(0, w));
      // Hover: bright rays from the hovered node to each of its neighbors, so
      // connections are traceable even in a huge cloud.
      const nextHighlightKey = `${hoveredId}|${edgeKey}`;
      if (nextHighlightKey === highlightKey && !edgesChanged) {
        // Same hover over the same positions: the uploaded rays still stand.
      } else if (hoveredId) {
        highlightKey = nextHighlightKey;
        const hl: number[] = [];
        for (let i = 0; i < edges.length; i++) {
          const s = edges[i].source as SimNode;
          const t = edges[i].target as SimNode;
          if (s.id === hoveredId || t.id === hoveredId) {
            const a = viewPos(s);
            const b = viewPos(t);
            if (a.z < 0 || b.z < 0) continue;
            if (curved) {
              writeCurve(a.x, a.y, b.x, b.y, curvePull(curved, false), curveScratch, 0);
              for (const v of curveScratch) hl.push(v);
            } else {
              hl.push(a.x, a.y, b.x, b.y);
            }
          }
        }
        webgl.setHighlightEdges(new Float32Array(hl));
      } else {
        highlightKey = nextHighlightKey;
        webgl.setHighlightEdges(new Float32Array(0));
      }
      // One-shot: fit the shared camera to the graph. After that the user's
      // pan/zoom (which mutates S.camera via the 2D handlers) drives the view.
      const refitting = performance.now() < S.fitUntil;
      if ((webglNeedsFitRef.current || refitting) && webglNodes.length > 0) {
        // Keep the graph framed as the layout expands during settle; the flag is
        // cleared the moment the user pans/zooms (in the interaction handlers).
        // While it assembles, frame the finished shape so it grows into view.
        if (onGlobe && S.globe.frame) {
          // Frame the whole sphere, not the notes: while it forms the notes
          // cover only its front, and fitting to them made the globe shrink.
          const fr = S.globe.frame;
          const R = fr.r * GLOBE_SCALE;
          minX = fr.cx - R;
          maxX = fr.cx + R;
          minY = fr.cy - R;
          maxY = fr.cy + R;
        } else if (curved && S.template) {
          // The finished shape, so the camera does not chase the glide.
          const R = S.template.r * 1.14;
          minX = minY = -R;
          maxX = maxY = R;
        } else if (S.assemble) {
          const to = S.assemble.to;
          minX = minY = Infinity;
          maxX = maxY = -Infinity;
          for (let i = 0; i < to.length; i += 2) {
            if (to[i] < minX) minX = to[i];
            if (to[i] > maxX) maxX = to[i];
            if (to[i + 1] < minY) minY = to[i + 1];
            if (to[i + 1] > maxY) maxY = to[i + 1];
          }
          S.cameraFitted = false;
        }
        const bw = Math.max(1, maxX - minX);
        const bh = Math.max(1, maxY - minY);
        // Ease toward the fit rather than snapping: as the clusters bloom the
        // box grows every frame, and a snap turns that into a jittery zoom.
        const k = Math.min((width - 80) / bw, (height - 80) / bh);
        const x = -((minX + maxX) / 2) * k;
        const y = -((minY + maxY) / 2) * k;
        const ease = !S.cameraFitted ? 1 : refitting ? 0.12 : CAMERA_EASE;
        S.camera.k += (k - S.camera.k) * ease;
        S.camera.x += (x - S.camera.x) * ease;
        S.camera.y += (y - S.camera.y) * ease;
        S.cameraFitted = true;
      }
      // Same transform as the 2D path: screen_css = width/2 + cam.x + world·cam.k,
      // then scaled by dpr into the device-pixel drawing buffer.
      const cam = S.camera;
      if (onGlobe && S.globe.frame && ctx) drawSphere(S.globe.frame, cam);
      // Hub tags, busiest first; one that would cover a tag already placed (or
      // a hover tag) is hidden this frame rather than drawn on top of it.
      const placed: Box[] = [];
      for (const label of S.hubLabels) {
        const { node, el } = label;
        const at = viewPos(node);
        const sx = width / 2 + cam.x + at.x * cam.k;
        const sy = height / 2 + cam.y + at.y * cam.k + drawRadius(node) * nodeScale * cam.k + 6;
        el.style.transform = `translate(${sx}px, ${sy}px) translateX(-50%)`;
        const box = {
          x0: sx - label.w / 2,
          x1: sx + label.w / 2,
          y0: sy,
          y1: sy + label.h,
        };
        const hidden =
          (hlSet != null && node.id !== hoveredId) ||
          // Round the side of the globe a tag would float over nothing.
          (onGlobe && at.z < 0.35) ||
          placed.some((b) => boxesOverlap(b, box));
        if (!hidden) placed.push(box);
        el.style.opacity = hidden ? "0" : "1";
      }
      webgl.setTheme(themeForEdges(S.visEdges.length));
      webgl.draw(
        cam.k * dpr,
        (width / 2 + cam.x) * dpr,
        (height / 2 + cam.y) * dpr,
        // Floor on a node's on-screen radius. The shader applies it in
        // quadrature, not as a hard clamp, so this lifts the leaves to a
        // legible dot without flattening the hubs down onto them.
        MIN_NODE_PX * dpr,
        performance.now() / 1000,
        // Halos are additive, so they SUM: a glow that looks right on 200 nodes
        // turns a 50k-node cluster into one white blob. Dial it back as the
        // field fills up. Tuned against rendered frames at 800 / 3.4k nodes —
        // the ceiling is where a sparse graph reads as luminous without the
        // halos merging, the floor is where a huge one still shows some light.
        //
        // The entrance rides on top: the whole field brightens on each beat and
        // the swell fades out with the extra motion, so the light and the
        // movement are one heartbeat rather than two effects.
        // Redesign: no halos. A calm, matte field reads cleaner and skips a pass.
        0,
        dpr,
      );
      if (showDiag) diagRef.current =
        `webgl ✓ · nodes ${webglNodes.length} · buf ${webglCanvas.width}×${webglCanvas.height} · ` +
        `k ${cam.k.toFixed(3)} · cam ${Math.round(cam.x)},${Math.round(cam.y)} · ` +
        `bounds ${Math.round(minX)},${Math.round(minY)}..${Math.round(maxX)},${Math.round(maxY)} · ` +
        `gl ${webgl.glError()}`;
    }

    // Single frame clock. The loop stays alive the whole time the graph is
    // mounted so the lighting keeps breathing and the scene feels alive at rest.
    // Ease each note from near the middle to its finished spot; true while running.
    function stepAssemble(): boolean {
      S.layoutRev++;
      const a = S.assemble!;
      const t = clamp((performance.now() - a.t0) / ASSEMBLE_MS, 0, 1);
      const e = 1 - Math.pow(1 - t, 4); // fast out, soft landing
      for (let i = 0; i < a.nodes.length; i++) {
        const n = a.nodes[i];
        const k = ASSEMBLE_FROM + (1 - ASSEMBLE_FROM) * e;
        n.x = a.to[i * 2] * k;
        n.y = a.to[i * 2 + 1] * k;
        n.vx = n.vy = 0;
      }
      if (t >= 1) S.assemble = null;
      return t < 1;
    }

    function loop() {
      S.rafId = null;
      const introActive =
        S.introStart > 0 && performance.now() - S.introStart < INTRO_MS;
      // When the Web Worker owns the layout (big global graph) we NEVER tick the
      // main-thread sim — that's the whole point, it would freeze the UI. The
      // worker streams positions in and flips S.workerActive; we just repaint.
      let active: boolean;
      if (S.useWorker) {
        active = S.workerActive || introActive;
      } else {
        // The inline sim is never idle. The flow force means there is always
        // new motion to integrate, so we tick (and therefore repaint) every
        // frame the view is open — that is what makes the graph live from the
        // moment it appears instead of a still image you have to poke first.
        // Only the worker path (8k+ nodes) still settles and stops: perpetually
        // re-uploading an instance buffer that large every frame is exactly the
        // cost the worker exists to avoid.
        // Redesign: let a settled graph rest. Once the layout has cooled to the
        // idle floor with nothing dragged and the intro over, stop ticking and
        // repainting; a drag, reheat or hover wakes it (see the idle check below).
        if (S.bloom && bloomStep(sim, S.bloom)) S.bloom = null;
        const assembling = S.assemble != null && stepAssemble();
        const forming = S.bloom != null || assembling;
        const settled =
          !forming && !S.drag && !introActive && sim.alpha() <= REST_ALPHA;
        S.restFrames = settled ? (S.restFrames ?? 0) + 1 : 0;
        active = S.restFrames < 45;
        // Resting also ends the camera's auto-fit, or a later wake would re-fit
        // and nudge the whole view.
        if (!active) webglNeedsFitRef.current = false;
        if (active && !assembling) {
          sim.tick();
          S.layoutRev++;
        }
        // Once the layout stops visibly moving into place, stop chasing it with
        // the camera — otherwise the drift breathes the bounding box and the
        // auto-fit turns that into a wobble of the whole view.
        if (!forming && webglNeedsFitRef.current && sim.alpha() <= FIT_LOCK_ALPHA) {
          webglNeedsFitRef.current = false;
        }
      }
      // The globe keeps turning after the layout rests. That costs drawing only:
      // the physics stays asleep, so an idle spin never re-runs the layout.
      const spinning = globeMoving() || morphing();
      // The idle spin alone is slow enough to draw at 30 fps; anything else
      // (settling, a turn, a morph, a hover) draws every frame.
      const idleSpinOnly =
        spinning && !active && !S.needsDraw && !morphing() && S.globe.target == null;
      const nowMs = performance.now();
      const skipFrame = idleSpinOnly && nowMs - S.lastSpinDraw < 30;
      if (!skipFrame && spinning) S.lastSpinDraw = nowMs;
      if (skipFrame) {
        // Nothing to draw this frame.
      } else if (settingsRef.current.scope === "global" && webgl) {
        // Only rebuild + re-upload + redraw while the layout is moving (or on an
        // explicit request). Once settled the last frame stands, so idle cost is
        // ~zero — this is what keeps the app responsive instead of re-uploading
        // every node every frame forever.
        if (active || spinning || S.needsDraw) drawWebGL();
      } else if (active || S.needsDraw) {
        draw();
      }
      S.needsDraw = false;
      if (!spinning) S.globe.lastT = 0;
      if (active || spinning) {
        S.rafId = requestAnimationFrame(loop);
      } else {
        // Resting: no frames at all. A cheap check four times a second notices
        // a reheat (data refresh, rearrange) that didn't come with a draw request.
        window.clearTimeout(S.idleTimer);
        S.idleTimer = window.setTimeout(() => {
          if (S.rafId == null && (sim.alpha() > REST_ALPHA || S.drag || globeMoving() || morphing())) {
            S.restFrames = 0;
            S.rafId = requestAnimationFrame(loop);
          } else if (S.rafId == null) {
            loop();
          }
        }, 250);
      }
    }

    function requestDraw() {
      S.needsDraw = true;
      if (S.rafId == null) S.rafId = requestAnimationFrame(loop);
    }
    requestDrawRef.current = requestDraw;

    // ---- Interaction ----
    function clientToLocal(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      webglNeedsFitRef.current = false; // user is driving the camera now
      clearHoverTips();
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld(sx, sy);
      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      const newK = clamp(S.camera.k * zoomFactor, MIN_SCALE, MAX_SCALE);
      S.camera.k = newK;
      S.camera.x = sx - width / 2 - before.x * newK;
      S.camera.y = sy - height / 2 - before.y * newK;
      requestDraw();
    }

    function handlePointerDown(e: PointerEvent) {
      webglNeedsFitRef.current = false; // user is driving the camera now
      const { x: sx, y: sy } = clientToLocal(e);
      const hit = nodeAt(sx, sy);
      canvas!.setPointerCapture(e.pointerId);
      canvas!.classList.add("is-dragging");
      if (S.view !== "flat" && !S.globe.on && hit) {
        // Radial / Ring: a press on a note moves that note, not the view.
        S.templateSprings.delete(hit);
        const off = S.templateOffsets.get(hit);
        S.drag = {
          type: "spot",
          node: hit,
          startX: e.clientX,
          startY: e.clientY,
          fromDx: off?.dx ?? 0,
          fromDy: off?.dy ?? 0,
          moved: false,
        };
        return;
      }
      if (S.view !== "flat") {
        // A press on the globe spins it, and on Radial / Ring empty space pans:
        // those shapes are fixed, so nothing is pinned or pulled.
        S.globe.target = null;
        S.globe.lastTouch = performance.now();
        S.drag = { type: "pan", lastX: e.clientX, lastY: e.clientY, moved: false, pick: hit };
        return;
      }
      if (hit) {
        // Pin the grabbed node and keep the sim warm so neighbors react live.
        hit.fx = hit.x;
        hit.fy = hit.y;
        if (S.useWorker) {
          const i = S.indexById.get(hit.id);
          if (i !== undefined) workerRef.current?.fix(i, hit.x, hit.y);
        } else {
          sim.alphaTarget(DRAG_ALPHA);
        }
        S.drag = {
          type: "node",
          node: hit,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        requestDraw();
      } else {
        S.drag = { type: "pan", lastX: e.clientX, lastY: e.clientY, moved: false };
      }
    }

    function handlePointerMove(e: PointerEvent) {
      const { x: sx, y: sy } = clientToLocal(e);
      const drag = S.drag;
      if (drag) {
        if (drag.type === "pan") {
          const dx = e.clientX - drag.lastX;
          const dy = e.clientY - drag.lastY;
          if (dx !== 0 || dy !== 0) {
            drag.moved =
              drag.moved || Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD;
            if (S.globe.on) {
              S.globe.rot.yaw += dx * GLOBE_DRAG_TURN;
              S.globe.rot.pitch = clampPitch(S.globe.rot.pitch - dy * GLOBE_DRAG_TURN);
              S.globe.lastTouch = performance.now();
            } else {
              S.camera.x += dx;
              S.camera.y += dy;
            }
            clearHoverTips();
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;
            requestDraw();
          }
        } else if (drag.type === "spot") {
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          if (!drag.moved && Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD) drag.moved = true;
          if (drag.moved) {
            S.templateOffsets.set(drag.node, {
              dx: drag.fromDx + dx / S.camera.k,
              dy: drag.fromDy + dy / S.camera.k,
            });
            clearHoverTips();
            requestDraw();
          }
        } else {
          const { x: wx, y: wy } = screenToWorld(sx, sy);
          drag.node.fx = wx;
          drag.node.fy = wy;
          if (S.useWorker) {
            // Move it locally for zero-latency feedback, and pin it in the worker
            // so the off-thread sim keeps the neighbors reacting around it.
            drag.node.x = wx;
            drag.node.y = wy;
            const i = S.indexById.get(drag.node.id);
            if (i !== undefined) workerRef.current?.fix(i, wx, wy);
          }
          if (!drag.moved) {
            const dist = Math.hypot(
              e.clientX - drag.startX,
              e.clientY - drag.startY,
            );
            if (dist > CLICK_DRAG_THRESHOLD) drag.moved = true;
          }
          // Loop is already running (alphaTarget 0.3); nudge in case it stalled.
          requestDraw();
        }
        return;
      }
      const hit = nodeAt(sx, sy);
      const hitId = hit?.id ?? null;
      if (hitId !== S.hoveredId) {
        S.hoveredId = hitId;
        canvas!.classList.toggle("is-hovering-node", hitId != null);
        // Name tooltip near the cursor (canvas-local coords). Only updated on
        // change of hovered node, so mousemove itself stays cheap.
        setHoverTips(hit ? hoverTipsFor(hit) : []);
        requestDraw();
      }
    }

    function endDrag(e: PointerEvent) {
      const drag = S.drag;
      canvas!.classList.remove("is-dragging");
      S.drag = null;
      if (drag?.type === "pan" && S.view !== "flat") {
        S.globe.lastTouch = performance.now();
        const pick = drag.pick;
        if (!drag.moved && pick) {
          // On the globe a note round the edge turns to face you first; one in
          // front (or any note on the other shapes) opens.
          if (S.globe.on && viewPos(pick).z < GLOBE_FACE_TO_OPEN) turnToFace(pick);
          else useStore.getState().openNoteByPath(pick.path).then(onClose);
        }
        requestDraw();
      }
      if (drag?.type === "spot") {
        if (!drag.moved) {
          useStore.getState().openNoteByPath(drag.node.path).then(onClose);
        } else {
          // Let go: the note springs back to its place in the shape.
          const off = S.templateOffsets.get(drag.node);
          if (off) {
            S.templateSprings.set(drag.node, { dx: off.dx, dy: off.dy, t0: performance.now() });
            const tick = () => {
              if (!S.templateSprings.size) return;
              requestDraw();
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        }
        requestDraw();
      }
      if (drag?.type === "node") {
        // Release the pin either way — a dropped node is handed back to the
        // forces so gravity pulls it toward the center and the whole graph
        // re-stabilizes. Nothing stays where you put it.
        drag.node.fx = null;
        drag.node.fy = null;
        const wi = S.useWorker ? S.indexById.get(drag.node.id) : undefined;
        if (S.useWorker) {
          if (wi !== undefined) workerRef.current?.release(wi);
        } else {
          // Stop feeding drag energy and let it cool — but only back down to the
          // idle floor, never to zero: a graph that cools to zero is a graph
          // that stops moving.
          sim.alphaTarget(IDLE_ALPHA);
        }
        if (!drag.moved) {
          // A click, not a drag: open the note.
          const path = drag.node.path;
          useStore.getState().openNoteByPath(path).then(onClose);
        } else {
          // A real drag: NO reheat. Dropping a node used to kick the layout back
          // up to alpha 0.25, and that reheat was the visible "boing" — the
          // whole neighbourhood re-solving at a step size big enough to
          // overshoot. Cooling straight to the idle floor instead lets the
          // displaced node be carried home by the ambient flow over several
          // seconds, which is the same journey without the buzz.
          requestDrawRef.current();
        }
      }
      try {
        canvas!.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    requestDraw();

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      window.clearTimeout(S.idleTimer);
      if (S.rafId != null) {
        cancelAnimationFrame(S.rafId);
      }
      // CRUCIAL: reset so a stale id doesn't wedge requestDraw's `== null`
      // guard on a StrictMode remount.
      S.rafId = null;
      sim.stop();
      webgl?.dispose();
      requestDrawRef.current = () => {};
      recolorRef.current = () => {};
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the graph view.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleRefresh = () => {
    setRefreshSpin(true);
    refresh();
    setTimeout(() => setRefreshSpin(false), 700);
  };

  // Only once the self-heal retries are spent: an empty first answer usually
  // means the index isn't ready yet, and flashing the card then is wrong.
  const showEmpty =
    !loading &&
    !error &&
    graph != null &&
    graph.nodes.length === 0 &&
    emptyRetriesRef.current >= 3;

  return (
    <div className="graph-view" ref={wrapRef}>
      {/* No title bar: the canvas runs to the top edge. A strip along it keeps
          the window draggable where the OS chrome would be (macOS traffic-light
          row, Windows caption row; zero height on Linux, whose native title bar
          sits above the webview). The three controls float top-right, clear of
          both, on their own translucent pill so they read on the dark canvas. */}
      <div className="graph-drag-strip" data-tauri-drag-region />
      <div className="graph-floating-controls" role="toolbar" aria-label="Graph controls">
        <button
          className={`graph-icon-btn${showControls ? " is-active" : ""}`}
          title="Graph settings"
          aria-label="Graph settings"
          aria-pressed={showControls}
          onClick={() => setShowControls((v) => !v)}
        >
          ⚙
        </button>
        <button
          className={`graph-icon-btn${refreshSpin ? " is-spinning" : ""}`}
          title="Refresh graph"
          aria-label="Refresh graph"
          onClick={handleRefresh}
        >
          ↻
        </button>
        <button
          className="graph-icon-btn"
          title="Close graph"
          aria-label="Close graph"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {/* The "heartbeat": the settled layout eases up in opacity and by a
          hairline of scale, once, on open. Done on the wrapper rather than in
          either canvas so the 2D and WebGL paths get exactly the same entrance,
          and so it costs one compositor animation instead of per-frame work. */}
      <div
        className={`graph-canvas-wrap graph-intro${settling ? " is-settling" : ""}`}
      >
        <canvas className="graph-canvas" ref={canvasRef} />
        <canvas
          className="graph-canvas"
          ref={webglCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // Events pass through to the 2D canvas below, which owns the shared
            // pan/zoom + hit-test handlers.
            pointerEvents: "none",
            display:
              WEBGL_ENABLED && settings.scope === "global" && !webglError
                ? "block"
                : "none",
          }}
        />
        {settings.scope === "global" && webglError && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              maxWidth: "60%",
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(180,40,40,0.85)",
              color: "#fff",
              font: "11px/1.4 ui-monospace, monospace",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            WebGL unavailable. Showing capped 2D fallback. {webglError}
          </div>
        )}
        {showDiag && WEBGL_ENABLED && settings.scope === "global" && diag && (
          <div
            className="graph-diag"
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
              padding: "4px 8px",
              borderRadius: 6,
              background: "rgba(0,0,0,0.6)",
              color: "#9fef9f",
              font: "10px/1.4 ui-monospace, monospace",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {diag}
          </div>
        )}
        <div
          ref={hubLayerRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            overflow: "hidden",
            zIndex: 5,
            display: settings.scope === "global" ? "block" : "none",
          }}
        />
        {settings.scope === "global" &&
          hoverTips.map((t) => (
            <div
              key={t.id}
              style={{
                position: "absolute",
                left: t.x,
                top: t.y + 10,
                transform: "translateX(-50%)",
                maxWidth: 220,
                padding: t.main ? "3px 8px" : "2px 6px",
                borderRadius: 6,
                background: t.main ? "rgba(18,18,26,0.94)" : "rgba(18,18,26,0.72)",
                color: "#fff",
                font: `${t.main ? 12 : 11}px/1.3 var(--font-body, ui-sans-serif)`,
                border: "1px solid rgba(255,255,255,0.14)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                zIndex: t.main ? 7 : 6,
              }}
            >
              {t.title}
            </div>
          ))}

        {showControls && (
          <GraphControls
            settings={settings}
            onChange={applyPatch}
            onReset={onReset}
            legend={legend}
          />
        )}

        {loading && (
          <div className="graph-state">
            <div className="graph-state-card graph-loading">
              <Spinner size="sm" tone="accent" />
              Loading graph…
            </div>
          </div>
        )}
        {settling && !loading && (
          <div className="graph-state">
            {/* Big-vault path only. The worker is arranging the layout
                off-thread; saying so beats revealing thousands of nodes in
                motion, which is the thing this change exists to remove. */}
            <div className="graph-state-card graph-settling">
              <Spinner size="sm" tone="accent" />
              Arranging {counts.nodes.toLocaleString()} notes…
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="graph-state">
            <div className="graph-state-card">
              <strong>Couldn't load the graph</strong>
              {error}
            </div>
          </div>
        )}
        {showEmpty && (
          <div className="graph-state">
            <div className="graph-state-card graph-empty">
              <div className="graph-empty-glyph" aria-hidden="true">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
                  <line x1="36" y1="36" x2="16" y2="18" className="ge-link" />
                  <line x1="36" y1="36" x2="58" y2="22" className="ge-link" />
                  <line x1="36" y1="36" x2="54" y2="56" className="ge-link" />
                  <circle cx="16" cy="18" r="4" className="ge-node ge-node-dim" />
                  <circle cx="58" cy="22" r="4" className="ge-node" />
                  <circle cx="54" cy="56" r="4" className="ge-node" />
                  <circle cx="36" cy="36" r="7" className="ge-node ge-node-hub" />
                </svg>
              </div>
              <strong>Your graph is empty</strong>
              <span>
                Write a note, then link notes with{" "}
                <code>[[wikilinks]]</code> to grow a living map of your ideas.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
