// Zoom arithmetic shared by the image lightbox and the image file preview's
// Cmd+= / Cmd+- / Cmd+0 keys. Pure so it is tested without a DOM.

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 10;
/** One keyboard step (Cmd+= / Cmd+-). */
export const ZOOM_STEP = 1.25;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || Number.isNaN(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function zoomIn(z: number): number {
  return clampZoom(z * ZOOM_STEP);
}

export function zoomOut(z: number): number {
  return clampZoom(z / ZOOM_STEP);
}

/** Wheel / trackpad-pinch delta → next zoom. A pinch arrives as a ctrl+wheel
 *  with small deltas, a mouse wheel with ~100px ones; the exponential keeps
 *  both proportional and symmetric (in then out returns to the start). */
export function zoomFromWheel(z: number, deltaY: number): number {
  return clampZoom(z * Math.exp(-deltaY * 0.002));
}

export interface View {
  zoom: number;
  x: number;
  y: number;
}

/**
 * Zoom about a point (the cursor), keeping the image pixel under it fixed.
 * `px`/`py` are measured from the transform origin (the image's centre), in
 * screen px; `x`/`y` are the current translation.
 */
export function zoomAt(view: View, nextZoom: number, px: number, py: number): View {
  const zoom = clampZoom(nextZoom);
  const k = zoom / view.zoom;
  return { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** Which zoom action a key event asks for, if any (Cmd on macOS, Ctrl elsewhere). */
export function zoomKeyAction(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}): "in" | "out" | "reset" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}
