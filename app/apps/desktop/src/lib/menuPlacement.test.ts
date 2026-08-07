import { describe, expect, it } from "vitest";
import { placeMenu } from "./menuPlacement";

const VIEWPORT = { width: 1200, height: 800 };
const MENU = { width: 200, height: 300 };

describe("placeMenu", () => {
  it("opens downward from the anchor when there is room", () => {
    const p = placeMenu({ x: 100, y: 120 }, MENU, VIEWPORT);
    expect(p).toMatchObject({ left: 100, top: 120 });
  });

  it("flips above the anchor rather than running off the bottom", () => {
    // 700 + 300 = 1000, past the 800px viewport. The regression this guards:
    // the tail of the menu (Share…, Lock, Delete) fell below the fold, so a note
    // at the bottom of the sidebar had no reachable Delete.
    const p = placeMenu({ x: 100, y: 700 }, MENU, VIEWPORT);
    expect(p.top).toBe(400);
    expect(p.top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("flips above the BUTTON when the anchor supplies flipY", () => {
    // A ⋯ button whose bottom is at 700: opening upward has to clear the button
    // itself, not just the point below it.
    const p = placeMenu({ x: 100, y: 704, flipY: 676 }, MENU, VIEWPORT);
    expect(p.top).toBe(376);
  });

  it("clamps into view when neither direction fits", () => {
    const tall = { width: 200, height: 700 };
    // Slid up to the lowest position that still fits, rather than pinned to the
    // top — the menu stays as close to where it was asked for as it can.
    const p = placeMenu({ x: 100, y: 600 }, tall, { width: 1200, height: 760 });
    expect(p.top).toBe(52);
    expect(p.top + tall.height).toBeLessThanOrEqual(760 - 8);
  });

  it("caps the height of a menu taller than the window so it can scroll", () => {
    const p = placeMenu({ x: 10, y: 10 }, { width: 200, height: 2000 }, VIEWPORT);
    expect(p.maxHeight).toBe(784);
    expect(p.top).toBe(8);
  });

  it("flips to the left of the anchor rather than off the right edge", () => {
    const p = placeMenu({ x: 1150, y: 100 }, MENU, VIEWPORT);
    expect(p.left).toBe(950);
  });

  it("keeps the top-left corner visible when the menu is wider than the window", () => {
    const p = placeMenu({ x: 40, y: 10 }, { width: 400, height: 100 }, { width: 300, height: 800 });
    expect(p.left).toBe(8);
  });
});
