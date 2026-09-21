// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { distinctRepairPath } from "../stewardRepairs";
describe("agent rename candidates", () => {
  it("preserves extension and avoids names case-insensitively", () => {
    expect(distinctRepairPath("Work/Plan.md", new Set(["work/plan (1).md"]))).toBe("Work/Plan (2).md");
  });
  it("shortens a long leaf but refuses unsafe parent moves", () => {
    expect(distinctRepairPath("Work/" + "a".repeat(230) + ".md", new Set(), true)!.length).toBeLessThan(200);
    expect(distinctRepairPath("a".repeat(160) + "/Plan.md", new Set(), true)).toBeNull();
    expect(distinctRepairPath("CON/Plan.md", new Set())).toBeNull();
  });
});
