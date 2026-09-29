import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_MAX,
  ACTIVITY_LOG_MAX_AGE_MS,
  appendLog,
  parseLog,
  pruneLog,
  removeFromLog,
  type ActivityLogEntry,
} from "../activityLog";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const e = (id: string, at: number, kind: ActivityLogEntry["kind"] = "failed"): ActivityLogEntry => ({
  id,
  kind,
  path: `${id}.md`,
  at,
});

describe("activity log", () => {
  it("appends and dedupes by id, first record wins", () => {
    const a = appendLog([], [e("x", NOW - 10)], NOW);
    const b = appendLog(a, [{ ...e("x", NOW), detail: "later" }, e("y", NOW - 5)], NOW);
    expect(b.map((x) => x.id)).toEqual(["x", "y"]);
    expect(b[0].at).toBe(NOW - 10);
    expect(b[0].detail).toBeUndefined();
  });

  it("dedupes within one batch", () => {
    expect(appendLog([], [e("x", NOW), e("x", NOW - 1)], NOW)).toHaveLength(1);
  });

  it("prunes entries older than 30 days", () => {
    const old = e("old", NOW - ACTIVITY_LOG_MAX_AGE_MS - 1);
    const edge = e("edge", NOW - ACTIVITY_LOG_MAX_AGE_MS);
    expect(pruneLog([old, edge], NOW).map((x) => x.id)).toEqual(["edge"]);
    expect(appendLog([old], [e("n", NOW)], NOW).map((x) => x.id)).toEqual(["n"]);
  });

  it("caps at the newest entries", () => {
    const many = Array.from({ length: ACTIVITY_LOG_MAX + 20 }, (_, i) => e(`k${i}`, NOW - 100_000 + i));
    const out = appendLog([], many, NOW);
    expect(out).toHaveLength(ACTIVITY_LOG_MAX);
    expect(out[0].id).toBe("k20");
    expect(out[out.length - 1].id).toBe(`k${ACTIVITY_LOG_MAX + 19}`);
  });

  it("keeps entries sorted oldest first", () => {
    const out = appendLog([e("b", NOW - 1)], [e("a", NOW - 9), e("c", NOW)], NOW);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("removes by id", () => {
    expect(removeFromLog([e("a", NOW), e("h", NOW, "held")], ["h"]).map((x) => x.id)).toEqual(["a"]);
  });

  it("parses defensively and prunes on load", () => {
    expect(parseLog(null, NOW)).toEqual([]);
    expect(parseLog("not json", NOW)).toEqual([]);
    expect(parseLog('{"a":1}', NOW)).toEqual([]);
    const raw = JSON.stringify([e("ok", NOW), { id: 1 }, e("stale", NOW - ACTIVITY_LOG_MAX_AGE_MS - 5)]);
    expect(parseLog(raw, NOW).map((x) => x.id)).toEqual(["ok"]);
  });
});
