// @vitest-environment jsdom
//
// The DOM half of `scrollPlan`: finding the container that actually scrolls, and
// converting a border-box rect into the container's scroll coordinates. That
// conversion is the risky part — `planDetailScroll` is the half the node suite
// already pins — and getting it wrong scrolls to a plausible-looking wrong place
// rather than failing loudly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollPaneIntoContainer, scrollableAncestor } from "../scrollPlan";

interface BoxSpec {
  overflowY?: string;
  scrollHeight?: number;
  clientHeight?: number;
  clientTop?: number;
  scrollTop?: number;
  /** Viewport-relative top of the border box. */
  rectTop?: number;
  height?: number;
}

/** jsdom lays nothing out, so every measurement is stubbed explicitly. */
function box(el: HTMLElement, spec: BoxSpec): HTMLElement {
  if (spec.overflowY) el.style.overflowY = spec.overflowY;
  for (const [prop, value] of [
    ["scrollHeight", spec.scrollHeight],
    ["clientHeight", spec.clientHeight],
    ["clientTop", spec.clientTop],
  ] as const) {
    if (value !== undefined) {
      Object.defineProperty(el, prop, { value, configurable: true });
    }
  }
  if (spec.scrollTop !== undefined) el.scrollTop = spec.scrollTop;
  el.getBoundingClientRect = () =>
    ({ top: spec.rectTop ?? 0, height: spec.height ?? 0, bottom: (spec.rectTop ?? 0) + (spec.height ?? 0) }) as DOMRect;
  return el;
}

function el(tag = "div"): HTMLElement {
  const node = document.createElement(tag);
  document.body.appendChild(node);
  return node;
}

let scrolled: Array<{ top?: number; behavior?: ScrollBehavior }>;

beforeEach(() => {
  scrolled = [];
  // jsdom has no matchMedia; the helper treats a missing one as "motion is fine".
  vi.stubGlobal("matchMedia", undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function scrollSpy(container: HTMLElement): void {
  container.scrollTo = ((opts: ScrollToOptions) => {
    scrolled.push({ top: opts.top, behavior: opts.behavior });
  }) as HTMLElement["scrollTo"];
}

describe("scrollableAncestor", () => {
  it("finds the nearest ancestor that both scrolls and overflows", () => {
    const outer = box(el(), { overflowY: "auto", scrollHeight: 2000, clientHeight: 600 });
    const middle = outer.appendChild(box(document.createElement("div"), {}));
    const pane = middle.appendChild(document.createElement("div"));
    expect(scrollableAncestor(pane)).toBe(outer);
  });

  it("prefers the nearest one when two ancestors scroll", () => {
    const outer = box(el(), { overflowY: "scroll", scrollHeight: 2000, clientHeight: 600 });
    const inner = outer.appendChild(
      box(document.createElement("div"), { overflowY: "auto", scrollHeight: 900, clientHeight: 300 }),
    );
    const pane = inner.appendChild(document.createElement("div"));
    expect(scrollableAncestor(pane)).toBe(inner);
  });

  it("skips an auto ancestor whose content fits — nothing there can scroll", () => {
    const outer = box(el(), { overflowY: "auto", scrollHeight: 2000, clientHeight: 600 });
    const snug = outer.appendChild(
      box(document.createElement("div"), { overflowY: "auto", scrollHeight: 300, clientHeight: 300 }),
    );
    const pane = snug.appendChild(document.createElement("div"));
    expect(scrollableAncestor(pane)).toBe(outer);
  });

  it("ignores overflow values that do not scroll", () => {
    const hidden = box(el(), { overflowY: "hidden", scrollHeight: 2000, clientHeight: 600 });
    const pane = hidden.appendChild(document.createElement("div"));
    expect(scrollableAncestor(pane)).toBeNull();
  });

  it("returns null for a null element and never inspects the element itself", () => {
    expect(scrollableAncestor(null)).toBeNull();
    // A scrolling pane is not its own container — the walk starts at parentElement.
    const pane = box(el(), { overflowY: "auto", scrollHeight: 2000, clientHeight: 600 });
    expect(scrollableAncestor(pane)).toBeNull();
  });
});

describe("scrollPaneIntoContainer — coordinate conversion", () => {
  /**
   * A container whose border box starts 40px down the viewport, with a 5px top
   * border, already scrolled 200px. A pane whose border box reads 300 is really
   * at 300 - 40 - 5 + 200 = 455 in the container's scroll coordinates.
   */
  function scene(paneRectTop: number, paneHeight = 900) {
    const container = box(el(), {
      overflowY: "auto",
      scrollHeight: 3000,
      clientHeight: 600,
      clientTop: 5,
      scrollTop: 200,
      rectTop: 40,
      height: 600,
    });
    scrollSpy(container);
    const pane = container.appendChild(
      box(document.createElement("div"), { rectTop: paneRectTop, height: paneHeight }),
    );
    return { container, pane };
  }

  it("converts the border box to scroll coordinates before planning", () => {
    const { pane } = scene(300);
    scrollPaneIntoContainer(pane);
    // paneTop 455, margin 12 → 443.
    expect(scrolled).toEqual([{ top: 443, behavior: "smooth" }]);
  });

  it("honours the anchor, measured in the same space", () => {
    const { container, pane } = scene(300, 900);
    const anchor = pane.appendChild(
      box(document.createElement("div"), { rectTop: 900, height: 110 }),
    );
    expect(container.contains(anchor)).toBe(true);
    scrollPaneIntoContainer(pane, anchor);
    // anchorBottom = 1010 - 40 - 5 + 200 = 1165; 1165 + 12 - 600 = 577 > 443.
    expect(scrolled).toEqual([{ top: 577, behavior: "smooth" }]);
  });

  it("does not scroll when the pane is already fully inside the container", () => {
    // paneTop 455, height 100 → 455..555, viewport 200..800.
    const { pane } = scene(300, 100);
    scrollPaneIntoContainer(pane);
    expect(scrolled).toEqual([]);
  });

  it("respects a reduced-motion preference", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { pane } = scene(300);
    scrollPaneIntoContainer(pane);
    expect(scrolled).toEqual([{ top: 443, behavior: "auto" }]);
  });

  it("uses a custom margin", () => {
    const { pane } = scene(300);
    scrollPaneIntoContainer(pane, null, 0);
    expect(scrolled).toEqual([{ top: 455, behavior: "smooth" }]);
  });
});

describe("scrollPaneIntoContainer — early returns", () => {
  it("does nothing for a null pane (the ref after unmount)", () => {
    expect(() => scrollPaneIntoContainer(null)).not.toThrow();
    expect(scrolled).toEqual([]);
  });

  it("does nothing when no ancestor scrolls", () => {
    const wrapper = box(el(), { overflowY: "visible", scrollHeight: 600, clientHeight: 600 });
    scrollSpy(wrapper);
    const pane = wrapper.appendChild(
      box(document.createElement("div"), { rectTop: 900, height: 900 }),
    );
    scrollPaneIntoContainer(pane);
    expect(scrolled).toEqual([]);
  });

  it("does nothing for a detached pane", () => {
    const pane = box(document.createElement("div"), { rectTop: 900, height: 900 });
    expect(() => scrollPaneIntoContainer(pane)).not.toThrow();
    expect(scrolled).toEqual([]);
  });
});
