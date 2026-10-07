import { describe, expect, it } from "vitest";
import { parseAppearance } from "./schema.js";

describe("parseAppearance", () => {
  it("accepts an empty object and every valid key", () => {
    expect(parseAppearance({})).toEqual({ ok: true, settings: {} });
    const full = {
      theme: "dark",
      autoColors: false,
      contentWidth: 90,
      textSize: 16,
      lineNumbers: true,
      properties: "hidden",
    };
    expect(parseAppearance(full)).toEqual({ ok: true, settings: full });
    expect(parseAppearance({ contentWidth: "full" })).toEqual({ ok: true, settings: { contentWidth: "full" } });
  });

  it("accepts range edges", () => {
    for (const s of [{ contentWidth: 60 }, { contentWidth: 120 }, { textSize: 12 }, { textSize: 24 }]) {
      expect(parseAppearance(s).ok).toBe(true);
    }
  });

  it("refuses non-objects", () => {
    for (const v of [null, undefined, "x", 3, [], true]) {
      expect(parseAppearance(v)).toMatchObject({ ok: false, error: "invalid_appearance" });
    }
  });

  it("refuses unknown keys", () => {
    expect(parseAppearance({ font: "serif" })).toEqual({ ok: false, error: "invalid_appearance", key: "font" });
    expect(parseAppearance({ theme: "dark", __proto__x: 1 })).toMatchObject({ ok: false });
  });

  it("refuses bad values", () => {
    const bad = [
      { theme: "blue" },
      { theme: 1 },
      { autoColors: "yes" },
      { contentWidth: 59 },
      { contentWidth: 121 },
      { contentWidth: 72.5 },
      { contentWidth: 900 },
      { contentWidth: "90" },
      { contentWidth: "wide" },
      { contentWidth: Number.NaN },
      { textSize: 11 },
      { textSize: 25 },
      { textSize: "16" },
      { lineNumbers: 1 },
      { properties: "shown" },
      { theme: null },
    ];
    for (const s of bad) expect(parseAppearance(s)).toMatchObject({ ok: false, error: "invalid_appearance" });
  });
});
