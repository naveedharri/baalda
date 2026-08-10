/// <reference lib="webworker" />
// Off-main-thread force layout for large graphs. Runs the SAME d3-force config
// as the main thread (createSimulation / configureForces) so a huge vault can
// settle without ever blocking the UI thread. It owns its own copy of the
// nodes/links and streams positions back as a transferable Float32Array; the
// main thread just copies those into its render nodes and draws.
//
// Only the global graph above a node threshold uses this — small/local graphs
// stay on the main-thread sim (proven, and cheap enough to keep interactive).

import {
  createSimulation,
  configureForces,
  DRAG_ALPHA,
  REARRANGE_ALPHA,
  type SimNode,
  type SimLink,
} from "./simulation";
import type { GraphSettings } from "./graphSettings";
import type { ForceLink, Simulation } from "d3-force";

interface NodeSpec {
  id: string;
  radius: number;
  weight: number;
}
interface LinkSpec {
  source: number; // index into the node array
  target: number;
}
interface InitMsg {
  type: "init";
  generation: number;
  nodes: NodeSpec[];
  links: LinkSpec[];
  settings: GraphSettings;
  width: number;
  height: number;
  intro: boolean;
}
type InMsg =
  | InitMsg
  | { type: "settings"; settings: GraphSettings }
  | { type: "reheat"; alpha: number }
  | { type: "fix"; i: number; x: number; y: number }
  | { type: "release"; i: number }
  | { type: "stop" };

const INTRO_KICK = 6;
const POST_INTERVAL_MS = 45; // throttle position posts to ~22 fps of streaming
const post = postMessage as (msg: unknown, transfer?: Transferable[]) => void;
const nowMs = () => globalThis.performance?.now?.() ?? 0;

let sim: Simulation<SimNode, SimLink> | null = null;
let nodes: SimNode[] = [];
let generation = 0;
let running = false;
let lastPost = 0;

/** Deterministic spiral seed over a disc a bit bigger than the viewport, so the
 *  sim starts from a sane spread instead of all-at-origin (which makes the
 *  repulsion force blow up). No Math.random — keeps it reproducible. */
function seed(list: SimNode[], width: number, height: number): void {
  const n = list.length;
  const R = Math.max(width, height, 800) * 0.75;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const a = i * golden;
    const r = R * Math.sqrt((i + 0.5) / n);
    const node = list[i];
    node.x = Math.cos(a) * r;
    node.y = Math.sin(a) * r;
    node.vx = 0;
    node.vy = 0;
    node.fx = null;
    node.fy = null;
  }
}

function tickLoop(): void {
  if (!sim || !running) return;
  // A few ticks per macrotask for faster settle, but fewer as the graph grows
  // so each macrotask stays short and incoming messages (drag/settings) still
  // get processed between batches — the worker never wedges.
  const batch = nodes.length > 20000 ? 1 : nodes.length > 8000 ? 2 : 3;
  for (let i = 0; i < batch; i++) sim.tick();

  const settled = sim.alpha() <= sim.alphaMin();
  const now = nowMs();
  if (settled || now - lastPost >= POST_INTERVAL_MS) {
    lastPost = now;
    const buf = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      buf[i * 2] = nodes[i].x;
      buf[i * 2 + 1] = nodes[i].y;
    }
    post({ type: "positions", generation, alpha: sim.alpha(), buf }, [buf.buffer]);
  }

  if (settled) {
    running = false;
    post({ type: "settled", generation });
    return;
  }
  setTimeout(tickLoop, 0);
}

function start(): void {
  if (running) return;
  running = true;
  lastPost = 0;
  setTimeout(tickLoop, 0);
}

onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      generation = msg.generation;
      nodes = msg.nodes.map(
        (n) =>
          ({
            id: n.id,
            title: "",
            path: "",
            linkCount: 0,
            radius: n.radius,
            weight: n.weight,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            fx: null,
            fy: null,
          }) as SimNode,
      );
      seed(nodes, msg.width, msg.height);
      const links: SimLink[] = msg.links.map((l) => ({
        source: nodes[l.source],
        target: nodes[l.target],
      }));
      if (!sim) sim = createSimulation(msg.settings);
      sim.nodes(nodes);
      (sim.force("link") as ForceLink<SimNode, SimLink>).links(links);
      configureForces(sim, msg.settings);
      // Large graphs cool faster so they reach a stable layout in a reasonable
      // number of ticks instead of grinding one core for a minute-plus.
      sim.alphaDecay(nodes.length > 8000 ? 0.03 : 0.0103);
      if (msg.intro) {
        for (let i = 0; i < nodes.length; i++) {
          const a = i * 2.399963; // golden angle, deterministic direction
          const m = (((i * 9301 + 49297) % 233280) / 233280) * INTRO_KICK;
          nodes[i].vx += Math.cos(a) * m;
          nodes[i].vy += Math.sin(a) * m;
        }
      }
      sim.alpha(1).alphaTarget(0);
      start();
      break;
    }
    case "settings":
      if (sim) {
        configureForces(sim, msg.settings);
        sim.alpha(Math.max(sim.alpha(), REARRANGE_ALPHA));
        start();
      }
      break;
    case "reheat":
      if (sim) {
        sim.alpha(Math.max(sim.alpha(), msg.alpha));
        start();
      }
      break;
    case "fix": {
      const n = nodes[msg.i];
      if (n && sim) {
        n.fx = msg.x;
        n.fy = msg.y;
        // Same calm step size as the main-thread sim — see DRAG_ALPHA.
        sim.alphaTarget(DRAG_ALPHA);
        start();
      }
      break;
    }
    case "release": {
      const n = nodes[msg.i];
      if (n && sim) {
        n.fx = null;
        n.fy = null;
        sim.alphaTarget(0);
      }
      break;
    }
    case "stop":
      running = false;
      break;
  }
};
