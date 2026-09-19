// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AccessEntry } from "../../lib/accessTree";
import { accessEntryKey, selectedBulkResources, vaultAccessKey } from "../../lib/accessBulk";
import { accessSelectionPresentations } from "../AccessPanel";

const entries: AccessEntry[] = [
  { kind: "folder", id: "projects", path: "Projects", hasChildren: true },
  { kind: "folder", id: "plans", path: "Projects/Plans", hasChildren: true },
  { kind: "note", id: "roadmap", path: "Projects/Plans/Roadmap.md" },
  { kind: "note", id: "readme", path: "Readme.md" },
];

const shown = (index: number, selected: ReadonlySet<string>) =>
  accessSelectionPresentations(entries, selected, vaultAccessKey("org-1"))
    .get(accessEntryKey(entries[index]));

describe("AccessPanel inherited selection", () => {
  it("shows nested descendants as selected through the nearest selected folder", () => {
    const selected = new Set([accessEntryKey(entries[0])]);

    expect(shown(1, selected)).toEqual({
      checked: true,
      inheritedFrom: { key: "folder:projects", label: "Projects" },
    });
    expect(shown(2, selected)).toEqual({
      checked: true,
      inheritedFrom: { key: "folder:projects", label: "Projects" },
    });
    expect(shown(3, selected)).toEqual({ checked: false, inheritedFrom: null });
  });

  it("shows every item as inherited when Entire vault is selected", () => {
    const vault = vaultAccessKey("org-1");
    const presentations = accessSelectionPresentations(entries, new Set([vault]), vault);

    for (const entry of entries) {
      expect(presentations.get(accessEntryKey(entry))).toEqual({
        checked: true,
        inheritedFrom: { key: vault, label: "Entire vault" },
      });
    }
  });

  it("keeps direct selection distinct from inherited presentation", () => {
    const selected = new Set([accessEntryKey(entries[0]), accessEntryKey(entries[1])]);

    expect(shown(1, selected)).toEqual({ checked: true, inheritedFrom: null });
    expect(shown(2, selected)?.inheritedFrom?.key).toBe("folder:plans");
  });

  it("does not add descendant ids to the submitted bulk scope", () => {
    const selected = new Set([accessEntryKey(entries[0])]);

    expect(shown(2, selected)?.checked).toBe(true);
    expect(selectedBulkResources(selected, entries, "org-1")).toEqual([
      { resourceType: "folder", resourceId: "projects" },
    ]);

    const vault = vaultAccessKey("org-1");
    expect(selectedBulkResources(new Set([vault]), entries, "org-1")).toEqual([
      { resourceType: "vault", resourceId: "org-1" },
    ]);
  });
});
