import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_VAULTS_VIEW_KEY,
  folderMissingCardActions,
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
