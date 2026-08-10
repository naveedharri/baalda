import type { ColorMode } from "./graphSettings";
import type { GraphNode } from "./buildGraph";

/** One row of the legend the panel renders alongside the canvas. */
export interface LegendEntry {
  label: string;
  color: string;
  count: number;
}

/** Result of a coloring pass: a per-node lookup plus a summarizing legend. */
export interface ColorResult {
  colorById: Map<string, string>;
  legend: LegendEntry[];
}

/**
 * Categorical palette for folder coloring: **Observable 10** (d3's `schemeObservable10`,
 * the modern successor to Tableau 10), hue order preserved, with two changes for
 * the near-black void this is the only palette ever drawn on:
 *   - every hue is lifted toward its brighter, more saturated form, because a
 *     palette designed for white paper loses most of its separation once the
 *     surround goes black — the darker members converge toward the background
 *     instead of toward each other;
 *   - Observable 10's brown (#9c6b4e) and grey (#9498a0) are replaced by cyan
 *     and lime. Both read as "unlit" rather than as a category on a dark field;
 *     a folder should never look switched off.
 * Ten hues is also about the ceiling for a categorical scale before neighbours
 * stop being tellable apart, so the tail is two spares rather than an ambition
 * to color thirty folders distinctly.
 */
export const PALETTE: string[] = [
  "#5b8ff9", // blue
  "#f6c445", // amber
  "#ff8360", // coral
  "#4fd6b8", // teal
  "#4ad66d", // green
  "#ff8ab7", // pink
  "#b47cff", // violet
  "#9fd0ff", // sky
  "#22d3ee", // cyan     (Observable's brown — too dark on black)
  "#c3e64b", // lime     (Observable's grey — reads as disabled)
  "#ff5c8a", // rose
  "#7d90bd", // steel
];

/** Clamp to a byte so channel math never overflows the 0–255 range. */
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parse "#rrggbb" (or "#rgb") into [r,g,b]; falls back to mid-grey if unparseable. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [128, 128, 128];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const s = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${s(r)}${s(g)}${s(b)}`;
}

/**
 * Deterministic per-channel linear interpolation between two hex colors.
 * t is clamped to [0,1]; t=0 → a, t=1 → b. Kept intentionally simple (no
 * gamma/HSL) — the degree ramp only needs a visually monotonic blend.
 */
export function lerpHex(a: string, b: string, t: number): string {
  const clampT = Math.max(0, Math.min(1, t));
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * clampT,
    ca[1] + (cb[1] - ca[1]) * clampT,
    ca[2] + (cb[2] - ca[2]) * clampT,
  ]);
}

/** Top-level folder segment of a note path; notes at the root bucket as "Root". */
function topFolder(path: string): string {
  return path.includes("/") ? path.split("/")[0] : "Root";
}

function assignByFolder(nodes: GraphNode[]): ColorResult {
  // Stable colors: sort distinct folders alphabetically, then index into PALETTE.
  const folders = Array.from(new Set(nodes.map((n) => topFolder(n.path)))).sort();
  const folderColor = new Map<string, string>();
  folders.forEach((f, i) => folderColor.set(f, PALETTE[i % PALETTE.length]));

  const colorById = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const f = topFolder(n.path);
    colorById.set(n.id, folderColor.get(f)!);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  const legend: LegendEntry[] = folders
    .map((f) => ({ label: f, color: folderColor.get(f)!, count: counts.get(f) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { colorById, legend };
}

/**
 * The degree ramp: four samples of **plasma**, the perceptually-uniform
 * colormap that data-viz guidance singles out (with inferno) as the sequential
 * scale built for dark backgrounds — it never touches a dark end, so no tier
 * sinks into the void.
 *
 * It replaces a ramp that ran deep-slate → accent → warm white. Everything below
 * the top tier came out a dim blue-grey barely separable from the background:
 * on a heavy-tailed vault that is 99% of the graph, so the graph read as dull
 * and flat *because the colouring made it dull and flat*. Plasma spends its
 * whole range on saturated hue AND rising lightness, so degree is legible twice
 * over — by colour and by brightness — and every node is unmistakably lit.
 */
// Truncated at both ends: plasma's own floor (#0d0887, a near-black indigo)
// would put the lowest tier straight back into the void, and its ceiling
// (#f0f921) is a green-yellow that fights the amber in the folder palette.
// Every entry clears 3:1 against the backdrop — see the contrast test.
const DEGREE_RAMP = [
  "#b12a90", // plasma 0.40 — magenta
  "#d8576b", // plasma 0.50 — rose
  "#ed7953", // plasma 0.65 — orange
  "#fdca26", // plasma 0.85 — gold
];

function assignByDegree(nodes: GraphNode[]): ColorResult {
  const shades = DEGREE_RAMP;

  const maxDeg = nodes.reduce((m, n) => Math.max(m, n.linkCount), 0);

  // Tier boundaries on a LOG scale, not linear thirds.
  //
  // Link-degree in a real vault is heavy-tailed: on a 3.4k-note vault the top
  // node had 1259 links while the vast majority had a handful. Linear thirds of
  // [1, 1259] therefore produced tiers of "1–420 → 3370 nodes", "421–839 → 0",
  // "840–1259 → 5" — one bucket holding 99.9% of the graph, so almost every node
  // drew in the same shade and the colouring carried no information at all.
  // Splitting log(degree) instead puts the boundaries where the nodes are.
  const logSpan = Math.log(Math.max(2, maxDeg));
  const lowMax = Math.max(1, Math.round(Math.exp(logSpan / 3)));
  const midMax = Math.max(lowMax + 1, Math.round(Math.exp((logSpan * 2) / 3)));

  const tierOf = (deg: number): number => {
    if (deg <= 0) return 0;
    if (deg <= lowMax) return 1;
    if (deg <= midMax) return 2;
    return 3;
  };

  const colorById = new Map<string, string>();
  const counts = [0, 0, 0, 0];
  for (const n of nodes) {
    const t = tierOf(n.linkCount);
    colorById.set(n.id, shades[t]);
    counts[t]++;
  }

  const labels = [
    "0",
    lowMax <= 1 ? "1" : `1–${lowMax}`,
    midMax <= lowMax + 1 ? `${lowMax + 1}` : `${lowMax + 1}–${midMax}`,
    maxDeg <= midMax + 1 ? `${Math.max(midMax + 1, maxDeg)}` : `${midMax + 1}–${maxDeg}`,
  ];

  const legend: LegendEntry[] = [0, 1, 2, 3].map((i) => ({
    label: labels[i],
    color: shades[i],
    count: counts[i],
  }));

  return { colorById, legend };
}

/**
 * Assign a fill color to every node according to `mode`. Pure and deterministic
 * so the canvas layer can recolor on demand without side effects.
 */
export function assignColors(
  nodes: GraphNode[],
  mode: ColorMode,
  accent: string,
): ColorResult {
  switch (mode) {
    case "folder":
      return assignByFolder(nodes);
    case "degree":
      return assignByDegree(nodes);
    case "uniform":
    default: {
      const colorById = new Map<string, string>();
      for (const n of nodes) colorById.set(n.id, accent);
      return { colorById, legend: [] };
    }
  }
}
