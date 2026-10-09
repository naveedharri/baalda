// The vault cards' ⋯ menu opens BELOW its button and to the RIGHT of the
// button's left edge, so it never covers the card; it flips left only when the
// right side would overflow. Rows keep the right-aligned menu.
import { describe, expect, it } from "vitest";
import { rowMenuAnchorX } from "../RowActionsMenu";
import { placeMenu } from "../../lib/menuPlacement";

const trigger = { left: 300, right: 322, top: 100, bottom: 122 };
const menu = { width: 180, height: 140 };
const place = (t: typeof trigger, align: "start" | "end", vw = 1200) =>
  placeMenu(
    { x: rowMenuAnchorX(t, menu.width, align), y: t.bottom + 6, flipY: t.top - 6 },
    menu,
    { width: vw, height: 800 },
  );

describe("RowActionsMenu placement", () => {
  it("a card menu opens below the button, growing right from its left edge", () => {
    const p = place(trigger, "start");
    expect(p.left).toBe(trigger.left);
    expect(p.top).toBe(trigger.bottom + 6);
  });

  it("a card menu flips left only when it would overflow on the right", () => {
    const nearEdge = { ...trigger, left: 1100, right: 1122 };
    const p = place(nearEdge, "start");
    expect(p.left + menu.width).toBeLessThanOrEqual(1200 - 8);
    expect(p.left).toBe(nearEdge.left - menu.width);
  });

  it("a row menu stays right-aligned under its button", () => {
    expect(place(trigger, "end").left).toBe(trigger.right - menu.width);
  });
});
