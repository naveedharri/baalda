// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TeamAccess } from "../../lib/api";
import type { AccessEntry } from "../../lib/accessTree";
import { accessEntryKey, selectedBulkResources, vaultAccessKey } from "../../lib/accessBulk";
import {
  accessSelectionPresentations,
  accessSummaryResources,
  currentAccessMode,
  selectedOrgAccessMode,
} from "../AccessPanel";

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

describe("AccessPanel current access", () => {
  const teamAccess: TeamAccess = { mode: "readonly", grantId: "grant", overrides: [] };

  it("does not invent a current mode before authoritative state arrives", () => {
    expect(currentAccessMode([])).toBeNull();
    expect(selectedOrgAccessMode({
      teamAccess: null,
      serverTreeKnown: true,
      vaultSelected: true,
      shownVaultMode: "private",
      entries,
      selectedKeys: new Set([vaultAccessKey("org-1")]),
      orgRowsByPath: new Map(),
    })).toBeNull();
    expect(selectedOrgAccessMode({
      teamAccess,
      serverTreeKnown: false,
      vaultSelected: true,
      shownVaultMode: "readonly",
      entries,
      selectedKeys: new Set([vaultAccessKey("org-1")]),
      orgRowsByPath: new Map(),
    })).toBeNull();
  });

  it("uses the effective whole-vault mode once both access and structure are known", () => {
    expect(selectedOrgAccessMode({
      teamAccess,
      serverTreeKnown: true,
      vaultSelected: true,
      shownVaultMode: "readonly",
      entries,
      selectedKeys: new Set([vaultAccessKey("org-1")]),
      orgRowsByPath: new Map(),
    })).toBe("readonly");
  });

  it("resolves item overrides and reports disagreement across selected scopes", () => {
    const selectedKeys = new Set([accessEntryKey(entries[0]), accessEntryKey(entries[3])]);
    const rows = new Map([
      ["Projects", new Set(["edit"] as const)],
    ]);
    expect(selectedOrgAccessMode({
      teamAccess,
      serverTreeKnown: true,
      vaultSelected: false,
      shownVaultMode: "readonly",
      entries,
      selectedKeys,
      orgRowsByPath: rows,
    })).toBe("mixed");
  });

  it("sends compact roots for authoritative selected-people summaries", () => {
    expect(accessSummaryResources({
      resources: [
        { resourceType: "folder", resourceId: "projects" },
        { resourceType: "folder", resourceId: "plans" },
        { resourceType: "file", resourceId: "roadmap" },
        { resourceType: "file", resourceId: "readme" },
      ],
      entries,
      allItemsSelected: false,
      orgId: "org-1",
    })).toEqual([
      { resourceType: "folder", resourceId: "projects" },
      { resourceType: "file", resourceId: "readme" },
    ]);
    expect(accessSummaryResources({
      resources: entries.map((entry) => ({
        resourceType: entry.kind === "folder" ? "folder" as const : "file" as const,
        resourceId: entry.id,
      })),
      entries,
      allItemsSelected: true,
      orgId: "org-1",
    })).toEqual([{ resourceType: "vault", resourceId: "org-1" }]);
  });
});
