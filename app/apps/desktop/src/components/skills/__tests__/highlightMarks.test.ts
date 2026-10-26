import { describe, expect, it } from "vitest";
import { takeReturningNewIds } from "../useHighlightSkill";

describe("takeReturningNewIds", () => {
  it("shows a recent mark once more, then never again, and forgets old ones", () => {
    const now = 1_000_000;
    const first = takeReturningNewIds(now, { a: { at: now - 60_000 }, old: { at: now - 10 * 60_000 } });
    expect(first.ids).toEqual(["a"]);
    expect(first.next).toEqual({ a: { at: now - 60_000, shownAgain: true } });
    expect(takeReturningNewIds(now + 1000, first.next).ids).toEqual([]);
  });
});
