// The Health page's activity heat-map: which calendar days the strip draws,
// and where each one lands in the grid.
//
// Pure and dependency-free (no React, no store, no Tauri) like `format.ts`
// beside it, so the placement can be pinned in the plain Node vitest
// environment without a DOM. `now` is always passed in — never read from the
// clock here — which is what lets a test fix a January boundary or a leap day.
//
// Why not GitHub's trailing twelve months (what the strip drew before): a
// young vault renders 52 columns of grey with two coloured cells in
// the far right, and the one thing a person looks at the strip for — what
// happened lately, and what is coming — is a thumbnail in the corner. This
// range starts at the FIRST DAY OF LAST MONTH and runs forward through the end
// of the month `HEATMAP_FORWARD_MONTHS` ahead, so the window is always about
// five months: one of history for context, the current one in the middle, and
// an empty forward stretch the vault grows into.

import { activityLevel } from "./format";

/**
 * How many whole months past the current one the strip reaches.
 *
 * Three, which with last month and this one makes a five-month window: wide
 * enough that a month of daily edits reads as a block rather than a smear,
 * narrow enough that each column is still a comfortable tap target at the
 * panel's width (~22 columns, against the old view's 53).
 */
export const HEATMAP_FORWARD_MONTHS = 3;

const DAY_MS = 86_400_000;

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface HeatmapRange {
  /** Local midnight of the first day drawn: the 1st of the previous month. */
  start: number;
  /** Local midnight of the last day drawn: the last day of the month
   *  `forwardMonths` past the current one. */
  end: number;
  /** Local midnight of the Sunday that opens column 0. On or before `start`,
   *  because a column is a week and the 1st is rarely a Sunday. */
  gridStart: number;
  /** Local midnight of today, the day `data-today` marks. */
  today: number;
  /** Days from `start` to `end` inclusive — how many cells the grid holds. */
  days: number;
  /** Week columns, counted from `gridStart`. */
  columns: number;
}

export interface HeatmapCell {
  /** 0-based column, oldest week first. */
  col: number;
  /** 0 = Sunday … 6 = Saturday, like GitHub's rows. */
  row: number;
  /** Local midnight of the day, ms. */
  date: number;
  count: number;
  /** 0..4 shade. Always 0 for a future day — see `future`. */
  level: 0 | 1 | 2 | 3 | 4;
  today: boolean;
  /** A day that has not happened yet: drawn as an empty outline, never heated,
   *  and never counted towards the peak that scales everything else. */
  future: boolean;
}

export interface Heatmap {
  cells: HeatmapCell[];
  columns: number;
  /** Month labels: which column a month starts in ("Sep" over column 3). */
  months: Array<{ col: number; label: string }>;
  /** The busiest day in the window; 0 when nothing landed in it. */
  peak: number;
  range: HeatmapRange;
}

/** Local midnight of the day `ms` falls in. */
function midnight(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Whole days from `a` to `b`, both local midnights. Rounded rather than
 *  floored because a DST change makes one of these days 23 or 25 hours long. */
function daysBetween(a: number, b: number): number {
  return Math.round((b - a) / DAY_MS);
}

/**
 * The window the strip covers for a given "today": 1st of last month through
 * the end of the month `forwardMonths` ahead.
 *
 * Month arithmetic goes through the `Date(y, m, d)` constructor, which
 * normalises overflow in both directions — month `-1` is December of the year
 * before, day `0` is the last day of the previous month — so December,
 * January and a leap-year February need no special case.
 */
export function heatmapRange(
  now: number,
  forwardMonths: number = HEATMAP_FORWARD_MONTHS,
): HeatmapRange {
  const ahead = Math.max(0, Math.floor(forwardMonths));
  const today = midnight(now);
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  // Day 0 of the month after the last one we want = its last day.
  const end = new Date(today.getFullYear(), today.getMonth() + ahead + 1, 0);
  const gridStart = new Date(start.getFullYear(), start.getMonth(), 1 - start.getDay());
  return {
    start: start.getTime(),
    end: end.getTime(),
    gridStart: gridStart.getTime(),
    today: today.getTime(),
    days: daysBetween(start.getTime(), end.getTime()) + 1,
    columns: Math.floor(daysBetween(gridStart.getTime(), end.getTime()) / 7) + 1,
  };
}

/**
 * Lay the window out as a grid: a column per week, a row per weekday.
 *
 * `perDay` is the Rust census's per-calendar-day counts, OLDEST first with the
 * last entry being today (`VaultStats.activity.days`). Days in the window that
 * the census does not reach — and every future day — come through as 0. An
 * empty census returns an empty grid, which is the caller's "no per-day
 * activity" case; the range itself does not depend on the data.
 */
export function buildHeatmap(
  perDay: number[],
  now: number,
  forwardMonths: number = HEATMAP_FORWARD_MONTHS,
): Heatmap {
  const range = heatmapRange(now, forwardMonths);
  if (perDay.length === 0) {
    return { cells: [], columns: 0, months: [], peak: 0, range };
  }

  const start = new Date(range.start);
  const raw: Array<Omit<HeatmapCell, "level">> = [];
  const months: Array<{ col: number; label: string }> = [];
  let peak = 0;

  for (let i = 0; i < range.days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = d.getTime();
    const daysAgo = daysBetween(date, range.today);
    const future = daysAgo < 0;
    const count =
      !future && daysAgo < perDay.length ? (perDay[perDay.length - 1 - daysAgo] ?? 0) : 0;
    if (!future && count > peak) peak = count;
    raw.push({
      col: Math.floor(daysBetween(range.gridStart, date) / 7),
      row: d.getDay(),
      date,
      count,
      today: daysAgo === 0,
      future,
    });
    // Label the column a month opens in — the window starts on a 1st, so every
    // month in it gets exactly one label. A label needs about two columns of
    // room; if two ever land closer, the older one goes, as GitHub does.
    if (d.getDate() === 1) {
      const col = raw[raw.length - 1]!.col;
      const prev = months[months.length - 1];
      if (prev && col - prev.col < 2) months.pop();
      months.push({ col, label: MONTH_SHORT[d.getMonth()]! });
    }
  }

  const cells: HeatmapCell[] = raw.map((c) => ({
    ...c,
    level: c.future ? 0 : activityLevel(c.count, peak),
  }));
  return { cells, columns: range.columns, months, peak, range };
}

/** "Aug – Dec 2026" / "Dec 2025 – Apr 2026" — the window in words, for the
 *  strip's accessible name. */
export function heatmapRangeLabel(range: HeatmapRange): string {
  const a = new Date(range.start);
  const b = new Date(range.end);
  const from =
    a.getFullYear() === b.getFullYear()
      ? MONTH_SHORT[a.getMonth()]
      : `${MONTH_SHORT[a.getMonth()]} ${a.getFullYear()}`;
  return `${from} – ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
}
