import { describe, expect, it } from "vitest";
import fixtures from "../fixtures.json";
import { MAX_PATTERN_LINES, SyncRuleSet, patternsProblem } from "../match";

type Fixture = { name: string; patterns: string; cases: Array<[string, boolean, boolean]> };

describe("sync rules matcher", () => {
  // The SAME fixtures Rust's `sync_rules.rs` runs: a drift between the two
  // implementations fails one side or the other, never silently.
  for (const f of fixtures as Fixture[]) {
    it(f.name, () => {
      const rules = new SyncRuleSet(f.patterns);
      for (const [path, isDir, want] of f.cases) {
        expect(rules.excludes(path, isDir), `${path} (dir=${isDir})`).toBe(want);
      }
    });
  }

  it("refuses lists past the caps instead of truncating them", () => {
    expect(patternsProblem("code/\n")).toBeNull();
    expect(patternsProblem("a\n".repeat(MAX_PATTERN_LINES + 1))).toMatch(/too many/);
    expect(patternsProblem("a".repeat(64 * 1024 + 1))).toMatch(/too long/);
    // Comments and blank lines do not count towards the line cap.
    expect(patternsProblem("# c\n\n".repeat(MAX_PATTERN_LINES + 5))).toBeNull();
  });
});
