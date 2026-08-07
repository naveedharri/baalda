import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./prefs";

// The sidebar width is dragged by the user and restored from localStorage, so
// it arrives from two places that can both hand over nonsense: a pointer that
// left the window, and a stored string from an older build or a smaller screen.
// Whatever comes in, the editor has to survive it.

describe("clampSidebarWidth", () => {
  it("keeps a sensible width untouched", () => {
    expect(clampSidebarWidth(300, 1400)).toBe(300);
  });

  it("holds the floor when dragged shut", () => {
    expect(clampSidebarWidth(0, 1400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(-500, 1400)).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("never narrows past the default — the resizer only widens", () => {
    // Below the design width the tree header's toolbar overflows its last
    // button past the sidebar edge, so there is nothing to gain down there.
    expect(SIDEBAR_WIDTH_MIN).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT - 60, 1400)).toBe(
      SIDEBAR_WIDTH_DEFAULT,
    );
  });

  it("holds the ceiling when dragged past it", () => {
    expect(clampSidebarWidth(9000, 2400)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("always leaves room for the editor on a narrow window", () => {
    // The nominal max is irrelevant if the window can't afford it — dragging
    // the divider to the right edge must not leave a zero-width editor.
    expect(clampSidebarWidth(9000, 700)).toBe(380);
    expect(clampSidebarWidth(9000, 700)).toBeLessThan(700);
  });

  it("still yields a usable sidebar on a window narrower than the minimum", () => {
    // Below this the floor wins: the window is too small to honour both the
    // editor's reserve and the sidebar's floor, and the sidebar keeps its.
    expect(clampSidebarWidth(9000, 400)).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("falls back to the default for a corrupted stored value", () => {
    expect(clampSidebarWidth(Number.NaN, 1400)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(Number("banana"), 1400)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("rounds to whole pixels", () => {
    expect(clampSidebarWidth(300.6, 1400)).toBe(301);
  });

  it("is idempotent — re-clamping a clamped value changes nothing", () => {
    for (const w of [-100, 0, 190, 264, 500, 9000]) {
      const once = clampSidebarWidth(w, 1400);
      expect(clampSidebarWidth(once, 1400)).toBe(once);
    }
  });
});
