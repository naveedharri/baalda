import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_VAULTS_VIEW_KEY,
  folderMissingCardActions,
  isDefaultVaultsRoot,
  matchesVaultQuery,
  orderSyncedVaults,
  RECENT_VAULT_CARDS,
  shortFolderPath,
  syncedCardMeta,
  visibleSyncedVaults,
  localCardLabels,
  readAccountVaultsView,
  vaultCardLabels,
  vaultSlugLabel,
  writeAccountVaultsView,
} from "../accountVaultsView";

describe("account vaults view pref", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to grid, and honours a stored list", () => {
    expect(readAccountVaultsView()).toBe("grid");
    store[ACCOUNT_VAULTS_VIEW_KEY] = "board";
    expect(readAccountVaultsView()).toBe("grid");
    store[ACCOUNT_VAULTS_VIEW_KEY] = "list";
    expect(readAccountVaultsView()).toBe("list");
  });

  it("round-trips grid", () => {
    writeAccountVaultsView("grid");
    expect(store[ACCOUNT_VAULTS_VIEW_KEY]).toBe("grid");
    expect(readAccountVaultsView()).toBe("grid");
    writeAccountVaultsView("list");
    expect(readAccountVaultsView()).toBe("list");
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(readAccountVaultsView()).toBe("grid");
    expect(() => writeAccountVaultsView("grid")).not.toThrow();
  });
});

describe("vaultCardLabels", () => {
  it("builds name and counts, never a slug line", () => {
    expect(vaultCardLabels({ name: "Acme Team" }, { people: 1, notes: 21 })).toEqual({
      name: "Acme Team",
      counts: "1 person · 21 notes",
      meta: "1 person · 21 notes",
      metaDanger: false,
    });
  });

  it("pluralises and handles one note", () => {
    expect(vaultCardLabels({ name: "X" }, { people: 3, notes: 1 }).counts).toBe("3 people · 1 note");
  });

  it("leaves unknown counts empty", () => {
    expect(vaultCardLabels({ name: "Notes" }, null)).toEqual({
      name: "Notes",
      counts: null,
      meta: null,
      metaDanger: false,
    });
  });
});

describe("vaultSlugLabel", () => {
  it("shows a slug that differs from the name", () => {
    expect(vaultSlugLabel({ name: "Hello 4", slug: "hello-4" })).toBe("hello-4");
  });

  it("drops a slug that only repeats the name, or is empty", () => {
    expect(vaultSlugLabel({ name: "Notes", slug: "notes" })).toBeNull();
    expect(vaultSlugLabel({ name: "Notes", slug: "" })).toBeNull();
    expect(vaultSlugLabel({ name: "Notes" })).toBeNull();
  });
});

describe("localCardLabels", () => {
  it("says Local alone when the folder is named like the vault", () => {
    expect(localCardLabels({ name: "Notes", path: "/Users/a/Baalda/notes" })).toEqual({
      name: "Notes",
      meta: "Local",
      letter: "N",
    });
  });

  it("adds the folder's last segment when it differs", () => {
    expect(localCardLabels({ name: "Work", path: "/Users/a/Documents/work-vault/" }).meta).toBe(
      "Local · work-vault",
    );
    expect(localCardLabels({ name: "Work", path: "C:\\Users\\a\\Vaults\\Jobs" }).meta).toBe(
      "Local · Jobs",
    );
  });

  it("falls back to a question mark for an empty name", () => {
    expect(localCardLabels({ name: "  ", path: "/x/y" }).letter).toBe("?");
  });
});

