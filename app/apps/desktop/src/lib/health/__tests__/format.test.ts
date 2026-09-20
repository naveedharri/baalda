import { describe, expect, it } from "vitest";
import {
  activityCellTitle,
  activityLevel,
  clockTime,
  dayKey,
  dayLabel,
  formatBytes,
  kindLabel,
  middleTruncate,
  relativeTime,
  verdictLabel,
  verdictTone,
} from "../format";
import type { HealthIssueKind, HealthVerdict } from "../types";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe("formatBytes", () => {
  it("counts bytes whole below a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to whole kilobytes at 1 KiB", () => {
    expect(formatBytes(KB)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(94 * KB)).toBe("94 KB");
  });

  it("carries one decimal from a megabyte up", () => {
    expect(formatBytes(MB)).toBe("1.0 MB");
    expect(formatBytes(10 * MB)).toBe("10.0 MB");
    expect(formatBytes(12.44 * MB)).toBe("12.4 MB");
    expect(formatBytes(GB)).toBe("1.0 GB");
    expect(formatBytes(3.25 * GB)).toBe("3.3 GB");
  });

  it("groups the thousands in a big kilobyte count", () => {
    // 1023 KB is the widest this unit gets; the grouping matters more on the
    // index-size tile, where four figures are common.
    expect(formatBytes(1020 * KB)).toBe("1,020 KB");
  });

  it("never throws on a broken census", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("calls anything inside 45 seconds just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44_000)).toBe("just now");
  });

  it("spells the units out", () => {
    expect(ago(3 * 60_000)).toBe("3 min ago");
    expect(ago(59 * 60_000)).toBe("59 min ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(5 * 3_600_000)).toBe("5 hours ago");
    expect(ago(24 * 3_600_000)).toBe("1 day ago");
    expect(ago(2 * 86_400_000)).toBe("2 days ago");
    expect(ago(45 * 86_400_000)).toBe("1 month ago");
    expect(ago(400 * 86_400_000)).toBe("1 year ago");
  });

  it("rounds a sub-minute-but-not-just-now gap up to one minute", () => {
    expect(ago(50_000)).toBe("1 min ago");
  });

  it("reads a future timestamp as just now", () => {
    expect(relativeTime(now + 600_000, now)).toBe("just now");
  });

  it("returns a dash for a timestamp it cannot use", () => {
    expect(relativeTime(Number.NaN, now)).toBe("—");
  });
});

describe("middleTruncate", () => {
  it("leaves a path that already fits", () => {
    expect(middleTruncate("notes/todo.md", 40)).toBe("notes/todo.md");
  });

  it("keeps both ends and never exceeds the budget", () => {
    const path = "Projects/Q3/Research/Interviews/2026/meeting-notes.md";
    const out = middleTruncate(path, 30);
    expect(out.length).toBe(30);
    expect(out).toContain("…");
    expect(out.startsWith("Projects/")).toBe(true);
    expect(out.endsWith("notes.md")).toBe(true);
  });

  it("degrades to an ellipsis at an unusable budget", () => {
    expect(middleTruncate("a/b/c.md", 1)).toBe("…");
    expect(middleTruncate("a/b/c.md", 0)).toBe("…");
  });
});

describe("verdictLabel / verdictTone", () => {
  const all: HealthVerdict[] = [
    "local",
    "signed-out",
    "no-access",
    "offline",
    "connecting",
    "syncing",
    "attention",
    "healthy",
  ];

  it("labels every verdict in sentence case", () => {
    for (const v of all) {
      const label = verdictLabel(v);
      expect(label.length).toBeGreaterThan(0);
      expect(label).toBe(label[0].toUpperCase() + label.slice(1));
      expect(label).not.toContain("!");
    }
  });

  it("tones a healthy vault good and a local one muted", () => {
    expect(verdictTone("healthy")).toBe("good");
    expect(verdictTone("local")).toBe("muted");
    expect(verdictTone("syncing")).toBe("busy");
    expect(verdictTone("attention")).toBe("warn");
    expect(verdictTone("no-access")).toBe("bad");
  });

  it("gives every verdict a tone", () => {
    for (const v of all) {
      expect(["good", "busy", "warn", "bad", "muted"]).toContain(verdictTone(v));
    }
  });
});

describe("kindLabel", () => {
  const all: HealthIssueKind[] = [
    "too-large",
    "upload-failed",
    "register-failed",
    "limit",
    "unregistered",
    "no-access",
    "left-behind",
    "materialize-failed",
    "inbound-blocked",
    "orphan-history",
  ];

  it("labels every kind in sentence case, short enough for a chip", () => {
    for (const k of all) {
      const label = kindLabel(k);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(18);
      expect(label).toBe(label[0].toUpperCase() + label.slice(1));
    }
  });

  it("never shows the engineer's word for a kind", () => {
    for (const k of all) expect(kindLabel(k)).not.toContain("-");
  });

  it("gives every kind its own label", () => {
    expect(new Set(all.map(kindLabel)).size).toBe(all.length);
  });
});

describe("activityLevel", () => {
  it("is zero only for an empty week", () => {
    expect(activityLevel(0, 10)).toBe(0);
    expect(activityLevel(1, 10)).toBeGreaterThan(0);
  });

  it("puts the busiest week at the top step", () => {
    expect(activityLevel(10, 10)).toBe(4);
  });

  it("steps through the quarters", () => {
    expect(activityLevel(25, 100)).toBe(1);
    expect(activityLevel(26, 100)).toBe(2);
    expect(activityLevel(50, 100)).toBe(2);
    expect(activityLevel(51, 100)).toBe(3);
    expect(activityLevel(75, 100)).toBe(3);
    expect(activityLevel(76, 100)).toBe(4);
  });

  it("keeps a lone busy week legible when every other week is empty", () => {
    // The v1 failure case: one week holds everything. It must not render as a
    // level the eye cannot separate from an empty cell.
    const weeks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19];
    const peak = Math.max(...weeks);
    expect(weeks.map((n) => activityLevel(n, peak))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
    ]);
  });

  it("never throws on a broken census", () => {
    expect(activityLevel(Number.NaN, 10)).toBe(0);
    expect(activityLevel(-3, 10)).toBe(0);
    expect(activityLevel(5, 0)).toBe(1);
    expect(activityLevel(5, Number.NaN)).toBe(1);
    // A count above the peak (a census that disagrees with itself) still caps.
    expect(activityLevel(50, 10)).toBe(4);
  });
});

