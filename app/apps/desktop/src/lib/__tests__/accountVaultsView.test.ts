import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_VAULTS_VIEW_KEY,
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

  it("defaults to list", () => {
    expect(readAccountVaultsView()).toBe("list");
    store[ACCOUNT_VAULTS_VIEW_KEY] = "board";
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
    expect(readAccountVaultsView()).toBe("list");
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
