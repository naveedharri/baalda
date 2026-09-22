// The activity strip's window: 1st of last month → end of the month
// HEATMAP_FORWARD_MONTHS ahead, laid out a column per week.
//
// Every case fixes `now` explicitly, because the whole point of the module is
// that the range is derived from a passed-in "today" and never from the clock.

import { describe, expect, it } from "vitest";
import {
  HEATMAP_FORWARD_MONTHS,
  buildHeatmap,
  heatmapRange,
  heatmapRangeLabel,
} from "../heatmapRange";

const DAY_MS = 86_400_000;
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

/** A census array ending today, with `counts` keyed by days-ago. */
function census(length: number, counts: Record<number, number> = {}): number[] {
  const out = new Array(length).fill(0);
  for (const [ago, n] of Object.entries(counts)) out[length - 1 - Number(ago)] = n;
  return out;
}

describe("heatmapRange", () => {
  // Wednesday 16 Sep 2026, 10:00 local.
  const now = new Date(2026, 8, 16, 10, 0, 0).getTime();

  it("starts on the 1st of the previous month and ends at the end of the month three ahead", () => {
    const r = heatmapRange(now);
    expect(HEATMAP_FORWARD_MONTHS).toBe(3);
    expect(r.start).toBe(day(2026, 7, 1)); // 1 Aug 2026
    expect(r.end).toBe(day(2026, 11, 31)); // 31 Dec 2026
    expect(r.today).toBe(day(2026, 8, 16));
    // Aug 31 + Sep 30 + Oct 31 + Nov 30 + Dec 31
    expect(r.days).toBe(153);
  });

  it("opens column 0 on the Sunday of the first week and counts whole weeks", () => {
    const r = heatmapRange(now);
    // 1 Aug 2026 is a Saturday, so the grid's first Sunday is 26 Jul.
    expect(new Date(r.start).getDay()).toBe(6);
    expect(r.gridStart).toBe(day(2026, 6, 26));
    expect(new Date(r.gridStart).getDay()).toBe(0);
    const span = Math.round((r.end - r.gridStart) / DAY_MS);
    expect(r.columns).toBe(Math.floor(span / 7) + 1);
    expect(r.columns).toBe(23);
  });

  it("honours a different forward span and never goes backwards", () => {
    expect(heatmapRange(now, 0).end).toBe(day(2026, 8, 30)); // end of this month
    expect(heatmapRange(now, 1).end).toBe(day(2026, 9, 31));
    // A negative span is clamped to "through the end of this month" rather
    // than producing an end before the start.
    expect(heatmapRange(now, -5).end).toBe(day(2026, 8, 30));
  });

  it("crosses the December/January boundary", () => {
    const r = heatmapRange(new Date(2027, 0, 15, 9, 0, 0).getTime()); // 15 Jan 2027
    expect(r.start).toBe(day(2026, 11, 1)); // 1 Dec 2026
    expect(r.end).toBe(day(2027, 3, 30)); // 30 Apr 2027
    expect(r.days).toBe(31 + 31 + 28 + 31 + 30);
    expect(heatmapRangeLabel(r)).toBe("Dec 2026 – Apr 2027");
  });

  it("covers a leap-year February", () => {
    // 15 Mar 2028 → 1 Feb 2028 through 30 Jun 2028; 2028 is a leap year.
    const r = heatmapRange(new Date(2028, 2, 15, 9, 0, 0).getTime());
    expect(r.start).toBe(day(2028, 1, 1));
    expect(r.end).toBe(day(2028, 5, 30));
    expect(r.days).toBe(29 + 31 + 30 + 31 + 30);

    // And the other side of it: "today" IS the leap day.
    const leap = heatmapRange(new Date(2028, 1, 29, 9, 0, 0).getTime());
    expect(leap.start).toBe(day(2028, 0, 1));
    expect(leap.end).toBe(day(2028, 4, 31));
    expect(leap.today).toBe(day(2028, 1, 29));
  });
});

