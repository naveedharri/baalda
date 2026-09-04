import { describe, expect, it } from "vitest";
import type { RecentVault } from "../ipc";
import {
  POPOVER_VAULT_ROWS,
  recentVaultRows,
  unboundRecents,
  type VaultRowsInput,
} from "../vaultRows";

// The switcher spends a fixed number of rows on vaults so the menu is the same
// height for everyone, and it spends them on the vaults you actually used
// last — one list, newest first, regardless of whether a vault syncs.

const local = (name: string, openedAt: number): RecentVault => ({
  path: `/vaults/${name}`,
  name,
  openedAt,
});

const rows = (input: Partial<VaultRowsInput>) =>
  recentVaultRows({
    organizations: [],
    locals: [],
    orgVaults: {},
    openedAt: {},
    openPath: null,
    ...input,
  });

const names = (input: Partial<VaultRowsInput>) => rows(input).map((r) => r.name);

describe("recentVaultRows", () => {
  it("interleaves synced and local vaults by last opened", () => {
    expect(
      names({
        organizations: [
          { id: "o1", name: "BenAI OS" },
          { id: "o2", name: "Design" },
        ],
        locals: [local("scratch", 300), local("archive", 100)],
        orgVaults: { o1: "/vaults/benai", o2: "/vaults/design" },
        openedAt: { "/vaults/benai": 400, "/vaults/design": 200 },
      }),
    ).toEqual(["BenAI OS", "scratch", "Design", "archive"]);
  });

  it("caps the list at four rows, keeping the four most recent", () => {
    expect(
      names({
        locals: [
          local("a", 600),
          local("b", 500),
          local("c", 400),
          local("d", 300),
          local("e", 200),
        ],
      }),
    ).toEqual(["a", "b", "c", "d"]);
    expect(POPOVER_VAULT_ROWS).toBe(4);
  });

  it("pins the open vault to the top so the cap can never hide it", () => {
    // `stale` hasn't been opened in ages, but it's the one on screen.
    expect(
      names({
        organizations: [{ id: "o1", name: "stale" }],
        locals: [local("a", 600), local("b", 500), local("c", 400), local("d", 300)],
        orgVaults: { o1: "/vaults/stale" },
        openedAt: { "/vaults/stale": 1 },
        openPath: "/vaults/stale",
      }),
    ).toEqual(["stale", "a", "b", "c"]);
  });

  it("marks exactly one row current — the vault whose folder is open", () => {
    const list = rows({
      organizations: [{ id: "o1", name: "BenAI OS" }],
      locals: [local("scratch", 300)],
      orgVaults: { o1: "/vaults/benai" },
      openedAt: { "/vaults/benai": 400 },
      openPath: "/vaults/scratch",
    });
    expect(list.filter((r) => r.current).map((r) => r.name)).toEqual(["scratch"]);
  });

  it("never calls a local folder current while its vault is the open one", () => {
    // A synced vault and a local folder can't share a path, but the account's
    // active org and the open folder CAN disagree — only the open one wins.
    const list = rows({
      organizations: [{ id: "o1", name: "BenAI OS" }],
      locals: [local("scratch", 300)],
      orgVaults: { o1: "/vaults/scratch" },
      openPath: "/vaults/scratch",
    });
    expect(list.filter((r) => r.current).map((r) => r.name)).toEqual(["BenAI OS"]);
  });

  it("sorts vaults never opened here last — they're on the settings page", () => {
    expect(
      names({
        organizations: [
          { id: "o1", name: "Never opened" },
          { id: "o2", name: "Opened" },
        ],
        orgVaults: { o2: "/vaults/opened" },
        openedAt: { "/vaults/opened": 10 },
        locals: [local("scratch", 5)],
      }),
    ).toEqual(["Opened", "scratch", "Never opened"]);
  });

  it("honours a custom budget", () => {
    expect(names({ locals: [local("a", 3), local("b", 2)], budget: 1 })).toEqual(["a"]);
    expect(names({ locals: [local("a", 3)], budget: 0 })).toEqual([]);
  });
});

describe("unboundRecents", () => {
  const recents = [local("benai", 3), local("scratch", 2), local("ghost", 1)];

  it("hides folders bound to a vault in the account", () => {
    expect(
      unboundRecents(recents, { o1: "/vaults/benai" }, new Set(["o1"])).map((r) => r.name),
    ).toEqual(["scratch", "ghost"]);
  });

  it("keeps a folder bound to a vault the account no longer has (a ghost)", () => {
    // The binding survived the vault (deleted, or another account's). Filtering
    // it out as "bound" left the folder listed nowhere at all.
    expect(
      unboundRecents(recents, { gone: "/vaults/ghost" }, new Set(["o1"])).map((r) => r.name),
    ).toEqual(["benai", "scratch", "ghost"]);
  });

  it("hides nothing when no vault is known yet", () => {
    expect(unboundRecents(recents, {}, new Set()).map((r) => r.name)).toEqual([
      "benai",
      "scratch",
      "ghost",
    ]);
  });
});
