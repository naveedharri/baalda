// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hasHiddenSegment, isFloorName, isHiddenName, NO_FOLDERS } from "../folders";

describe("folder switches (#401)", () => {
  it("hide dot and build folders by default, as before", () => {
    for (const n of [".github", ".obsidian", "node_modules", "dist", "venv"]) {
      expect(isHiddenName(n, NO_FOLDERS), n).toBe(true);
    }
    expect(isHiddenName("Projects", NO_FOLDERS)).toBe(false);
  });

  it("open each group on its own switch", () => {
    expect(isHiddenName(".github", { hidden: true, build: false })).toBe(false);
    expect(isHiddenName("node_modules", { hidden: true, build: false })).toBe(true);
    expect(isHiddenName("node_modules", { hidden: false, build: true })).toBe(false);
    expect(hasHiddenSegment("app/.github/ci.yml", { hidden: true, build: false })).toBe(false);
    expect(hasHiddenSegment("app/.github/ci.yml", NO_FOLDERS)).toBe(true);
  });

  it("never open the floor", () => {
    const all = { hidden: true, build: true };
    for (const n of [".context", ".git", ".DS_Store", "._photo.jpg", "Thumbs.db", ".~lock.a.docx#", ".a.md.1.2.tmp"]) {
      expect(isFloorName(n), n).toBe(true);
      expect(isHiddenName(n, all), n).toBe(true);
    }
    expect(hasHiddenSegment("code/.git/config", all)).toBe(true);
  });
});
