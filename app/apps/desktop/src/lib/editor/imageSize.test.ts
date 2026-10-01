import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_WIDTH,
  MIN_IMAGE_WIDTH,
  imageAltRange,
  normalizeImageWidth,
  parseImageAlt,
  planImageWidthChange,
} from "./imageSize";

// #244: `![alt|400](src)` — the width lives in the markdown, and a resize
// rewrites only the digits of that segment (or inserts `|N` at the end of the
// alt). Nothing else in the note may change.

/** Apply the planned change to `doc` the way the editor transaction would. */
function resize(doc: string, imageFrom: number, width: number): string {
  const alt = imageAltRange(doc.slice(imageFrom), imageFrom);
  if (!alt) return doc;
  const change = planImageWidthChange(alt, width);
  if (!change) return doc;
  return EditorState.create({ doc }).update({ changes: change }).state.doc.toString();
}

describe("parseImageAlt", () => {
  it("splits the Obsidian size segment off the alt text", () => {
    expect(parseImageAlt("Diagram|400")).toEqual({
      alt: "Diagram",
      width: 400,
      digits: { from: 8, to: 11 },
    });
    expect(parseImageAlt("Diagram|400x300").width).toBe(400);
    expect(parseImageAlt("|250")).toMatchObject({ alt: "", width: 250 });
  });

  it("leaves alt text without a size alone", () => {
    expect(parseImageAlt("A | B")).toEqual({ alt: "A | B", width: null, digits: null });
    expect(parseImageAlt("plain")).toEqual({ alt: "plain", width: null, digits: null });
    expect(parseImageAlt("")).toEqual({ alt: "", width: null, digits: null });
  });
});

describe("planImageWidthChange", () => {
  it("inserts a width at the end of the alt when there is none", () => {
    const doc = "Before ![shot](a.png) after";
    expect(resize(doc, 7, 320)).toBe("Before ![shot|320](a.png) after");
  });

  it("replaces only the width digits when one is present", () => {
    const doc = "x ![shot|400x300](a.png) y";
    expect(resize(doc, 2, 251.6)).toBe("x ![shot|252x300](a.png) y");
  });

  it("writes nothing when the width did not change", () => {
    const alt = imageAltRange("![s|400](a.png)", 0)!;
    expect(planImageWidthChange(alt, 400.2)).toBeNull();
  });

  it("refuses to write when the position no longer starts an image", () => {
    expect(imageAltRange("not an image", 0)).toBeNull();
    expect(imageAltRange("![unclosed", 0)).toBeNull();
    expect(resize("hello ![s](a.png)", 0, 300)).toBe("hello ![s](a.png)");
  });

  it("clamps to a sane range", () => {
    expect(normalizeImageWidth(3)).toBe(MIN_IMAGE_WIDTH);
    expect(normalizeImageWidth(1e9)).toBe(MAX_IMAGE_WIDTH);
    expect(normalizeImageWidth(Number.NaN)).toBe(MIN_IMAGE_WIDTH);
  });

  it("touches only the dragged image on a line with two", () => {
    const doc = "![a](1.png) ![b|100](2.png)";
    expect(resize(doc, 12, 150)).toBe("![a](1.png) ![b|150](2.png)");
  });
});
