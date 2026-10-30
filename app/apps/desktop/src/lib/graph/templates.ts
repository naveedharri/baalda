// Fixed graph shapes (redesign): Radial and Ring. Unlike the globe these are
// not drawn from the physics layout at all; every note's place follows from its
// folder and how many links it has, so the same vault always draws the same
// picture. The physics keeps running underneath for the Flat and Globe shapes.

export type TemplateShape = "radial" | "ring";

export interface TemplateNode {
  id: string;
  path: string;
  linkCount: number;
}

export interface TemplateLayout {
  /** x, y per note, in the order the notes were given. */
  pos: Float32Array;
  /** Folder index per note, for telling a folder's own links from the rest. */
  group: Int32Array;
  /** Radius of the shape, in world units. */
  r: number;
}

/** World units of radius per √(notes): keeps density alike across vault sizes. */
const RADIUS_PER_ROOT = 14;
/** Radians left empty between two folders on the ring. */
const RING_GAP = 0.016;
/** Depth of the ring's band, as a share of its radius: notes scatter across it. */
const RING_BAND = 0.045;
/** Curve segments per link in these shapes. */
export const CURVE_SEGMENTS = 8;

function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

/** A stable 0..1 per note, so a shape never reshuffles between opens. */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

export function templateLayout(nodes: readonly TemplateNode[], shape: TemplateShape): TemplateLayout {
  const n = nodes.length;
  const r = Math.max(120, RADIUS_PER_ROOT * Math.sqrt(n));
  const pos = new Float32Array(n * 2);
  const group = new Int32Array(n);
  const folders = [...new Set(nodes.map((d) => folderOf(d.path)))].sort();
  const byFolder = folders.map(() => [] as number[]);
  nodes.forEach((d, i) => {
    const g = folders.indexOf(folderOf(d.path));
    group[i] = g;
    byFolder[g].push(i);
  });
  for (const list of byFolder) list.sort((a, b) => nodes[b].linkCount - nodes[a].linkCount);
  const maxDeg = nodes.reduce((m, d) => Math.max(m, d.linkCount), 1);

  if (shape === "radial") {
    // Each folder gets a slice sized by its note count; the best-linked notes
    // sit near the middle and the loosely linked ones fan out to the rim.
    let a0 = 0;
    for (const list of byFolder) {
      const span = (list.length / Math.max(1, n)) * Math.PI * 2;
      list.forEach((i, k) => {
        const t = (k + 0.5) / list.length;
        const jitter = (hash01(nodes[i].id + "r") - 0.5) * 0.05;
        // Hubs sit on a small inner circle rather than piling up in the centre.
        const rad = r * (0.16 + 0.84 * Math.sqrt(t) + jitter);
        const a = a0 + span * (0.05 + 0.9 * hash01(nodes[i].id));
        pos[i * 2] = Math.cos(a) * rad;
        pos[i * 2 + 1] = Math.sin(a) * rad;
      });
      a0 += span;
    }
  } else {
    // One ring, folder after folder. Within a folder the busiest note sits in
    // the middle of its arc and the rest fall away to both sides, so a hub's
    // links fan out evenly; notes scatter across a band and the busiest are
    // lifted outward a little.
    const usable = Math.PI * 2 - RING_GAP * folders.length;
    const step = usable / Math.max(1, n);
    let a = 0;
    byFolder.forEach((list, g) => {
      if (g > 0) a += RING_GAP;
      const arc: number[] = new Array(list.length);
      const mid = (list.length - 1) / 2;
      list.forEach((i, k) => {
        const side = k % 2 === 0 ? 1 : -1;
        arc[Math.round(mid + side * Math.ceil(k / 2))] ??= i;
      });
      // Odd/even rounding can collide; fill any gap with the leftovers in order.
      const placed = new Set(arc.filter((v) => v !== undefined));
      const rest = list.filter((i) => !placed.has(i));
      for (let k = 0; k < arc.length; k++) if (arc[k] === undefined) arc[k] = rest.shift()!;
      for (const i of arc) {
        const lift = Math.sqrt(nodes[i].linkCount / maxDeg) * r * 0.08;
        const rad = r * (1 + RING_BAND * hash01(nodes[i].id)) + lift;
        pos[i * 2] = Math.cos(a) * rad;
        pos[i * 2 + 1] = Math.sin(a) * rad;
        a += step;
      }
    });
  }
  return { pos, group, r };
}

/**
 * How far a link bends toward the middle: Radial bends every link a little;
 * Ring keeps a folder's own links close to the ring and sends links between
 * folders across the middle, which is what bundles them.
 */
export function curvePull(shape: TemplateShape, sameFolder: boolean): number {
  if (shape === "radial") return 0.6;
  return sameFolder ? 0.82 : 0.15;
}

/** Write one link as CURVE_SEGMENTS straight pieces bent toward the origin. */
export function writeCurve(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pull: number,
  out: Float32Array,
  at: number,
): number {
  const qx = ((ax + bx) / 2) * pull;
  const qy = ((ay + by) / 2) * pull;
  let px = ax;
  let py = ay;
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * qx + t * t * bx;
    const y = u * u * ay + 2 * u * t * qy + t * t * by;
    out[at++] = px;
    out[at++] = py;
    out[at++] = x;
    out[at++] = y;
    px = x;
    py = y;
  }
  return at;
}
