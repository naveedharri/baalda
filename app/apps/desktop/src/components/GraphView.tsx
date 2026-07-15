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
import { useStore } from "../store";
import { GraphControls } from "./GraphControls";
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

// Startup "come to life" burst.
const INTRO_MS = 1200; // duration of the light flare + settle
const INTRO_KICK = 28; // initial random velocity magnitude — the quick shake

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

export function GraphView({ onClose }: { onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { graph, loading, error, refresh } = useGraphData();

  // Settings live in BOTH a ref (read from inside the imperative canvas/sim
  // code, which can't see React state closures) and React state (drives the
  // controls panel). applyPatch keeps them in lockstep.
  const settingsRef = useRef<GraphSettings>(loadSettings());
  const [settings, setSettings] = useState<GraphSettings>(settingsRef.current);

  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const [showControls, setShowControls] = useState(false);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
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

    // Filter DIMS via search (draw-time); here we only HIDE by degree/orphans.
    const visNodes = all.filter(
      (n) =>
        !(s.hideOrphans && n.linkCount === 0) && n.linkCount >= s.minDegree,
    );
    const visible = new Set(visNodes.map((n) => n.id));
    const links: SimLink[] = g.edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    // d3 init order: nodes() BEFORE link.links() so the link force resolves
    // {source,target} ids against the current node array.
    sim.nodes(visNodes);
    (sim.force("link") as ForceLink<SimNode, SimLink>).links(links);
    sim.alpha(1);

    // First time real data lands: light the graph up. Give every node a random
    // velocity impulse (the "quick shake") and start the intro clock so the
    // draw loop paints the light flare from all nodes, then it all settles.
    if (!S.introKicked && visNodes.length > 0) {
      for (const node of visNodes) {
        const a = Math.random() * Math.PI * 2;
        const m = Math.random() * INTRO_KICK;
        node.vx += Math.cos(a) * m;
        node.vy += Math.sin(a) * m;
      }
      S.introKicked = true;
      S.introStart = performance.now();
    }

    S.visNodes = visNodes;
    S.visEdges = links; // now resolved in place by forceLink
    S.drawOrder = [...visNodes].sort((a, b) => a.radius - b.radius);

    const accent = S.colors.accent || FALLBACK_ACCENT;
    const { colorById, legend: lg } = assignColors(visNodes, s.colorMode, accent);
    S.colorById = colorById;
    setLegend(lg);
    setCounts({ nodes: visNodes.length, edges: links.length });

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
        (k) => k === "minDegree" || k === "hideOrphans",
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
        configureForces(sim, next);
        sim.alpha(Math.max(sim.alpha(), 0.3));
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
    if (graph) rebuild();
  }, [graph, rebuild]);

  // ---- Canvas setup: runs once; everything else flows through refs. ----
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current!;

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

      // Startup burst: everything flares with extra light, then eases to rest.
      const nowT = performance.now();
      const introT =
        S.introStart > 0 ? clamp((nowT - S.introStart) / INTRO_MS, 0, 1) : 1;
      const introEase = 1 - Math.pow(1 - introT, 3); // easeOutCubic
      const glowBoost = 1 + (1 - introEase) * 2.4; // nodes are brightest at birth

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

      // ---- Startup light flash (screen space, additive) ----
      if (introT < 1) {
        ctx!.save();
        ctx!.globalCompositeOperation = "lighter";
        const flash = Math.pow(1 - introEase, 2) * 0.4;
        const cx = width / 2;
        const cy = height * 0.44;
        const g = ctx!.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          Math.max(width, height) * 0.6,
        );
        g.addColorStop(0, `rgba(160,180,235,${flash})`);
        g.addColorStop(1, "rgba(160,180,235,0)");
        ctx!.fillStyle = g;
        ctx!.fillRect(0, 0, width, height);
        ctx!.restore();
      }
    }

    // Single frame clock. The loop stays alive the whole time the graph is
    // mounted so the lighting keeps breathing and the scene feels alive at rest.
    // Physics is the expensive part, so we tick it ONLY while the sim is warm
    // (or during the intro) — idle frames are a cheap repaint of a still layout.
    function loop() {
      S.rafId = null;
      const introActive =
        S.introStart > 0 && performance.now() - S.introStart < INTRO_MS;
      if (sim.alpha() > sim.alphaMin() || introActive) sim.tick();
      draw();
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
      const { x: sx, y: sy } = clientToLocal(e);
      const hit = nodeAt(sx, sy);
      canvas!.setPointerCapture(e.pointerId);
      canvas!.classList.add("is-dragging");
      if (hit) {
        // Pin the grabbed node and keep the sim warm so neighbors react live.
        hit.fx = hit.x;
        hit.fy = hit.y;
        sim.alphaTarget(0.3);
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
        requestDraw();
      }
    }

    function endDrag(e: PointerEvent) {
      const drag = S.drag;
      canvas!.classList.remove("is-dragging");
      S.drag = null;
      if (drag?.type === "node") {
        sim.alphaTarget(0); // stop feeding energy; let it cool naturally
        // Release the pin either way — a dropped node is handed back to the
        // forces so gravity pulls it toward the center and the whole graph
        // re-stabilizes. Nothing stays where you put it.
        drag.node.fx = null;
        drag.node.fy = null;
        if (!drag.moved) {
          // A click, not a drag: open the note.
          const path = drag.node.path;
          useStore.getState().openNoteByPath(path).then(onClose);
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
          {counts.nodes} {counts.nodes === 1 ? "note" : "notes"} · {counts.edges}{" "}
          {counts.edges === 1 ? "link" : "links"}
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

      <div className="graph-canvas-wrap">
        <canvas className="graph-canvas" ref={canvasRef} />

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
            <div className="graph-state-card">
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
