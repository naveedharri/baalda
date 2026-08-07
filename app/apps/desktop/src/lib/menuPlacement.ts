/**
 * Where to put a floating menu so all of it stays on screen.
 *
 * The file tree's context menu was positioned at the raw anchor point with no
 * viewport check at all, so right-clicking a row near the bottom of the window
 * pushed the tail of the menu below the fold. The items that live at the tail
 * are `Share…`, `Lock for everyone` and `Delete` — i.e. the menu got *shorter*
 * exactly where its most important action is, and a user with a note at the
 * bottom of their sidebar had no way to delete it.
 *
 * Pure on purpose: it takes numbers and returns numbers, so the flip/clamp rules
 * are a table test rather than something you can only check by dragging a window
 * around.
 */

export interface MenuAnchor {
  /** Preferred left edge, in viewport coordinates. */
  x: number;
  /** Preferred TOP edge when the menu opens downward. */
  y: number;
  /**
   * Bottom edge to use when the menu has to open UPWARD instead. Defaults to
   * `y`, which is right for a cursor anchor (the menu grows away from the
   * pointer either way). A button anchor should pass the button's top so the
   * flipped menu sits above the button rather than on top of it.
   */
  flipY?: number;
}

export interface Box {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /**
   * Ceiling for the menu's height. Only ever binds when the menu is taller than
   * the viewport, in which case it scrolls instead of overflowing off-screen.
   */
  maxHeight: number;
}

/** Breathing room kept between the menu and every window edge. */
export const MENU_MARGIN = 8;

function clamp(v: number, lo: number, hi: number): number {
  // `hi < lo` when the menu is bigger than the space available; pinning to `lo`
  // then keeps the top-left corner visible, which is the half that matters.
  return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}

/**
 * Resolve an anchor + a measured menu size into a position that fits.
 *
 * Vertically: open downward if it fits, else flip above the anchor if THAT fits,
 * else clamp into the viewport and cap the height so the rest scrolls.
 * Horizontally the same, mirrored — flip to the left of the anchor.
 */
export function placeMenu(
  anchor: MenuAnchor,
  size: Box,
  viewport: Box,
  margin = MENU_MARGIN,
): Placement {
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(size.height, maxHeight);
  const flipBottom = anchor.flipY ?? anchor.y;

  let top: number;
  if (anchor.y + height <= viewport.height - margin) {
    top = anchor.y;
  } else if (flipBottom - height >= margin) {
    top = flipBottom - height;
  } else {
    top = clamp(anchor.y, margin, viewport.height - margin - height);
  }

  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  let left: number;
  if (anchor.x + width <= viewport.width - margin) {
    left = anchor.x;
  } else if (anchor.x - width >= margin) {
    left = anchor.x - width;
  } else {
    left = clamp(anchor.x, margin, viewport.width - margin - width);
  }

  return { left, top, maxHeight };
}
