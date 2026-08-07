import { useCallback, useEffect, useRef, useState } from "react";
import type { Simulation, ForceLink } from "d3-force";
import type { Graph } from "../lib/graph/buildGraph";
import {
  createSimulation,
  configureForces,
  nodeRadius,
  centerWeight,
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
import { useStore } from "../store";
import { GraphControls } from "./GraphControls";
import { Spinner } from "./Spinner";
import "./graph.css";

// ---------------------------------------------------------------------------
// Immersive, physics-driven note graph. Physics is d3-force (see simulation.ts),
// but we own the clock: the sim's internal timer is stopped and we call
// sim.tick() ourselves inside a requestAnimationFrame loop so painting and
// physics share one frame. React owns only React-y things — data loading, the
// settings panel, header counts. Camera / hover / drag / positions all live in
// refs so interaction never triggers a reconciliation pass.
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
const CLICK_DRAG_THRESHOLD = 4; // px moved before a pointerdown counts as a drag
const LABEL_FADE_START = 1.5; // camera.k at which labels begin to appear (labelScale 1)
const LABEL_FADE_END = 2.4; // camera.k at which labels are fully opaque (labelScale 1)
const DEFAULT_FONT_FAMILY = "sans-serif";
const FALLBACK_ACCENT = "#7f73ff";

// The graph opens ALREADY SETTLED. It used to seed positions, kick every node
// with a random velocity and then animate the whole layout finding its shape on
// screen — which reads as the view detonating and reassembling itself, not as
// something coming to life. Watching furniture arrange itself is not an intro;
// it's a wait you're forced to watch, and it happens every single time you press
// ⌘G on a graph whose shape you already know.
//
// So the settle now happens BEFORE the first frame (`presettle`), and the only
// motion left on open is a soft fade + a barely-there scale — the "heartbeat".
// The layout itself is static from frame one.
const INTRO_MS = 620; // fade/scale-in only; no node motion

// Time budget for settling the layout before the first paint. This blocks the
// UI thread, so it is a budget and not a tick count: small vaults converge in
// well under it, and a big one stops early with alpha already low enough that
// the remaining on-screen motion is a drift rather than a rearrangement.
// ~650 ticks is full convergence at alphaDecay 0.0103 (see simulation.ts).
const PRESETTLE_BUDGET_MS = 420;
const PRESETTLE_MAX_TICKS = 700;

// How hard a *data refresh* re-energizes the layout. The first build needs real
// energy to find a shape from seeded positions; later rebuilds already have a
// settled layout and only need to absorb what changed, so they get a small warm
// nudge. Reheating those to 1 was what made the graph appear to "reset": every
// `file-changed` event (a whole storm of them while a vault syncs) threw the
// entire layout back to maximum energy and it visibly flew apart and re-settled.
const REHEAT_FIRST = 1;
const REHEAT_REFRESH = 0.22;

// Fallback cap for the global scope on the 2D canvas, which only stays smooth
// up to a few hundred nodes. The GPU (WebGL) renderer draws the whole vault, so
// this cap only applies when WebGL is unavailable.
const GLOBAL_2D_CAP = 600;
const WEBGL_ENABLED = true;

// Above this node count, the global graph runs its force layout in a Web Worker
// (see simWorker.ts) so a huge vault (50k+) can settle without freezing the UI
// thread. At or below it, the sim runs inline — proven smooth up to ~5.5k and it
// keeps drag/interaction latency zero. If the Worker API is unavailable, the
// global sim is capped to this size so the main thread can never lock up.
const WORKER_THRESHOLD = 8000;


// Matte-sphere lighting. A single soft key light from the upper-left, tilted
// toward the viewer, is baked once into grayscale alpha sprites (makeShadeSprites)
// and stamped over each flat-colored disc. That gives real diffuse volume — no
// glossy specular hotspot, no per-node gradient cost — so nodes read as lit
// objects with depth instead of flat stickers.
const LIGHT = (() => {
  const x = -0.5;
  const y = -0.62;
  const z = 0.6;
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
})();
const SPRITE_SIZE = 256; // resolution of the baked shading / shadow / glow sprites

// Edges are quiet connective threads (source-over), not the old additive bloom
// that washed the whole field into a purple haze.
const EDGE_REST = "rgba(128,146,196,1)";

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Run the force layout to equilibrium synchronously, before anything is drawn,
 * so the graph's first frame is its final shape.
 *
 * `sim.tick(n)` is d3's own batch form — it advances the layout without
 * dispatching tick events, which is exactly what a pre-settle wants (our
 * renderer drives painting from its own rAF loop and must not run yet).
 *
 * Ticks are taken in small batches so the elapsed-time check is cheap relative
 * to the work: `performance.now()` per tick would measure the clock as much as
 * the physics. When the budget runs out we stop and leave the layout where it
 * is — alpha is monotonically decreasing, so an early exit means "slightly warm"
 * (a drift over a second) rather than "unsettled" (a visible rearrangement).
 */
function presettle(sim: Simulation<SimNode, SimLink>): void {
  const deadline = performance.now() + PRESETTLE_BUDGET_MS;
  const BATCH = 20;
  let ticks = 0;
  while (ticks < PRESETTLE_MAX_TICKS && sim.alpha() > sim.alphaMin()) {
    sim.tick(BATCH);
    ticks += BATCH;
    if (performance.now() >= deadline) break;
  }
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

/**
 * Bake diffuse sphere lighting into two grayscale alpha sprites: `light` (white,
 * the lit cap) and `shadow` (black, the shadowed side plus a rim of ambient
 * occlusion). Stamping a flat disc → shadow → light turns any color into a matte
 * 3D sphere, independent of the node's own hue, for one drawImage each.
 */
function makeShadeSprites(size: number): {
  light: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
} {
  const light = document.createElement("canvas");
  const shadow = document.createElement("canvas");
  light.width = light.height = shadow.width = shadow.height = size;
  const lg = light.getContext("2d")!;
  const sg = shadow.getContext("2d")!;
  const li = lg.createImageData(size, size);
  const si = sg.createImageData(size, size);
  const R = size / 2;
  const mid = 0.12; // diffuse level treated as neutral (neither lit nor shadowed)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = (x + 0.5 - R) / R;
      const ny = (y + 0.5 - R) / R;
      const r2 = nx * nx + ny * ny;
      if (r2 >= 1) continue; // outside the sphere → transparent (buffer is zeroed)
      const nz = Math.sqrt(1 - r2);
      const diff = nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z; // Lambert term
      const rn = Math.sqrt(r2);
      const edgeAA = clamp((1 - rn) * R, 0, 1); // ~1px feather at the circumference
      // Lit cap: matte, so modest and capped, and eased off at the very rim so
      // there is no bright specular edge.
      const la =
        clamp(diff - mid, 0, 1) * 0.5 * (1 - smoothstep(0.6, 1, rn) * 0.7) * edgeAA;
      // Shadow side + a ring of ambient occlusion that seats the sphere.
      const occ = smoothstep(0.66, 1, rn) * 0.5;
      const sa = clamp(clamp(mid - diff, 0, 1) * 0.9 + occ, 0, 0.92) * edgeAA;
      li.data[idx] = 255;
      li.data[idx + 1] = 255;
      li.data[idx + 2] = 255;
      li.data[idx + 3] = Math.round(la * 255);
      si.data[idx + 3] = Math.round(sa * 255); // RGB already 0 → pure black
    }
  }
  lg.putImageData(li, 0, 0);
  sg.putImageData(si, 0, 0);
  return { light, shadow };
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
  | { type: "pan"; lastX: number; lastY: number; moved: boolean }
  | {
      type: "node";
      node: SimNode;
      startX: number;
      startY: number;
      moved: boolean;
    };

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
    label: "rgba(205, 210, 224, 0.6)",
    labelActive: "#f2f4fb",
  };
}

