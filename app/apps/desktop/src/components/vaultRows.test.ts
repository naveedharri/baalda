import { describe, expect, it } from "vitest";
import { splitVaultRows } from "./AccountMenu";

// The switcher spends a fixed number of rows on vaults so the menu is the same
// height for everyone. How those rows are divided is the fiddly part: an even
// split when both kinds can fill their half, and no wasted rows when one kind
// is empty or nearly so.

const total = (r: { synced: number; local: number }) => r.synced + r.local;

describe("splitVaultRows", () => {
  it("splits evenly when both kinds can fill their half", () => {
    expect(splitVaultRows(5, 5)).toEqual({ synced: 2, local: 2 });
    expect(splitVaultRows(2, 2)).toEqual({ synced: 2, local: 2 });
  });

  it("gives the whole budget to synced when there are no local vaults", () => {
    expect(splitVaultRows(9, 0)).toEqual({ synced: 4, local: 0 });
  });

  it("gives the whole budget to local when signed out (no synced vaults)", () => {
    expect(splitVaultRows(0, 9)).toEqual({ synced: 0, local: 4 });
  });

  it("lets each kind claim rows the other cannot use", () => {
    // One local vault doesn't need its half, so synced takes the slack — and
    // vice versa. The lone vault of the smaller kind still gets shown.
    expect(splitVaultRows(9, 1)).toEqual({ synced: 3, local: 1 });
    expect(splitVaultRows(1, 9)).toEqual({ synced: 1, local: 3 });
  });

  it("never shows more rows than there are vaults", () => {
    expect(splitVaultRows(1, 1)).toEqual({ synced: 1, local: 1 });
    expect(splitVaultRows(0, 0)).toEqual({ synced: 0, local: 0 });
    expect(splitVaultRows(3, 1)).toEqual({ synced: 3, local: 1 });
  });

  it("never exceeds the budget, for any mix", () => {
    for (let synced = 0; synced <= 8; synced++) {
      for (let local = 0; local <= 8; local++) {
        const rows = splitVaultRows(synced, local);
        expect(total(rows)).toBeLessThanOrEqual(4);
        expect(rows.synced).toBeLessThanOrEqual(synced);
        expect(rows.local).toBeLessThanOrEqual(local);
      }
    }
  });

  it("fills the budget whenever enough vaults exist to fill it", () => {
    for (let synced = 0; synced <= 8; synced++) {
      for (let local = 0; local <= 8; local++) {
        const rows = splitVaultRows(synced, local);
        // No row is left on the table while a vault is waiting for one.
        expect(total(rows)).toBe(Math.min(4, synced + local));
      }
    }
  });

  it("honours a custom budget", () => {
    expect(splitVaultRows(5, 5, 6)).toEqual({ synced: 3, local: 3 });
    expect(splitVaultRows(5, 0, 2)).toEqual({ synced: 2, local: 0 });
  });
});
