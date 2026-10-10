import { describe, expect, it } from "vitest";
import { createFetchThrottle, isForcedMenuOpen, MENU_FETCH_MIN_INTERVAL_MS } from "../menuFetchThrottle";

describe("createFetchThrottle", () => {
  it("lets one fetch per key through each minute", () => {
    const t = createFetchThrottle();
    expect(t.shouldFetch("u1", 0)).toBe(true);
    expect(t.shouldFetch("u1", 1_000)).toBe(false);
    expect(t.shouldFetch("u1", MENU_FETCH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(t.shouldFetch("u1", MENU_FETCH_MIN_INTERVAL_MS)).toBe(true);
  });

  it("always fetches for another account or server, when forced, or after a reset", () => {
    const t = createFetchThrottle();
    t.shouldFetch("u1", 0);
    expect(t.shouldFetch("u2", 10)).toBe(true);
    expect(t.shouldFetch("u2", 20, true)).toBe(true);
    // A forced fetch restarts the minute.
    expect(t.shouldFetch("u2", 30)).toBe(false);
    t.reset();
    expect(t.shouldFetch("u2", 40)).toBe(true);
  });
});

describe("isForcedMenuOpen", () => {
  it("forces only a click that opens the menu from closed", () => {
    expect(isForcedMenuOpen("closed", "pinned")).toBe(true);
    expect(isForcedMenuOpen("hover", "pinned")).toBe(false);
    expect(isForcedMenuOpen("closed", "hover")).toBe(false);
    expect(isForcedMenuOpen("pinned", "closed")).toBe(false);
  });
});
