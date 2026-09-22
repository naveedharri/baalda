import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { createAccessSummaryBatcher, SUMMARY_BATCH_MAX } from "../accessSummaryBatch";

const folder = (id: string) => ({ resourceType: "folder" as const, resourceId: id });

function manual() {
  let run: (() => void) | null = null;
  return { schedule: (fn: () => void) => { run = fn; }, flush: () => run?.() };
}

describe("access summary batcher", () => {
  it("answers every row that mounted together with one request", async () => {
    const timer = manual();
    const many = vi.fn(async (_org: string, groups: unknown[][]) => groups.map(() => "open" as const));
    const one = vi.fn();
    const batcher = createAccessSummaryBatcher({ many, one }, timer.schedule);
    const reads = ["a", "b", "c"].map((id) => batcher.read("org", folder(id), ["u1"], () => false));
    timer.flush();
    expect(await Promise.all(reads)).toEqual(["open", "open", "open"]);
    expect(many).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenCalledWith("org", [[folder("a")], [folder("b")], [folder("c")]], ["u1"]);
    expect(one).not.toHaveBeenCalled();
  });

  it("drops rows that unmounted before the flush and splits by people", async () => {
    const timer = manual();
    const many = vi.fn(async (_org: string, groups: unknown[][]) => groups.map(() => "readonly" as const));
    const batcher = createAccessSummaryBatcher({ many, one: vi.fn() }, timer.schedule);
    void batcher.read("org", folder("stale"), ["u1"], () => true);
    const a = batcher.read("org", folder("a"), ["u1"], () => false);
    const b = batcher.read("org", folder("b"), ["u2"], () => false);
    timer.flush();
    await Promise.all([a, b]);
    expect(many.mock.calls.map((call) => call[1])).toEqual([[[folder("a")]], [[folder("b")]]]);
  });

  it("chunks large trees", async () => {
    const timer = manual();
    const many = vi.fn(async (_org: string, groups: unknown[][]) => groups.map(() => "open" as const));
    const batcher = createAccessSummaryBatcher({ many, one: vi.fn() }, timer.schedule);
    const reads = Array.from({ length: SUMMARY_BATCH_MAX + 1 }, (_, i) => batcher.read("org", folder(`f${i}`), ["u1"], () => false));
    timer.flush();
    await Promise.all(reads);
    expect(many.mock.calls.map((call) => call[1].length)).toEqual([SUMMARY_BATCH_MAX, 1]);
  });

  it("falls back to one request per row on a server without the batch route", async () => {
    const timer = manual();
    const many = vi.fn(async () => { throw new ApiError(404, "Not found"); });
    const one = vi.fn(async () => "private" as const);
    const batcher = createAccessSummaryBatcher({ many, one }, timer.schedule);
    const reads = [batcher.read("org", folder("a"), ["u1"], () => false), batcher.read("org", folder("b"), ["u1"], () => false)];
    timer.flush();
    expect(await Promise.all(reads)).toEqual(["private", "private"]);
    expect(one).toHaveBeenCalledTimes(2);
    const later = batcher.read("org", folder("c"), ["u1"], () => false);
    timer.flush();
    await later;
    expect(many).toHaveBeenCalledTimes(1);
  });

  it("rejects every row when the batch fails for another reason", async () => {
    const timer = manual();
    const batcher = createAccessSummaryBatcher({ many: async () => { throw new Error("offline"); }, one: vi.fn() }, timer.schedule);
    const read = batcher.read("org", folder("a"), ["u1"], () => false);
    timer.flush();
    await expect(read).rejects.toThrow("offline");
  });
});