describe("folder-missing card", () => {
  it("keeps the counts as the details line when they are known", () => {
    const labels = vaultCardLabels({ name: "X" }, { people: 2, notes: 5 }, { folderMissing: true });
    expect(labels.meta).toBe("2 people · 5 notes");
    expect(labels.metaDanger).toBe(false);
  });

  it("says Folder missing in the danger colour when the counts are unknown", () => {
    const labels = vaultCardLabels({ name: "X" }, null, { folderMissing: true });
    expect(labels.meta).toBe("Folder missing");
    expect(labels.metaDanger).toBe(true);
  });

  it("leaves the details line empty for a healthy card with no counts", () => {
    const labels = vaultCardLabels({ name: "X" }, null);
    expect(labels.meta).toBeNull();
    expect(labels.metaDanger).toBe(false);
  });

  it("shows one chip and moves Locate folder… into the menu for a synced vault", () => {
    expect(folderMissingCardActions(true)).toEqual({ chip: "restore", menu: ["locate"] });
    expect(folderMissingCardActions(false)).toEqual({ chip: "locate", menu: [] });
  });
});

describe("vault cards (2026-11-20)", () => {
  const org = (id: string, name = id) => ({ id, name });

  it("orders the open vault first, then by last opened here, then by name", () => {
    const out = orderSyncedVaults([org("a", "Zed"), org("b", "Alpha"), org("c", "Mid"), org("d", "Beta")], {
      openOrgId: "c",
      openedAtByOrg: { a: 50, d: 90 },
    });
    expect(out.map((o) => o.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("shows the last eight, all on Show all, and every match while searching", () => {
    const many = Array.from({ length: 11 }, (_, i) => org(`o${i}`, `Vault ${i}`));
    expect(visibleSyncedVaults(many, { query: "", showAll: false })).toMatchObject({ hidden: 11 - RECENT_VAULT_CARDS });
    expect(visibleSyncedVaults(many, { query: "", showAll: false }).shown).toHaveLength(RECENT_VAULT_CARDS);
    expect(visibleSyncedVaults(many, { query: "", showAll: true })).toMatchObject({ hidden: 0 });
    expect(visibleSyncedVaults(many, { query: "", showAll: true }).shown).toHaveLength(11);
    expect(visibleSyncedVaults(many, { query: "vault", showAll: false }).shown).toHaveLength(11);
    expect(visibleSyncedVaults(many, { query: " VAULT 7 ", showAll: false }).shown.map((o) => o.id)).toEqual(["o7"]);
    expect(matchesVaultQuery("Product team", "")).toBe(true);
  });

  it("builds the second line only from what is known", () => {
    const base = { isOpen: false, role: null, onDevice: true, folderMissing: false, usage: null, ownerName: null };
    expect(syncedCardMeta(base)).toEqual([]);
    expect(syncedCardMeta({ ...base, isOpen: true, role: "owner", usage: { people: 4, notes: 1 } })).toEqual([
      { text: "Current", tone: "open" },
      { text: "Owner" },
      { text: "4 people · 1 note" },
    ]);
    expect(syncedCardMeta({ ...base, role: "member", onDevice: false })).toEqual([
      { text: "Member" },
      { text: "Not on this device", tone: "cloud" },
    ]);
    expect(syncedCardMeta({ ...base, role: "admin", ownerName: "Sara" })).toEqual([
      { text: "Admin" },
      { text: "Sara’s vault" },
    ]);
    // An owner's own vault never reads "<their name>'s vault".
    expect(syncedCardMeta({ ...base, role: "owner", ownerName: "Me" })).toEqual([{ text: "Owner" }]);
    expect(syncedCardMeta({ ...base, isOpen: true, folderMissing: true })).toEqual([
      { text: "Current", tone: "open" },
      { text: "Folder missing", tone: "danger" },
    ]);
  });

  it("knows the default vaults folder", () => {
    expect(isDefaultVaultsRoot("/Users/me/Documents/Baalda Vaults")).toBe(true);
    expect(isDefaultVaultsRoot("C:\\Users\\me\\Documents\\Baalda Vaults")).toBe(true);
    expect(isDefaultVaultsRoot("/Users/me/Dropbox/Baalda Vaults")).toBe(false);
  });

  it("shortens a folder path to its last two segments", () => {
    expect(shortFolderPath("/Users/me/Documents/Baalda Vaults")).toBe("Documents › Baalda Vaults");
    expect(shortFolderPath("C:\\Users\\me\\Desktop\\Reading list\\")).toBe("Desktop › Reading list");
    expect(shortFolderPath("/Notes")).toBe("Notes");
  });
});
