// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { automaticItemColorId, ITEM_COLORS } from "../appearance";

describe("automatic item colours", () => {
  it("is stable and always returns a palette colour", () => {
    const color = automaticItemColorId("user-1", "vault-1", "doc-1");
    expect(automaticItemColorId("user-1", "vault-1", "doc-1")).toBe(color);
    expect(ITEM_COLORS.map((entry) => entry.id)).toContain(color);
  });

  it("is scoped to the account, vault, and item identity", () => {
    const assignments = new Set([
      automaticItemColorId("user-1", "vault-1", "doc-1"),
      automaticItemColorId("user-2", "vault-1", "doc-1"),
      automaticItemColorId("user-1", "vault-2", "doc-1"),
      automaticItemColorId("user-1", "vault-1", "doc-2"),
    ]);

    // A small palette permits collisions, but changing all three identity
    // dimensions must not collapse every example to one assignment.
    expect(assignments.size).toBeGreaterThan(1);
  });
});
