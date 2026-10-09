import { describe, expect, it } from "vitest";
import {
  orderPageActions,
  vaultPageDetails,
  vaultPagePlanLine,
  vaultPageRole,
  vaultPageTiles,
  vaultSettingsAction,
} from "../accountVaultPage";

const usage = { orgId: "o1", name: "Acme", people: 1, notes: 21, storageBytes: 5 * 1024 * 1024, files: 3 };

describe("vaultPageTiles", () => {
  it("shows people, notes, attachments and files from the usage row", () => {
    expect(vaultPageTiles(usage).map((t) => [t.key, t.value, t.sub])).toEqual([
      ["people", "1", "person"],
      ["notes", "21", "notes"],
      ["attachments", "5", "MB"],
      ["files", "3", "files"],
    ]);
  });

  it("has null values (dash or skeleton) when the vault is not in the usage", () => {
    const tiles = vaultPageTiles(null);
    expect(tiles.map((t) => t.key)).toEqual(["people", "notes", "attachments"]);
    expect(tiles.every((t) => t.value === null)).toBe(true);
  });
});

describe("vaultPageRole", () => {
  it("takes the active vault's role, else owner for a vault on my account, else unknown", () => {
    expect(vaultPageRole({ activeRole: "admin", onMyAccount: false })).toBe("admin");
    expect(vaultPageRole({ activeRole: null, onMyAccount: true })).toBe("owner");
    expect(vaultPageRole({ activeRole: null, onMyAccount: false })).toBeNull();
    expect(vaultPageRole({ activeRole: "weird", onMyAccount: false })).toBeNull();
  });
});

describe("vaultPagePlanLine", () => {
  it("names my account's plan or the owner's account", () => {
    expect(vaultPagePlanLine({ onMyAccount: true, accountPlan: "team", ownerName: null })).toBe("On your Team account");
    expect(vaultPagePlanLine({ onMyAccount: true, accountPlan: "free", ownerName: null })).toBe("On your Free account");
    expect(vaultPagePlanLine({ onMyAccount: false, accountPlan: "team", ownerName: "Sara" })).toBe("On Sara's account");
    expect(vaultPagePlanLine({ onMyAccount: false, accountPlan: null, ownerName: null })).toBe("On the owner's account");
  });
});

describe("vaultPageDetails", () => {
  const fmt = (iso: string) => `D(${iso.slice(0, 10)})`;
  it("lists role, plan, folder and created", () => {
    expect(
      vaultPageDetails({ role: "owner", planLine: "On your Team account", folderPath: "/v/Acme", createdAt: "2026-01-02T00:00:00Z", formatDate: fmt }),
    ).toEqual([
      { key: "role", label: "Your role", value: "Owner" },
      { key: "plan", label: "Plan", value: "On your Team account" },
      { key: "folder", label: "Folder on this device", value: "/v/Acme" },
      { key: "created", label: "Created", value: "D(2026-01-02)" },
    ]);
  });

  it("drops plan without billing and created without a date", () => {
    const rows = vaultPageDetails({ role: null, planLine: null, folderPath: null, createdAt: undefined, formatDate: fmt });
    expect(rows).toEqual([
      { key: "role", label: "Your role", value: "—" },
      { key: "folder", label: "Folder on this device", value: "Not on this device" },
    ]);
  });
});

describe("vaultSettingsAction", () => {
  it("opens, switches first, or is unavailable without a folder", () => {
    expect(vaultSettingsAction({ isOpen: true, boundPath: "/a" })).toBe("open");
    expect(vaultSettingsAction({ isOpen: false, boundPath: "/a" })).toBe("switch-then-open");
    expect(vaultSettingsAction({ isOpen: false, boundPath: null })).toBe("unavailable");
  });
});

describe("orderPageActions", () => {
  it("puts destructive actions last, keeping order otherwise", () => {
    const out = orderPageActions([
      { key: "leave", danger: true },
      { key: "remove" },
      { key: "delete", danger: true },
      { key: "reset" },
    ]);
    expect(out.map((a) => a.key)).toEqual(["remove", "reset", "leave", "delete"]);
  });
});
