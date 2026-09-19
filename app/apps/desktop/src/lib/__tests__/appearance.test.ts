// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  automaticItemColorAssignments,
  automaticItemColorId,
  ITEM_COLORS,
} from "../appearance";

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

  it("has enough choices to distinguish a busy sidebar", () => {
    expect(ITEM_COLORS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ITEM_COLORS.map((entry) => entry.id)).size).toBe(ITEM_COLORS.length);
    expect(new Set(ITEM_COLORS.map((entry) => entry.value)).size).toBe(ITEM_COLORS.length);
  });

  it("does not repeat a colour family within three adjacent siblings", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      key: `row-${index}`,
      identity: `doc-${index}`,
    }));
    const colors = Object.values(
      automaticItemColorAssignments("user-1", "vault-1", items),
    );
    const families = colors.map(
      (id) => ITEM_COLORS.find((entry) => entry.id === id)!.family,
    );

    for (let index = 1; index < families.length; index++) {
      expect(families[index]).not.toBe(families[index - 1]);
      if (index > 1) expect(families[index]).not.toBe(families[index - 2]);
    }
  });

  it("keeps explicit colours authoritative and avoids them on nearby automatic rows", () => {
    const preferred = automaticItemColorId("user-1", "vault-1", "doc-2");
    const colors = automaticItemColorAssignments("user-1", "vault-1", [
      { key: "manual", identity: "doc-1", explicitColorId: preferred },
      { key: "automatic", identity: "doc-2" },
    ]);

    expect(colors.manual).toBe(preferred);
    const family = (id: string) => ITEM_COLORS.find((entry) => entry.id === id)!.family;
    expect(family(colors.automatic)).not.toBe(family(preferred));
  });
});
