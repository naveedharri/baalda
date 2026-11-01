// Globe view (redesign). The layout itself stays flat: the same physics, the
// same folder regions, the same background pre-layout. Only drawing wraps it
// onto a sphere, so nothing here touches the simulation.
//
// The flat map is unfolded onto the sphere with an inverse azimuthal
// equal-area projection centred on the layout's middle, so regions keep their
// relative size and neighbours stay neighbours. The outermost notes reach
// ~3/4 of the way round, leaving a quiet pole at the back instead of a seam.

/** Below this many visible notes the graph draws flat. Kept low (was 150) so a
 *  small vault still reads as a round globe instead of silently going flat. */
export const GLOBE_MIN_NODES = 8;
/** How far round the sphere the edge of the layout reaches (2 = all the way). */
const WRAP = 1.7;
/** Tilt limit so the globe can never flip upside down while dragging. */
const PITCH_LIMIT = 1.25;
/** Idle spin, radians per second. */
export const GLOBE_SPIN = 0.06;

export interface GlobeRotation {
  yaw: number;
  pitch: number;
}

/** A layout's centre and radius, the frame the unfolding is measured in. */
export interface GlobeFrame {
  cx: number;
  cy: number;
  r: number;
}

/** A point on the unit sphere before rotation. */
export interface SpherePoint {
  x: number;
  y: number;
  z: number;
}

export function frameOf(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): GlobeFrame {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    if (xs[i] < x0) x0 = xs[i];
    if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i];
    if (ys[i] > y1) y1 = ys[i];
  }
  if (count === 0) return { cx: 0, cy: 0, r: 1 };
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.max(1, (x1 - x0) / 2, (y1 - y0) / 2) };
}

/** Unfold one flat layout position onto the unit sphere (front pole = layout centre). */
export function toSphere(x: number, y: number, f: GlobeFrame, out: SpherePoint): SpherePoint {
  const dx = (x - f.cx) / f.r;
  const dy = (y - f.cy) / f.r;
  const rho = Math.min(2, Math.hypot(dx, dy) * WRAP);
  const c = 2 * Math.asin(rho / 2);
  const th = Math.atan2(dy, dx);
  const s = Math.sin(c);
  out.x = s * Math.cos(th);
  out.y = s * Math.sin(th);
  out.z = Math.cos(c);
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
