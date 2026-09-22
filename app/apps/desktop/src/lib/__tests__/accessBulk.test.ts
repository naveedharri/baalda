// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  accessEntryKey,
  buildBulkAccessInput,
  bulkChangeNeedsConfirmation,
  compactAccessResources,
  selectedBulkResources,
  selectAllAccessEntries,
  toggleAccessSelection,
  vaultAccessKey,
} from "../accessBulk";

const entries = [
  { kind: "folder" as const, id: "folder-1", path: "Projects", hasChildren: true },
  { kind: "note" as const, id: "doc-1", path: "Projects/Plan.md" },
];

describe("bulk access selection", () => {
  it("compacts a large selection to covering folders without changing the vault default", () => {
    const tree = [entries[0], ...Array.from({ length: 7000 }, (_, i) => ({
      kind: "note" as const, id: `n${i}`, path: `Projects/Note ${i}.md`,
    })), { kind: "note" as const, id: "root", path: "Root.md" }];
    const resources = selectedBulkResources(selectAllAccessEntries(tree), tree, "org-1");
    expect(compactAccessResources(resources, tree)).toEqual([
      { resourceType: "folder", resourceId: "folder-1" },
      { resourceType: "file", resourceId: "root" },
    ]);
  });

  it("does not fold a similarly named sibling into a selected folder", () => {
    const tree = [...entries, { kind: "note" as const, id: "other", path: "Projects-old/Plan.md" }];
    expect(compactAccessResources(selectedBulkResources(selectAllAccessEntries(tree), tree, "org-1"), tree))
      .toEqual([
        { resourceType: "folder", resourceId: "folder-1" },
        { resourceType: "file", resourceId: "other" },
      ]);
  });
  it("makes the whole-vault scope exclusive", () => {
    const folder = accessEntryKey(entries[0]);
    const vault = vaultAccessKey("org-1");
    expect([...toggleAccessSelection(new Set([folder]), vault, vault)]).toEqual([vault]);
    expect([...toggleAccessSelection(new Set([vault]), folder, vault)]).toEqual([folder]);
  });

  it("maps notes to file resources and the whole vault to the org id", () => {
    const selected = new Set(entries.map(accessEntryKey));
    expect(selectedBulkResources(selected, entries, "org-1")).toEqual([
      { resourceType: "folder", resourceId: "folder-1" },
      { resourceType: "file", resourceId: "doc-1" },
    ]);
    expect(selectedBulkResources(new Set([vaultAccessKey("org-1")]), entries, "org-1")).toEqual([
      { resourceType: "vault", resourceId: "org-1" },
    ]);
  });

  it("selects the full flat tree, including content hidden by a collapsed folder", () => {
    expect([...selectAllAccessEntries(entries)]).toEqual(["folder:folder-1", "note:doc-1"]);
  });

  it("builds the exact selected-users payload without widening it to everyone", () => {
    expect(
      buildBulkAccessInput({
        resources: [{ resourceType: "file", resourceId: "doc-1" }],
        audienceType: "users",
        userIds: ["u2", "u3"],
        mode: "readonly",
      }),
    ).toEqual({
      resources: [{ resourceType: "file", resourceId: "doc-1" }],
      audience: { type: "users", userIds: ["u2", "u3"] },
      mode: "readonly",
    });
  });

  it("confirms destructive and subtree-wide changes, but not a simple one-person file grant", () => {
    expect(
      bulkChangeNeedsConfirmation({
        resources: [{ resourceType: "file", resourceId: "doc-1" }],
        audienceType: "users",
        mode: "open",
      }),
    ).toBe(false);
    expect(
      bulkChangeNeedsConfirmation({
        resources: [{ resourceType: "folder", resourceId: "folder-1" }],
        audienceType: "users",
        mode: "open",
      }),
    ).toBe(true);
    expect(
      bulkChangeNeedsConfirmation({
        resources: [{ resourceType: "file", resourceId: "doc-1" }],
        audienceType: "users",
        mode: "private",
      }),
    ).toBe(true);
  });
});
