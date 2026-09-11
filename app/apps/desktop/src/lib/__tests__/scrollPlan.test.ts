import { describe, expect, it } from "vitest";
import { planDetailScroll, type DetailScrollInput } from "../scrollPlan";

/** A 600px-tall container over 2000px of content, scrolled to the top. */
const base: DetailScrollInput = {
  paneTop: 0,
  paneHeight: 300,
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 2000,
  margin: 12,
};

const plan = (over: Partial<DetailScrollInput>) => planDetailScroll({ ...base, ...over });

describe("planDetailScroll — already visible", () => {
  it("does nothing when the pane sits wholly inside the viewport", () => {
    expect(plan({ paneTop: 100, paneHeight: 200 })).toBeNull();
  });

  it("does nothing when the pane exactly fills the viewport", () => {
    expect(plan({ paneTop: 0, paneHeight: 600 })).toBeNull();
  });

  it("does nothing when the pane sits flush against both edges mid-scroll", () => {
    expect(plan({ scrollTop: 400, paneTop: 400, paneHeight: 600 })).toBeNull();
  });
});

describe("planDetailScroll — below the fold", () => {
  it("scrolls the pane to the top, less the margin", () => {
    expect(plan({ paneTop: 900, paneHeight: 400 })).toBe(888);
  });

  it("honours a zero margin", () => {
    expect(plan({ paneTop: 900, paneHeight: 400, margin: 0 })).toBe(900);
  });

  it("moves for a pane that is only partly cut off at the bottom", () => {
    // Top is visible, bottom is not — the controls are what's missing.
    expect(plan({ paneTop: 500, paneHeight: 400 })).toBe(488);
  });
});

describe("planDetailScroll — above the viewport", () => {
  it("scrolls back up to reach a pane that has been scrolled past", () => {
    expect(plan({ scrollTop: 1000, paneTop: 300, paneHeight: 200 })).toBe(288);
  });
});

describe("planDetailScroll — clamping", () => {
  it("never asks for a scroll past the end of the content", () => {
    // maxScroll = 2000 - 600 = 1400; the pane starts at 1900.
    expect(plan({ paneTop: 1900, paneHeight: 100 })).toBe(1400);
  });

  it("never asks for a negative scroll", () => {
    expect(plan({ scrollTop: 300, paneTop: 5, paneHeight: 900, margin: 40 })).toBe(0);
  });

  it("returns null when nothing scrolls at all", () => {
    expect(plan({ paneTop: 0, paneHeight: 900, clientHeight: 600, scrollHeight: 600 })).toBeNull();
  });
});

describe("planDetailScroll — sub-pixel moves", () => {
  // A pane taller than the viewport can never be "fully visible", so these two
  // reach the sub-pixel guard rather than short-circuiting on visibility.
  it("ignores a move under one pixel rather than animating a jitter", () => {
    expect(plan({ scrollTop: 888.4, paneTop: 900, paneHeight: 700 })).toBeNull();
  });

  it("takes a move of a full pixel", () => {
    expect(plan({ scrollTop: 887, paneTop: 900, paneHeight: 700 })).toBe(888);
  });
});

describe("planDetailScroll — defaults", () => {
  it("treats a missing margin as zero", () => {
    const { margin: _margin, ...noMargin } = base;
    expect(planDetailScroll({ ...noMargin, paneTop: 900, paneHeight: 400 })).toBe(900);
  });
});

describe("planDetailScroll — the mode control must land on screen", () => {
  it("scrolls past the pane top on a short window, to clear the control", () => {
    // 300px window; the pane starts at 900 and its tri-state ends at 1400.
    // Pane-top alone would scroll to 888 and leave the buttons 212px below the
    // fold — the click was about those buttons.
    expect(
      plan({
        clientHeight: 300,
        paneTop: 900,
        paneHeight: 700,
        anchorBottom: 1400,
      }),
    ).toBe(1112); // 1400 + 12 - 300
  });

  it("still prefers the pane top when the window is tall enough for both", () => {
    expect(
      plan({ paneTop: 900, paneHeight: 400, anchorBottom: 1150 }),
    ).toBe(888); // pane top wins: 1150 + 12 - 600 = 562 is lower
  });

  it("matches the anchor-free plan when the anchor is near the pane top", () => {
    const withAnchor = plan({ paneTop: 900, paneHeight: 400, anchorBottom: 1000 });
    const without = plan({ paneTop: 900, paneHeight: 400 });
    expect(withAnchor).toBe(without);
  });

  it("clamps the anchor-driven target to the end of the content", () => {
    // required = 1995 + 12 - 300 = 1707, past maxScroll = 2000 - 300 = 1700.
    expect(
      plan({ clientHeight: 300, paneTop: 1600, paneHeight: 400, anchorBottom: 1995 }),
    ).toBe(1700);
  });

  it("does nothing when the pane AND the control are already fully visible", () => {
    expect(plan({ paneTop: 100, paneHeight: 200, anchorBottom: 280 })).toBeNull();
  });

  it("moves when the pane top is visible but the control is cut off", () => {
    // The pane is taller than the window, so `paneVisible` is false anyway —
    // this is the ordinary case on a short window and it must not be skipped.
    expect(plan({ paneTop: 100, paneHeight: 900, anchorBottom: 800 })).toBe(212);
  });

  it("scrolls back up for a control above the viewport", () => {
    expect(
      plan({ scrollTop: 1000, paneTop: 300, paneHeight: 900, anchorBottom: 700 }),
    ).toBe(288);
  });
});
