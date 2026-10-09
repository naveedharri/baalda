import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_VAULTS_VIEW_KEY,
  localCardLabels,
  readAccountVaultsView,
  vaultCardLabels,
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
  it("builds name, slug and counts", () => {
    expect(vaultCardLabels({ name: "Acme Team", slug: "acme-team" }, { people: 1, notes: 21 })).toEqual({
      name: "Acme Team",
      slug: "acme-team",
      counts: "1 person · 21 notes",
    });
  });

  it("pluralises and handles one note", () => {
    expect(vaultCardLabels({ name: "X", slug: "x-1" }, { people: 3, notes: 1 }).counts).toBe("3 people · 1 note");
  });

  it("drops a slug that only repeats the name, and unknown counts", () => {
    expect(vaultCardLabels({ name: "Notes", slug: "notes" }, null)).toEqual({ name: "Notes", slug: null, counts: null });
    expect(vaultCardLabels({ name: "Notes", slug: "" }, null).slug).toBeNull();
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
