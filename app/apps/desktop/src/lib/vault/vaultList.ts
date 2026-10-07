// Which list a recent local folder belongs in (owner decision 2026-10-07).
//
// Account Settings → Vaults lists ONLY the synced vaults this account is a
// member of and the local folders that are not synced to Baalda at all. A
// folder whose own `.context/config.json` stamp names a vault this account is
// NOT a member of (another account's, or another server's) is hidden there,
// and the vault switcher labels it "Synced with another account".
//
// The verdict is delegated to `planTurnOnSync` so the two can never disagree:
// whatever "Turn on sync" would refuse as `blocked-foreign` is `foreign` here,
// whatever it would switch/retry into is `member`, and whatever it would mint
// a new vault for is `local`. Keyed on the same field it reads: the stamp's
// `organizationId` (`ipc.peekVaultStamp`). A stamp with only `serverVaultId`
// (pre-`organizationId` config) carries no vault identity there, so it is
// `local`, exactly as `planTurnOnSync` treats it.
//
// Pure: no store, no IPC.
import { planTurnOnSync } from "./turnOnSync";

export type LocalFolderClass = "member" | "local" | "foreign";

/** The stamp fields the classifier reads (a subset of `ipc.VaultStamp`). */
export interface FolderStamp {
  organizationId: string | null;
}

/**
 * `undefined` = the stamp is unknown (not read yet, or the read failed) —
 * never hide on that. `null` = the folder has no stamp (never synced).
 */
export type StampLookup = (path: string) => FolderStamp | null | undefined;

export function classifyLocalFolder(
  recent: { path: string },
  memberOrgIds: ReadonlySet<string> | readonly string[],
  stampLookup: StampLookup,
  orgVaults: Readonly<Record<string, string>> = {},
): LocalFolderClass {
  const stamp = stampLookup(recent.path);
  if (stamp === undefined) return "local";
  const stampedOrgId = stamp?.organizationId ?? null;
  if (!stampedOrgId) return "local";
  const orgIds = Array.isArray(memberOrgIds)
    ? (memberOrgIds as readonly string[])
    : [...(memberOrgIds as ReadonlySet<string>)];
  const plan = planTurnOnSync({
    openPath: recent.path,
    activeOrganizationId: null,
    orgIds,
    orgVaults,
    stampedOrgId,
  });
  switch (plan.kind) {
    case "blocked-foreign":
      return "foreign";
    case "switch":
    case "retry-active":
      return "member";
    case "create-vault":
      return "local";
  }
}

/** Footnote for the Vaults list when foreign folders were hidden; null for none. */
export function hiddenForeignFootnote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 folder synced with another account isn't shown."
    : `${count} folders synced with another account aren't shown.`;
}

/**
 * The welcome screen's "Recent vaults" rule (owner decision 2026-10-07).
 * Signed in: this account's synced folders (`member`) and plain local folders
 * (`local`); folders bound to another account (`foreign`) are hidden. Signed
 * out: only `local` folders — no synced folder is listed at all, not even
 * with a "sign in to open" hint. A folder whose class is not settled yet is
 * left out, so the caller can wait for `resolved` and never paint a row that
 * would disappear a frame later.
 */
export function welcomeShowsFolder(cls: LocalFolderClass | undefined, signedIn: boolean): boolean {
  if (cls === undefined || cls === "foreign") return false;
  return signedIn || cls === "local";
}

/** `recents` filtered by `welcomeShowsFolder`, order kept. */
export function filterRecentsForWelcome<T extends { path: string }>(
  recents: readonly T[],
  classes: ReadonlyMap<string, LocalFolderClass>,
  signedIn: boolean,
): T[] {
  return recents.filter((r) => welcomeShowsFolder(classes.get(r.path), signedIn));
}

/**
 * The local-folder rows a vault list may show (owner correction 2026-10-07),
 * for lists whose synced vaults come from the account itself (the switcher,
 * Account Settings → Vaults): only `local` folders, i.e. never synced to
 * Baalda at all. A `member` folder is that vault's synced row already, and a
 * `foreign` one (another account's vault; signed out, EVERY stamped folder,
 * since the member list is empty) is hidden. A folder whose class has not
 * settled is left out, so the caller can wait for `resolved` and never paint a
 * row that vanishes a frame later. `currentPath`, the vault open right now,
 * always stays so the user is never stranded.
 */
export function visibleFolders<T extends { path: string }>(
  recents: readonly T[],
  classes: ReadonlyMap<string, LocalFolderClass>,
  currentPath: string | null = null,
): T[] {
  return recents.filter(
    (r) => (currentPath != null && r.path === currentPath) || classes.get(r.path) === "local",
  );
}
