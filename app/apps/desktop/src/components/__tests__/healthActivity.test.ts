// The Health page's ACTIVITY strip, rendered.
//
// Like `healthView.test.ts` next to it, this drives React through
// `react-dom/server` — no DOM, no store, no Tauri — and is written in `.ts`
// with `createElement` because `vitest.config.ts` only includes
// `src/**/*.test.ts`.
//
// `heatmapRange.test.ts` owns the date maths; what is pinned here is the
// wiring the CSS depends on: the `--heat-cols` variable the grid is sized by,
// the weekday labels' fixed rows, `data-future` on the days that have not
// happened, and no `data-level` on them.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthActivity } from "../HealthStats";
import type { VaultStats } from "../../lib/health/types";

// Wednesday 16 Sep 2026, 10:00 local → 1 Aug 2026 … 31 Dec 2026.
const now = new Date(2026, 8, 16, 10, 0, 0).getTime();

function activity(days: number[]): VaultStats["activity"] {
  return { modifiedLast7d: 3, modifiedLast30d: 3, weeks: [], days };
}

/** A census ending today, `counts` keyed by days-ago. */
function census(length: number, counts: Record<number, number> = {}): number[] {
  const out = new Array(length).fill(0);
  for (const [ago, n] of Object.entries(counts)) out[length - 1 - Number(ago)] = n;
  return out;
}

const render = (days: number[]) =>
  renderToStaticMarkup(createElement(HealthActivity, { activity: activity(days), now }));

describe("HealthActivity", () => {
  it("sizes the grid with --heat-cols and keeps the weekday labels on rows 3/5/7", () => {
    const html = render(census(371, { 0: 2 }));
    // 26 Jul (the first column's Sunday) → 31 Dec 2026.
    expect(html).toContain("--heat-cols:23");
    expect(html).toMatch(/grid-row:3"[^>]*>Mon</);
    expect(html).toMatch(/grid-row:5"[^>]*>Wed</);
    expect(html).toMatch(/grid-row:7"[^>]*>Fri</);
  });

  it("labels every month in the window, last month first", () => {
    const html = render(census(371));
    const labels = [...html.matchAll(/class="health-heat-month"[^>]*>(\w+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("draws the days after today as future cells with no heat level", () => {
    const html = render(census(371, { 0: 2 }));
    // Only the grid's cells, never the legend's five swatches: a day carries a
    // `title` tooltip, a swatch does not.
    const cells = [...html.matchAll(/<span class="health-heatcell"[^>]*>/g)]
      .map((m) => m[0])
      .filter((c) => c.includes("title="));
    const future = cells.filter((c) => c.includes('data-future=""'));
    expect(future).toHaveLength(106); // 17 Sep → 31 Dec
    expect(future.every((c) => !c.includes("data-level"))).toBe(true);
    // Every drawn day that HAS happened still carries its shade.
    const past = cells.filter((c) => !c.includes('data-future=""'));
    expect(past).toHaveLength(47); // 1 Aug → 16 Sep
    expect(past.every((c) => c.includes("data-level"))).toBe(true);
  });

  it("marks today once, and only today", () => {
    const html = render(census(371, { 0: 2 }));
    expect([...html.matchAll(/data-today=""/g)]).toHaveLength(1);
    expect(html).toContain('title="Today · 2 notes"');
  });

  it("keeps a tooltip on a future day", () => {
    const html = render(census(371));
    expect(html).toContain('title="Thu 31 Dec · 0 notes"');
  });

  it("names the window and the active days for a screen reader", () => {
    const html = render(census(371, { 0: 2, 3: 1 }));
    expect(html).toContain("Notes edited per day, Aug – Dec 2026: 2 active days");
  });

  it("says so when there is no per-day census", () => {
    const html = render([]);
    expect(html).toContain("No per-day activity is available for this vault.");
    expect(html).not.toContain("health-heatmap");
  });
});
