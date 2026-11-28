import { beforeEach, describe, expect, it } from "vitest";
import { GROUPS_NEW_CHIP_MS, markGroupsTabOpened, showGroupsNewChip } from "../groupsNewChip";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("the Access groups New chip", () => {
  it("shows from its first showing for 21 days", () => {
    expect(showGroupsNewChip(1000)).toBe(true);
    expect(showGroupsNewChip(1000 + GROUPS_NEW_CHIP_MS - 1)).toBe(true);
    expect(showGroupsNewChip(1000 + GROUPS_NEW_CHIP_MS)).toBe(false);
  });

  it("stops once the tab has been opened", () => {
    expect(showGroupsNewChip(1000)).toBe(true);
    markGroupsTabOpened(2000);
    expect(showGroupsNewChip(3000)).toBe(false);
  });

  it("opening the tab before any showing still counts", () => {
    markGroupsTabOpened(1000);
    expect(showGroupsNewChip(2000)).toBe(false);
  });

  it("shows for the session when storage is unavailable or unreadable", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(showGroupsNewChip()).toBe(true);
    expect(() => markGroupsTabOpened()).not.toThrow();
  });
});
