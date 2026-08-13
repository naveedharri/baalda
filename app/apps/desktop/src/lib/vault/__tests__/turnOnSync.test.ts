import { describe, it, expect } from "vitest";
import { planTurnOnSync } from "../turnOnSync";

describe("planTurnOnSync", () => {
  it("creates a vault for a folder nothing is bound to", () => {
    expect(
      planTurnOnSync({
        openPath: "/vaults/notes",
        activeOrganizationId: null,
        orgIds: [],
        orgVaults: {},
      }),
    ).toEqual({ kind: "create-vault" });
  });

  it("retries the active vault when the open folder is its own folder", () => {
    // Sync is off for a folder that IS the active vault's — enabling it failed,
    // so this is a recovery, not a creation.
    expect(
      planTurnOnSync({
        openPath: "/vaults/team",
        activeOrganizationId: "org-a",
        orgIds: ["org-a"],
        orgVaults: { "org-a": "/vaults/team" },
      }),
    ).toEqual({ kind: "retry-active", orgId: "org-a" });
  });

  it("switches instead of creating when another vault owns the open folder", () => {
    // Adopting this folder for a new vault would evict org-a's binding.
    expect(
      planTurnOnSync({
        openPath: "/vaults/a",
        activeOrganizationId: "org-b",
        orgIds: ["org-a", "org-b"],
        orgVaults: { "org-a": "/vaults/a", "org-b": "/vaults/b" },
      }),
    ).toEqual({ kind: "switch", orgId: "org-a" });
  });

  it("creates a vault for a folder bound to a vault we were removed from", () => {
    // A stale binding must not pin the folder to a vault that can never sync.
    expect(
      planTurnOnSync({
        openPath: "/vaults/old",
        activeOrganizationId: "org-b",
        orgIds: ["org-b"],
        orgVaults: { "org-gone": "/vaults/old", "org-b": "/vaults/b" },
      }),
    ).toEqual({ kind: "create-vault" });
  });

  /**
   * The reported bug, as a sequence: make a vault, then make another, then a
   * third. `activeOrganizationId` survives opening each new local folder, so
   * the old account-level guard matched every time from vault 2 onward and
   * re-synced each new folder into vault 1 — orphaning the previous folder and
   * never putting the new vault on the account.
   */
  it("creates a distinct vault for each new folder in a row", () => {
    const orgVaults: Record<string, string> = {};
    const orgIds: string[] = [];
    let activeOrganizationId: string | null = null;

    for (const [i, openPath] of ["/vaults/one", "/vaults/two", "/vaults/three"].entries()) {
      const plan = planTurnOnSync({ openPath, activeOrganizationId, orgIds, orgVaults });
      expect(plan, `vault ${i + 1} must be created, not folded into an existing one`).toEqual({
        kind: "create-vault",
      });
      // What the store does on a create: new org, bound to this folder, now active.
      const orgId = `org-${i + 1}`;
      orgIds.push(orgId);
      orgVaults[orgId] = openPath;
      activeOrganizationId = orgId;
    }

    // Three vaults, three folders, no binding overwritten.
    expect(orgVaults).toEqual({
      "org-1": "/vaults/one",
      "org-2": "/vaults/two",
      "org-3": "/vaults/three",
    });
    expect(new Set(Object.values(orgVaults)).size).toBe(3);
  });

  it("switches to the stamped vault when the binding was lost", () => {
    // The localStorage binding is gone (cleared storage / eviction) but the
    // folder's own config still says whose it is — heal, don't duplicate.
    expect(
      planTurnOnSync({
        openPath: "/vaults/team",
        activeOrganizationId: "org-b",
        orgIds: ["org-a", "org-b"],
        orgVaults: { "org-b": "/vaults/b" },
        stampedOrgId: "org-a",
      }),
    ).toEqual({ kind: "switch", orgId: "org-a" });
  });

  it("retries the active vault when the stamp names it and the binding was lost", () => {
    expect(
      planTurnOnSync({
        openPath: "/vaults/team",
        activeOrganizationId: "org-a",
        orgIds: ["org-a"],
        orgVaults: {},
        stampedOrgId: "org-a",
      }),
    ).toEqual({ kind: "retry-active", orgId: "org-a" });
  });

  it("blocks adopting a folder stamped for a vault we can't see", () => {
    // Another account's synced folder: creating a vault here would upload a
    // full duplicate of it under the wrong account.
    expect(
      planTurnOnSync({
        openPath: "/vaults/foreign",
        activeOrganizationId: "org-b",
        orgIds: ["org-b"],
        orgVaults: { "org-b": "/vaults/b" },
        stampedOrgId: "org-x",
      }),
    ).toEqual({ kind: "blocked-foreign", orgId: "org-x" });
  });

  it("prefers a live binding over the folder's stamp", () => {
    // Both signals present and disagreeing: the binding reflects an explicit,
    // newer decision on this device.
    expect(
      planTurnOnSync({
        openPath: "/vaults/a",
        activeOrganizationId: "org-b",
        orgIds: ["org-a", "org-b"],
        orgVaults: { "org-a": "/vaults/a" },
        stampedOrgId: "org-x",
      }),
    ).toEqual({ kind: "switch", orgId: "org-a" });
  });

  it("still retries after a failed sync on the vault just created", () => {
    // Immediately after the create above: same folder, now bound and active.
    expect(
      planTurnOnSync({
        openPath: "/vaults/three",
        activeOrganizationId: "org-3",
        orgIds: ["org-1", "org-2", "org-3"],
        orgVaults: {
          "org-1": "/vaults/one",
          "org-2": "/vaults/two",
          "org-3": "/vaults/three",
        },
      }),
    ).toEqual({ kind: "retry-active", orgId: "org-3" });
  });
});
