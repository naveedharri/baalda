// The Content width control's arithmetic: slider ↔ preference, the token the
// editor reads, and the miniature's geometry. All pure — the DOM measuring that
// feeds `computePreviewColumn` (the pane's width, one `ch` in the editor font)
// lives in `components/ContentWidthPreview.tsx`.
import { describe, expect, it } from "vitest";
import {
  computePreviewColumn,
  EDITOR_MEASURE_SLIDER_MAX,
  EDITOR_MEASURE_SLIDER_MIN,
  EDITOR_MEASURE_STEP,
  editorMeasureStyle,
  measureLabel,
  measureToSlider,
  sliderToMeasure,
} from "../editorMeasure";
import { EDITOR_MEASURE_DEFAULT, EDITOR_MEASURE_MAX, EDITOR_MEASURE_MIN } from "../prefs";

describe("slider ↔ measure", () => {
  it("maps the far-right stop, and only it, to full width", () => {
    expect(sliderToMeasure(EDITOR_MEASURE_SLIDER_MAX)).toBe("full");
    expect(sliderToMeasure(EDITOR_MEASURE_SLIDER_MAX - EDITOR_MEASURE_STEP)).toBe(
      EDITOR_MEASURE_MAX,
    );
    expect(measureToSlider("full")).toBe(EDITOR_MEASURE_SLIDER_MAX);
  });

  it("round-trips every real stop", () => {
    for (let ch = EDITOR_MEASURE_MIN; ch <= EDITOR_MEASURE_MAX; ch += EDITOR_MEASURE_STEP) {
      expect(sliderToMeasure(measureToSlider(ch))).toBe(ch);
    }
  });

  it("clamps and snaps anything else", () => {
    expect(sliderToMeasure(EDITOR_MEASURE_SLIDER_MIN - 40)).toBe(EDITOR_MEASURE_MIN);
    expect(sliderToMeasure(87)).toBe(88);
    expect(sliderToMeasure(Number.NaN)).toBe(EDITOR_MEASURE_DEFAULT);
    // "As wide as possible" is full width, and its opposite is the narrowest
    // measure — neither is a corrupted reading, so neither is the default.
    expect(sliderToMeasure(Number.POSITIVE_INFINITY)).toBe("full");
    expect(sliderToMeasure(Number.NEGATIVE_INFINITY)).toBe(EDITOR_MEASURE_MIN);
    // A stored measure from a future build with a wider range still lands on
    // the slider rather than off the end of it.
    expect(measureToSlider(400)).toBe(EDITOR_MEASURE_MAX);
  });

  it("reads out characters, or the word", () => {
    expect(measureLabel(88)).toBe("88 characters");
    expect(measureLabel("full")).toBe("Full width");
  });
});

describe("the token the editor follows", () => {
  it("carries the measure in ch, and full width as a percentage", () => {
    expect(editorMeasureStyle(72)["--editor-measure"]).toBe("72ch");
    // 100% makes `(100% - var(--editor-measure)) / 2` zero, so `--editor-pad-x`
    // falls back to the gutter — which is what "full" means.
    expect(editorMeasureStyle("full")["--editor-measure"]).toBe("100%");
  });
});

describe("preview geometry", () => {
  const gutterPx = 64;

  it("scales the real column down to the miniature", () => {
    // 960px pane, 88ch ≈ 800px: the measure fits, so the column is the measure.
    const { columnPx, insetPx } = computePreviewColumn({
      paneWidth: 960,
      gutterPx,
      measurePx: 800,
      previewWidth: 480,
    });
    expect(columnPx).toBeCloseTo(400);
    expect(insetPx).toBeCloseTo(40);
  });

  it("lets the gutters win when the window is narrower than the measure", () => {
    const { columnPx, insetPx } = computePreviewColumn({
      paneWidth: 600,
      gutterPx,
      measurePx: 900,
      previewWidth: 600,
    });
    // 600 − 2×64 = 472, not the 900 that was asked for.
    expect(columnPx).toBeCloseTo(472);
    expect(insetPx).toBeCloseTo(64);
  });

  it("draws full width as the pane less its gutters", () => {
    const full = computePreviewColumn({
      paneWidth: 1000,
      gutterPx,
      measurePx: "full",
      previewWidth: 500,
    });
    expect(full.columnPx).toBeCloseTo(436); // (1000 − 128) / 2
    // Wider than any real measure in the same window.
    const wide = computePreviewColumn({
      paneWidth: 1000,
      gutterPx,
      measurePx: 700,
      previewWidth: 500,
    });
    expect(wide.columnPx).toBeLessThan(full.columnPx);
  });

  it("always fills the miniature exactly", () => {
    for (const measurePx of [400, 800, 2000, "full" as const]) {
      const { columnPx, insetPx } = computePreviewColumn({
        paneWidth: 960,
        gutterPx,
        measurePx,
        previewWidth: 480,
      });
      expect(columnPx + 2 * insetPx).toBeCloseTo(480);
      expect(columnPx).toBeGreaterThan(0);
    }
  });

  it("survives a pane it cannot measure, and one too narrow for its gutters", () => {
    // No editor mounted: draw at 1:1 instead of dividing by zero.
    const unmounted = computePreviewColumn({
      paneWidth: 0,
      gutterPx,
      measurePx: "full",
      previewWidth: 400,
    });
    expect(unmounted.columnPx).toBeCloseTo(272);
    const squeezed = computePreviewColumn({
      paneWidth: 80,
      gutterPx,
      measurePx: 400,
      previewWidth: 400,
    });
    expect(squeezed.columnPx).toBe(0);
    expect(squeezed.insetPx).toBe(200);
  });
});