describe("buildHeatmap", () => {
  const now = new Date(2026, 8, 16, 10, 0, 0).getTime(); // Wed 16 Sep 2026

  it("draws one cell per day in the window, each in its week column and weekday row", () => {
    const g = buildHeatmap(census(371), now);
    expect(g.cells).toHaveLength(g.range.days);
    expect(g.columns).toBe(g.range.columns);
    const seen = new Set(g.cells.map((c) => `${c.col}:${c.row}`));
    expect(seen.size).toBe(g.cells.length);
    expect(g.cells[0]!.date).toBe(day(2026, 7, 1));
    expect(g.cells[0]!.col).toBe(0);
    expect(g.cells[0]!.row).toBe(6); // 1 Aug 2026 is a Saturday
    expect(g.cells[g.cells.length - 1]!.date).toBe(day(2026, 11, 31));
    expect(g.cells[g.cells.length - 1]!.col).toBe(g.columns - 1);
  });

  it("labels each month over the column it opens in", () => {
    const g = buildHeatmap(census(371), now);
    expect(g.months.map((m) => m.label)).toEqual(["Aug", "Sep", "Oct", "Nov", "Dec"]);
    for (const m of g.months) {
      const first = g.cells.find(
        (c) => new Date(c.date).getDate() === 1 && new Date(c.date).getMonth() === monthOf(m.label),
      )!;
      expect(m.col).toBe(first.col);
    }
    // Aug opens column 0; Sep's 1st is a Tuesday in the sixth week.
    expect(g.months[0]!.col).toBe(0);
    expect(g.months[1]!.col).toBe(5);
  });

  it("marks today, maps the census onto past days and heats them against the window's peak", () => {
    const g = buildHeatmap(census(371, { 0: 5, 1: 1, 45: 9 }), now);
    const today = g.cells.find((c) => c.today)!;
    expect(today.date).toBe(day(2026, 8, 16));
    expect(today.row).toBe(3); // Wednesday, Sunday = 0
    expect(today.count).toBe(5);
    expect(today.future).toBe(false);

    const yesterday = g.cells.find((c) => c.date === today.date - DAY_MS)!;
    expect(yesterday.count).toBe(1);

    // 45 days ago = 2 Aug 2026, inside the window and the busiest day in it.
    const busiest = g.cells.find((c) => c.date === day(2026, 7, 2))!;
    expect(busiest.count).toBe(9);
    expect(g.peak).toBe(9);
    expect(busiest.level).toBe(4);
    expect(today.level).toBe(3); // 5/9 sits in the third quarter
    expect(yesterday.level).toBe(1);
  });

  it("gives every day after today an unheated future cell", () => {
    const g = buildHeatmap(census(371, { 0: 5 }), now);
    const future = g.cells.filter((c) => c.future);
    const past = g.cells.filter((c) => !c.future);
    expect(future).toHaveLength(106); // 17 Sep → 31 Dec
    expect(past).toHaveLength(g.cells.length - 106);
    expect(future.every((c) => c.level === 0 && c.count === 0 && !c.today)).toBe(true);
    expect(Math.min(...future.map((c) => c.date))).toBe(day(2026, 8, 17));
    expect(Math.max(...past.map((c) => c.date))).toBe(day(2026, 8, 16));
  });

  it("leaves days the census does not reach at zero rather than reading past its end", () => {
    // A census of 3 days cannot speak for all of last month.
    const g = buildHeatmap(census(3, { 0: 2, 2: 1 }), now);
    expect(g.cells.find((c) => c.date === day(2026, 7, 1))!.count).toBe(0);
    expect(g.cells.find((c) => c.today)!.count).toBe(2);
    expect(g.cells.find((c) => c.date === day(2026, 8, 14))!.count).toBe(1);
    expect(g.peak).toBe(2);
  });

  it("returns an empty grid when there is no per-day census at all", () => {
    const g = buildHeatmap([], now);
    expect(g.columns).toBe(0);
    expect(g.cells).toHaveLength(0);
    expect(g.months).toHaveLength(0);
    // The range is still well formed — it never depended on the data.
    expect(g.range.start).toBe(day(2026, 7, 1));
  });
});

function monthOf(label: string): number {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(
    label,
  );
}
