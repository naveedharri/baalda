// Globe view (redesign). The layout itself stays flat: the same physics, the
// same folder regions, the same background pre-layout. Only drawing wraps it
// onto a sphere, so nothing here touches the simulation.
//
// The flat map is unfolded around the layout's middle: each note keeps its
// direction, and its distance sets how far round the sphere it lands. Distance
// is measured against the layout's own outline, then spread so every band of
// the sphere holds its fair share of notes. Neighbours stay neighbours, the
// layout's edge closes up at the back pole, and the whole sphere is covered
// whatever shape the layout settled into.

/** Below this many visible notes the graph draws flat. Kept low (was 150) so a
 *  small vault still reads as a round globe instead of silently going flat. */
export const GLOBE_MIN_NODES = 8;
/** Directions the layout's outline is measured in. */
const RIM_SECTORS = 64;
/** Sectors either side a rim reading reaches, so one stray note cannot spike it. */
const RIM_REACH = 2;
/** A direction with no notes still reaches this share of the farthest note. */
const RIM_FLOOR = 0.25;
/** Steps in the table that evens out how notes fall from middle to edge. */
const SPREAD_STEPS = 128;
/** Share of the sphere covered. The gap left at the back pole is narrower than the
 *  space between notes, so it never reads as a hole. */
const COVER = 0.9999;
/** How far the smoothed frame moves toward the latest one each frame. */
const FRAME_EASE = 0.05;
/** Tilt limit so the globe can never flip upside down while dragging. */
const PITCH_LIMIT = 1.25;
/** Idle spin, radians per second. */
export const GLOBE_SPIN = 0.06;

export interface GlobeRotation {
  yaw: number;
  pitch: number;
}

/** A layout's centre and size, the frame the unfolding is measured in. */
export interface GlobeFrame {
  cx: number;
  cy: number;
  /** Radius the sphere is drawn at, in world units. */
  r: number;
  /** The layout's outline: distance from the centre to its edge, by direction. */
  rim: Float32Array;
  /** Share of notes inside each step from the centre (0) to the outline (1). */
  spread: Float32Array;
}

/** A point on the unit sphere before rotation. */
export interface SpherePoint {
  x: number;
  y: number;
  z: number;
}

/** Read a table at 0..1 of its length, blending the two nearest entries. */
function lerpTable(table: Float32Array, at: number, wrap: boolean): number {
  const k = Math.floor(at);
  const next = wrap ? (k + 1) % table.length : Math.min(k + 1, table.length - 1);
  return table[k] + (table[next] - table[k]) * (at - k);
}

function rimAt(rim: Float32Array, th: number): number {
  const at = ((th / (Math.PI * 2) + 1) % 1) * rim.length;
  return lerpTable(rim, Math.min(at, rim.length - 1e-6), true);
}

function rimOf(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, cx: number, cy: number): Float32Array {
  const raw = new Float32Array(RIM_SECTORS);
  let far = 1;
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const d = Math.hypot(dx, dy);
    const s = Math.floor(((Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1) * RIM_SECTORS) % RIM_SECTORS;
    if (d > raw[s]) raw[s] = d;
    if (d > far) far = d;
  }
  // Widest reading nearby, then averaged: the rim stays smooth and still clears
  // every note, because each sector's reading is inside all its neighbours' windows.
  const around = (table: Float32Array, s: number, pick: (acc: number, v: number) => number, start: number) => {
    let acc = start;
    for (let o = -RIM_REACH; o <= RIM_REACH; o++) acc = pick(acc, table[(s + o + RIM_SECTORS) % RIM_SECTORS]);
    return acc;
  };
  const wide = raw.map((_, s) => Math.max(around(raw, s, Math.max, 0), far * RIM_FLOOR));
  return wide.map((_, s) => around(wide, s, (a, v) => a + v, 0) / (RIM_REACH * 2 + 1));
}

