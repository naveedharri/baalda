import { describe, expect, it } from "vitest";
import { nextHoverMenuMode, type HoverMenuEvent, type HoverMenuMode } from "../hoverMenu";

const run = (events: HoverMenuEvent[], from: HoverMenuMode = "closed") =>
  events.reduce(nextHoverMenuMode, from);

describe("nextHoverMenuMode", () => {
  it("opens on hover and closes once the pointer has been away for the grace period", () => {
    expect(run(["enter"])).toBe("hover");
    expect(run(["enter", "leave-elapsed"])).toBe("closed");
  });

  it("pins a hover preview on click, so leaving no longer closes it", () => {
    expect(run(["enter", "toggle"])).toBe("pinned");
    expect(run(["enter", "toggle", "leave-elapsed"])).toBe("pinned");
  });

  it("pins on a press or focus inside a hover-opened menu", () => {
    expect(run(["enter", "pin", "leave-elapsed"])).toBe("pinned");
    expect(run(["pin"])).toBe("closed");
  });

  it("keeps click as a toggle and hover as a no-op on a pinned menu", () => {
    expect(run(["toggle"])).toBe("pinned");
    expect(run(["toggle", "toggle"])).toBe("closed");
    expect(run(["toggle", "enter"])).toBe("pinned");
  });

  it("dismisses a hover preview but never a pinned menu", () => {
    expect(run(["enter", "dismiss-preview"])).toBe("closed");
    expect(run(["toggle", "dismiss-preview"])).toBe("pinned");
    expect(run(["dismiss-preview"])).toBe("closed");
  });

  it("closes from any state on Escape or an outside press", () => {
    expect(run(["enter", "close"])).toBe("closed");
    expect(run(["toggle", "close"])).toBe("closed");
  });
});