/**
 * Build the full SimNode array for a graph, reusing existing node objects so
 * positions/velocities survive a data refresh. New nodes are seeded on a
 * golden-angle spiral near the origin (never all stacked at 0,0, which would
 * blow up the repulsion force on the first tick).
 */
function buildSimNodes(graph: Graph, previous: Map<string, SimNode>): SimNode[] {
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Separate GPU canvas for the global scope (a canvas can hold only one context
  // type, so WebGL gets its own; the 2D canvas keeps the local view).
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Whether the GPU renderer initialized. Read imperatively by `rebuild` to
  // decide the global fallback; mirrored to state (`webglError`) for the UI.
  const webglOkRef = useRef(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  // On-screen WebGL diagnostic (updated imperatively, sampled to state below).
  const diagRef = useRef("");
  const [diag, setDiag] = useState("");
  // Hover tooltip for the WebGL global view: the hovered note's name + position
  // (canvas-local px). Set only when the hovered node changes.
  const [hoverTip, setHoverTip] = useState<{ title: string; x: number; y: number } | null>(null);
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
  // StrictMode remounts because refs persist).
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  if (!simRef.current) simRef.current = createSimulation(settingsRef.current);

  const graphRef = useRef<Graph | null>(null);

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
    colorById: new Map<string, string>(),
    camera: { x: 0, y: 0, k: 1 } as Camera,
    hoveredId: null as string | null,
    drag: null as Drag | null,
    rafId: null as number | null,
    needsDraw: true,
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

    const all = buildSimNodes(g, S.nodesById);
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

    // First time real data lands: settle the layout NOW, off-screen, so the
    // first painted frame is the finished shape. The intro clock then drives a
    // fade + hairline scale only — the graph does not move.
    //
    // Not done for the worker path: that exists precisely because ticking a
    // 8k+ node layout on this thread would freeze the window, and blocking here
    // would be the same freeze by another name. The worker settles it off-thread
    // instead (see `worker.init(..., first)` below).
    if (first && visNodes.length > 0) {
      const willUseWorker =
        !openNode && workerRef.current !== null && visNodes.length > WORKER_THRESHOLD;
      if (!willUseWorker) presettle(sim);
      S.introKicked = true;
      S.introStart = performance.now();
    }

    S.visNodes = visNodes;
    S.visEdges = links; // now resolved in place by forceLink
    S.drawOrder = [...visNodes].sort((a, b) => a.radius - b.radius);

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
          sim.alpha(Math.max(sim.alpha(), 0.3));
        }
        requestDrawRef.current();
        return;
      }
      // Visual-only (nodeSize / edgeThickness / labelScale / colorMode / search):
      // no reheat — just recolor if needed and repaint one frame.
      if (keys.includes("colorMode")) recolorRef.current();
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
  // (diagnostic HUD only; avoids a per-frame setState).
  useEffect(() => {
    if (!WEBGL_ENABLED) return;
    const id = setInterval(() => setDiag(diagRef.current), 500);
    return () => clearInterval(id);
  }, []);

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

    // Baked lighting sprites (color-independent) + a tiny color-parse cache so
    // the per-frame draw stays allocation-free even with continuous animation.
    const shade = makeShadeSprites(SPRITE_SIZE);
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
      for (const node of S.visNodes) {
        const dx = node.x - wx;
        const dy = node.y - wy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const hitRadius = node.radius * nodeScale + 4 / S.camera.k;
        if (d <= hitRadius && d < bestDist) {
          best = node;
          bestDist = d;
        }
      }
      return best;
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

      // The only per-node part of the entrance: nodes come up a touch brighter
      // and ease down to their resting glow — a breath, on a layout that is
      // already static. Nothing here moves anything.
      const nowT = performance.now();
      const introT =
        S.introStart > 0 ? clamp((nowT - S.introStart) / INTRO_MS, 0, 1) : 1;
      const introEase = 1 - Math.pow(1 - introT, 3); // easeOutCubic
      // Modest on purpose. This was 2.1× when it had a scattering layout to
      // dress up; against a settled one that reads as a flashbulb.
      const glowBoost = 1 + (1 - introEase) * 0.45;

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
      ctx!.strokeStyle = EDGE_REST;
      ctx!.globalAlpha = hovered ? 0.03 : 0.1 * (0.5 + 0.5 * introEase);
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
        const base = node.radius * nodeScale;
        ctx!.globalAlpha = dimmed ? 0.12 : 0.4;
        stamp(shadowSprite, node.x + base * 0.16, node.y + base * 0.5, base * 2.3);
      }

      // ---- Ambient glow: the soft light each orb sheds, gently breathing ----
      ctx!.globalCompositeOperation = "lighter";
      for (let i = 0; i < drawNodes.length; i++) {
        const node = drawNodes[i];
        if (!matches(node)) continue;
        if (hovered != null && !neighbors.has(node.id)) continue;
        const base = node.radius * nodeScale;
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

        const base = node.radius * nodeScale;
        const r = isHovered ? base * 1.32 : base;
        const color = isOpen
          ? colors.accent
          : S.colorById.get(node.id) ?? colors.nodeFallback;

        // A colored bloom for the open note / hovered orb — a little extra life.
        if ((isOpen || isHovered) && !dimBySearch) {
          const [cr, cg, cb] = getRgb(color);
          const gg = ctx!.createRadialGradient(
            node.x,
            node.y,
            0,
            node.x,
            node.y,
            r * 3,
          );
          gg.addColorStop(0, `rgba(${cr},${cg},${cb},0.55)`);
          gg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          ctx!.globalCompositeOperation = "lighter";
          ctx!.globalAlpha = 1;
          ctx!.fillStyle = gg;
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, r * 3, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.globalCompositeOperation = "source-over";
        }

        // Flat base disc, then the baked shadow + light sprites stamp matte
        // volume onto it. globalAlpha carries into the sprites, so a dimmed orb
        // simply shades fainter — no separate dim path needed.
        ctx!.globalAlpha = dimmed ? 0.24 : 1;
        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fill();
        const d = r * 2;
        ctx!.drawImage(shade.shadow, node.x - r, node.y - r, d, d);
        ctx!.drawImage(shade.light, node.x - r, node.y - r, d, d);

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
        const wantLabel = isHovered || isOpen || zoomLabelAlpha > 0.01;
        if (wantLabel) {
          let alpha = isHovered || isOpen ? 1 : zoomLabelAlpha;
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

    // Global scope: draw every node on the GPU (auto-fit to the viewport for
    // now; pan/zoom/hover come next). Rebuilds the instance buffer each frame —
    // fine for this first cut.
    const webglNodes: RenderNode[] = [];
    let edgePositions = new Float32Array(0);
    function drawWebGL() {
      if (!webgl || !webglCanvas) return;
      const fallback = S.colors.nodeFallback;
      const nodeScale = settingsRef.current.nodeSize;
      // Shrink nodes as the graph grows so a bigger vault reads as "smaller
      // dots, more space" rather than a compacted pile. ~1 for a few hundred
      // nodes, ~0.2 at 50k. The layout also spreads (repulsion scales with n),
      // so together the graph expands and keeps breathing room.
      const countScale = Math.min(1, 40 / Math.sqrt(Math.max(1, S.visNodes.length)));
      // Hover: light up the hovered node + its direct neighbors, dim the rest,
      // so you can see a note's connections at a glance.
      const hoveredId = S.hoveredId;
      const hlSet =
        hoveredId && graphRef.current
          ? neighborhoodIds(graphRef.current, hoveredId, 1)
          : null;
      webglNodes.length = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of S.visNodes) {
        const c = getRgb(S.colorById.get(n.id) ?? fallback);
        const dim = hlSet && !hlSet.has(n.id) ? 0.16 : 1;
        const big =
          n.id === hoveredId ? 2.4 : hlSet && hlSet.has(n.id) ? 1.8 : 1;
        webglNodes.push({
          x: n.x,
          y: n.y,
          r: n.radius * nodeScale * countScale * big,
          color: [(c[0] / 255) * dim, (c[1] / 255) * dim, (c[2] / 255) * dim],
        });
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      webgl.setNodes(webglNodes);
      // Edges: two world-space vertices per link (source → target), read from
      // the sim nodes forceLink resolved in place.
      const edges = S.visEdges;
      if (edgePositions.length < edges.length * 4) {
        edgePositions = new Float32Array(edges.length * 4);
      }
      for (let i = 0; i < edges.length; i++) {
        const src = edges[i].source as SimNode;
        const tgt = edges[i].target as SimNode;
        const o = i * 4;
        edgePositions[o] = src.x;
        edgePositions[o + 1] = src.y;
        edgePositions[o + 2] = tgt.x;
        edgePositions[o + 3] = tgt.y;
      }
      webgl.setEdges(edgePositions.subarray(0, edges.length * 4));
      // Hover: bright rays from the hovered node to each of its neighbors, so
      // connections are traceable even in a huge cloud.
      if (hoveredId) {
        const hl: number[] = [];
        for (let i = 0; i < edges.length; i++) {
          const s = edges[i].source as SimNode;
          const t = edges[i].target as SimNode;
          if (s.id === hoveredId || t.id === hoveredId) {
            hl.push(s.x, s.y, t.x, t.y);
          }
        }
        webgl.setHighlightEdges(new Float32Array(hl));
      } else {
        webgl.setHighlightEdges(new Float32Array(0));
      }
      // One-shot: fit the shared camera to the graph. After that the user's
      // pan/zoom (which mutates S.camera via the 2D handlers) drives the view.
      if (webglNeedsFitRef.current && webglNodes.length > 0) {
        // Keep the graph framed as the layout expands during settle; the flag is
        // cleared the moment the user pans/zooms (in the interaction handlers).
        const bw = Math.max(1, maxX - minX);
        const bh = Math.max(1, maxY - minY);
        S.camera.k = Math.min((width - 80) / bw, (height - 80) / bh);
        S.camera.x = -((minX + maxX) / 2) * S.camera.k;
        S.camera.y = -((minY + maxY) / 2) * S.camera.k;
      }
      // Same transform as the 2D path: screen_css = width/2 + cam.x + world·cam.k,
      // then scaled by dpr into the device-pixel drawing buffer.
      const cam = S.camera;
      webgl.draw(
        cam.k * dpr,
        (width / 2 + cam.x) * dpr,
        (height / 2 + cam.y) * dpr,
        // Small floor so nodes can shrink to give space at the whole-graph
        // overview (they grow back as you zoom in); avoids the compacted pile.
        1.5 * dpr,
      );
      diagRef.current =
        `webgl ✓ · nodes ${webglNodes.length} · buf ${webglCanvas.width}×${webglCanvas.height} · ` +
        `k ${cam.k.toFixed(3)} · cam ${Math.round(cam.x)},${Math.round(cam.y)} · ` +
        `bounds ${Math.round(minX)},${Math.round(minY)}..${Math.round(maxX)},${Math.round(maxY)} · ` +
        `gl ${webgl.glError()}`;
    }

    // Single frame clock. The loop stays alive the whole time the graph is
    // mounted so the lighting keeps breathing and the scene feels alive at rest.
    // Physics is the expensive part, so we tick it ONLY while the sim is warm
    // (or during the intro) — idle frames are a cheap repaint of a still layout.
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
        active = sim.alpha() > sim.alphaMin() || introActive;
        if (active) sim.tick();
      }
      if (settingsRef.current.scope === "global" && webgl) {
        // Only rebuild + re-upload + redraw while the layout is moving (or on an
        // explicit request). Once settled the last frame stands, so idle cost is
        // ~zero — this is what keeps the app responsive instead of re-uploading
        // every node every frame forever.
        if (active || S.needsDraw) drawWebGL();
      } else {
        draw();
      }
      S.needsDraw = false;
      S.rafId = requestAnimationFrame(loop);
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
      if (hit) {
        // Pin the grabbed node and keep the sim warm so neighbors react live.
        hit.fx = hit.x;
        hit.fy = hit.y;
        if (S.useWorker) {
          const i = S.indexById.get(hit.id);
          if (i !== undefined) workerRef.current?.fix(i, hit.x, hit.y);
        } else {
          sim.alphaTarget(0.3);
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
            S.camera.x += dx;
            S.camera.y += dy;
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;
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
        setHoverTip(hit ? { title: hit.title, x: sx, y: sy } : null);
        requestDraw();
      }
    }

    function endDrag(e: PointerEvent) {
      const drag = S.drag;
      canvas!.classList.remove("is-dragging");
      S.drag = null;
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
          sim.alphaTarget(0); // stop feeding energy; let it cool naturally
        }
        if (!drag.moved) {
          // A click, not a drag: open the note.
          const path = drag.node.path;
          useStore.getState().openNoteByPath(path).then(onClose);
        } else if (S.useWorker) {
          // A real drag: gentle reheat so the displaced node drifts home calmly.
          if (wi !== undefined) workerRef.current?.reheat(0.25);
          requestDrawRef.current();
        } else {
          // A real drag: a gentle reheat so the displaced node drifts home
          // slowly and calmly (low energy = slow return, not a snap-back).
          sim.alpha(Math.max(sim.alpha(), 0.25));
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

  const showEmpty =
    !loading && !error && graph != null && counts.nodes === 0;

  return (
    <div className="graph-view" ref={wrapRef}>
      <div className="graph-header">
        <span className="graph-title">Graph</span>
        <span className="graph-counts">
          {counts.total > counts.nodes
            ? `${counts.nodes.toLocaleString()} of ${counts.total.toLocaleString()} notes`
            : `${counts.nodes} ${counts.nodes === 1 ? "note" : "notes"}`}{" "}
          · {counts.edges} {counts.edges === 1 ? "link" : "links"}
        </span>
        <span className="graph-header-spacer" />
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
            WebGL unavailable — showing capped 2D fallback. {webglError}
          </div>
        )}
        {WEBGL_ENABLED && settings.scope === "global" && diag && (
          <div
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
        {settings.scope === "global" && hoverTip && (
          <div
            style={{
              position: "absolute",
              left: hoverTip.x + 12,
              top: hoverTip.y + 12,
              maxWidth: 260,
              padding: "3px 8px",
              borderRadius: 6,
              background: "rgba(18,18,26,0.94)",
              color: "#fff",
              font: "12px/1.3 var(--font-body, ui-sans-serif)",
              border: "1px solid rgba(255,255,255,0.14)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              zIndex: 6,
            }}
          >
            {hoverTip.title}
          </div>
        )}

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
            <div className="graph-state-card">Loading graph…</div>
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
