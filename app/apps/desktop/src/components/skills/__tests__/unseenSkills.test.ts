import { describe, expect, it } from "vitest";
import { takeUnseenSkills } from "../useHighlightSkill";

function memory() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe("takeUnseenSkills", () => {
  it("records the first catalog without announcing it, then returns only skills new since", () => {
    const s = memory();
    expect(takeUnseenSkills("srv|org", ["a", "b"], s)).toEqual([]);
    expect(takeUnseenSkills("srv|org", ["a", "b", "c"], s)).toEqual(["c"]);
    expect(takeUnseenSkills("srv|org", ["a", "b", "c"], s)).toEqual([]);
  });

  it("keeps vaults apart and survives no storage", () => {
    const s = memory();
    takeUnseenSkills("srv|one", ["a"], s);
    expect(takeUnseenSkills("srv|two", ["a", "x"], s)).toEqual([]);
    expect(takeUnseenSkills("srv|one", ["a", "x"], s)).toEqual(["x"]);
    expect(takeUnseenSkills("srv|one", ["a", "y"], null)).toEqual([]);
  });
});