describe("clockTime", () => {
  it("pads to HH:MM in the device's own timezone", () => {
    const d = new Date(2026, 8, 16, 9, 7, 30);
    expect(clockTime(d.getTime())).toBe("09:07");
    const late = new Date(2026, 8, 16, 23, 59, 0);
    expect(clockTime(late.getTime())).toBe("23:59");
  });

  it("returns a placeholder rather than throwing on a broken timestamp", () => {
    expect(clockTime(Number.NaN)).toBe("--:--");
  });
});

describe("dayKey / dayLabel", () => {
  const noon = new Date(2026, 8, 16, 12, 0, 0).getTime();

  it("groups two times on the same local day under one key", () => {
    const morning = new Date(2026, 8, 16, 0, 30, 0).getTime();
    const evening = new Date(2026, 8, 16, 23, 30, 0).getTime();
    expect(dayKey(morning)).toBe(dayKey(evening));
    expect(dayKey(morning)).not.toBe(dayKey(noon + 86_400_000));
  });

  it("names today and yesterday rather than dating them", () => {
    expect(dayLabel(noon, noon)).toBe("Today");
    expect(dayLabel(noon - 86_400_000, noon)).toBe("Yesterday");
  });

  it("dates anything older", () => {
    expect(dayLabel(new Date(2026, 8, 12, 9, 0, 0).getTime(), noon)).toBe("12 Sep");
  });

  it("does not throw on a broken timestamp", () => {
    expect(dayKey(Number.NaN)).toBe("unknown");
    expect(dayLabel(Number.NaN, noon)).toBe("Unknown");
  });
});

describe("activityCellTitle", () => {
  it("names the day and the count, and says Today for today", () => {
    const cell = {
      col: 0,
      row: 3,
      date: new Date(2026, 8, 16).getTime(),
      count: 1,
      level: 1 as const,
      today: false,
    };
    expect(activityCellTitle(cell)).toBe("Wed 16 Sep · 1 note");
    expect(activityCellTitle({ ...cell, today: true, count: 3 })).toBe("Today · 3 notes");
  });
});