export function frameOf(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): GlobeFrame {
  const spread = new Float32Array(SPREAD_STEPS + 1);
  if (count === 0) {
    spread.forEach((_, k) => (spread[k] = k / SPREAD_STEPS));
    return { cx: 0, cy: 0, r: 1, rim: new Float32Array(RIM_SECTORS).fill(1), spread };
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    if (xs[i] < x0) x0 = xs[i];
    if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i];
    if (ys[i] > y1) y1 = ys[i];
    cx += xs[i] / count;
    cy += ys[i] / count;
  }
  const rim = rimOf(xs, ys, count, cx, cy);
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const e = Math.min(1, Math.hypot(dx, dy) / rimAt(rim, Math.atan2(dy, dx)));
    spread[Math.min(SPREAD_STEPS, Math.floor(e * SPREAD_STEPS) + 1)]++;
  }
  for (let k = 1; k <= SPREAD_STEPS; k++) spread[k] += spread[k - 1];
  for (let k = 0; k <= SPREAD_STEPS; k++) spread[k] /= count;
  return { cx, cy, r: Math.max(1, (x1 - x0) / 2, (y1 - y0) / 2), rim, spread };
}

/** One step of the smoothed frame toward the latest; lands on it once close, as
 *  an endless asymptote would count as a change every frame and defeat the cache. */
export function easeFrame(from: GlobeFrame, to: GlobeFrame): GlobeFrame {
  let d = Math.abs(to.cx - from.cx) + Math.abs(to.cy - from.cy) + Math.abs(to.r - from.r);
  let shift = 0;
  for (let k = 0; k < to.spread.length; k++) shift = Math.max(shift, Math.abs(to.spread[k] - from.spread[k]));
  for (let k = 0; k < to.rim.length; k++) d = Math.max(d, Math.abs(to.rim[k] - from.rim[k]));
  if (d < 0.5 && shift < 0.002) return to;
  const ease = (a: number, b: number) => a + (b - a) * FRAME_EASE;
  return {
    cx: ease(from.cx, to.cx),
    cy: ease(from.cy, to.cy),
    r: ease(from.r, to.r),
    rim: from.rim.map((v, k) => ease(v, to.rim[k])),
    spread: from.spread.map((v, k) => ease(v, to.spread[k])),
  };
}

/** Unfold one flat layout position onto the unit sphere (front pole = layout centre). */
export function toSphere(x: number, y: number, f: GlobeFrame, out: SpherePoint): SpherePoint {
  const dx = x - f.cx;
  const dy = y - f.cy;
  const th = Math.atan2(dy, dx);
  const e = Math.min(1, Math.hypot(dx, dy) / rimAt(f.rim, th));
  const share = lerpTable(f.spread, e * SPREAD_STEPS, false);
  // Equal area: the cap holding a share of the notes covers that share of the sphere.
  const z = 1 - 2 * COVER * share;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  out.x = s * Math.cos(th);
  out.y = s * Math.sin(th);
  out.z = z;
  return out;
}

/** Turn a sphere point by the globe's rotation. z > 0 faces the viewer. */
export function rotate(p: SpherePoint, rot: GlobeRotation, out: SpherePoint): SpherePoint {
  const cy = Math.cos(rot.yaw);
  const sy = Math.sin(rot.yaw);
  const cp = Math.cos(rot.pitch);
  const sp = Math.sin(rot.pitch);
  const x = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  out.x = x;
  out.y = p.y * cp - z1 * sp;
  out.z = p.y * sp + z1 * cp;
  return out;
}

/** The rotation that turns a sphere point to face the viewer. */
export function faceRotation(p: SpherePoint): GlobeRotation {
  const yaw = Math.atan2(-p.x, p.z);
  const z1 = Math.hypot(p.x, p.z);
  return { yaw, pitch: clampPitch(Math.atan2(p.y, z1)) };
}

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

/** Shortest way round from one yaw to another, so a turn never spins the long way. */
export function yawToward(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}

/** 0 at the far side, 1 facing the viewer: drives fade and size. */
export function facing(z: number): number {
  return (z + 1) / 2;
}
