// What the vault switcher shows. One list, newest first — see `recentVaultRows`
// for why the two kinds of vault are no longer partitioned. Pure and
// dependency-free (types only) so it's unit-testable without the store or IPC.

import type { RecentVault } from "./ipc";

/**
 * How many vault rows the switcher spends. A fixed budget is what keeps the
 * menu the same height for everyone: whoever has vaults fills it, and the rest
 * live on the Vaults settings page, reached from the Vault settings row at the
 * foot of the menu.
 */
export const POPOVER_VAULT_ROWS = 4;

/** A vault in this account (a synced/remote vault) or a local folder. */
export type VaultRow = {
  /** React key — stable per vault, and distinct across the two kinds. */
  key: string;
  name: string;
  /** The vault whose folder is OPEN right now. At most one row is current. */
  current: boolean;
  /** Epoch-ms this vault's folder was last opened here; 0 = never. */
  openedAt: number;
} & (
  | { kind: "synced"; orgId: string }
  | { kind: "local"; path: string }
);

export interface VaultRowsInput {
  /** Vaults in the account (Better Auth orgs), any order. */
  organizations: readonly { id: string; name: string }[];
  /** Local folders that aren't bound to a vault (see `unboundRecents`). */
  locals: readonly RecentVault[];
  /** Persisted orgId → local folder path binding (`readOrgVaults`). */
  orgVaults: Readonly<Record<string, string>>;
  /** path → last-opened epoch-ms, from the FULL recents list. */
  openedAt: Readonly<Record<string, number>>;
  /** The folder open right now, or null. */
  openPath: string | null;
  budget?: number;
}

/**
 * The switcher's vault rows: most recently opened first, capped at `budget`.
 *
 * Deliberately NOT split by kind. Splitting meant two headings ("Remote
 * vaults" / "On this device") dividing a list of four rows, and a fixed half
 * of the budget reserved per kind — so a vault you were in an hour ago could
 * be pushed off the list by one you have never opened, purely because it was
 * the other kind. Whether a vault syncs is a property of that vault (it wears
 * a badge), not a place it lives; recency is what a switcher is actually for.
 *
 * The open vault is pinned to the top so it can never hide behind the cap.
 * Synced vaults with no folder on this device have never been opened here, so
 * they sort last — they're reachable on the Vaults settings page.
 */
export function recentVaultRows({
  organizations,
  locals,
  orgVaults,
  openedAt,
  openPath,
  budget = POPOVER_VAULT_ROWS,
}: VaultRowsInput): VaultRow[] {
  // "Current" is the vault whose folder is actually open — not merely the
  // account's active org. After signing in you can be viewing a local folder
  // while an org is active, so a synced row only wins the title when its bound
  // folder is the open one.
  const currentOrgId =
    openPath == null
      ? null
      : (organizations.find((o) => orgVaults[o.id] === openPath)?.id ?? null);

  const rows: VaultRow[] = [
    ...organizations.map((o): VaultRow => {
      const path = orgVaults[o.id];
      return {
        kind: "synced",
        key: `org:${o.id}`,
        orgId: o.id,
        name: o.name,
        current: o.id === currentOrgId,
        openedAt: (path ? openedAt[path] : 0) ?? 0,
      };
    }),
    ...locals.map(
      (r): VaultRow => ({
        kind: "local",
        key: `local:${r.path}`,
        path: r.path,
        name: r.name,
        current: currentOrgId == null && openPath === r.path,
        openedAt: r.openedAt,
      }),
    ),
  ];

  rows.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      b.openedAt - a.openedAt ||
      a.name.localeCompare(b.name),
  );
  return rows.slice(0, Math.max(0, budget));
}

/**
 * Local folders to offer as vaults: recents minus the ones already bound to a
 * vault this account knows about (those show as their vault instead).
 *
 * `knownOrgIds` is the account's vaults plus the cached vault list, NOT just
 * the bound map — a folder bound to an org that no longer exists in the
 * account (vault deleted, signed in as someone else, stale binding) used to be
 * filtered out as "bound" while appearing in no vault list either. That's a
 * ghost vault: a folder full of the user's notes, on disk, listed nowhere.
 * Treating it as local is what makes it reachable again.
 */
export function unboundRecents(
  recents: readonly RecentVault[],
  orgVaults: Readonly<Record<string, string>>,
  knownOrgIds: ReadonlySet<string>,
): RecentVault[] {
  const bound = new Set(
    Object.entries(orgVaults)
      .filter(([orgId]) => knownOrgIds.has(orgId))
      .map(([, path]) => path),
  );
  return recents.filter((r) => !bound.has(r.path));
}
