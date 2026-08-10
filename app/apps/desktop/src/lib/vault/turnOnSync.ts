// What "Turn on sync" should actually do for the folder that's open right now.
//
// This used to be an inline guard in `store.turnOnSyncForCurrentVault` that
// asked "does the account have an active vault I'm a member of?" and, if so,
// re-synced the open folder into it. That question is right for exactly one
// case and wrong for the common one: `activeOrganizationId` is an ACCOUNT-level
// pointer that survives opening a plain local folder (nothing in the local-open
// path clears it), so from the second vault onward the answer was always yes.
// Creating a second vault therefore synced its folder into the FIRST vault and
// re-pointed that vault's folder binding at it — the first vault's folder was
// orphaned back into the "Local" list, the new vault never reached the account,
// and by the third round three folders had been reconciled into one server
// vault with three colliding `Welcome.md`s.
//
// The question that distinguishes the cases is about the FOLDER, not the
// account: is the folder I'm looking at already some vault's folder? That is
// the same signal `planLanding` uses (branches 2 and 3), and the two should be
// read together — they answer "which vault does this folder belong to?" for the
// launch path and the turn-on-sync path respectively.
//
// Pure: no store, no IPC.

/** What the caller should do. */
export type TurnOnSyncAction =
  /**
   * The open folder is already the ACTIVE vault's folder, so sync is off
   * because enabling it failed — retry that vault. Creating a vault must never
   * be the recovery path for a failed sync: an invited user whose sync fell
   * through a stale/error path would otherwise click the only affordance on
   * screen and silently land in a brand-new empty vault of their own instead of
   * the one they were invited to.
   */
  | { kind: "retry-active"; orgId: string }
  /**
   * The open folder belongs to a vault that isn't the active one — switch to
   * it rather than creating anything. Without this, adopting the folder for a
   * new vault would evict the binding of the vault that already owns it, which
   * is the same defect in a different disguise.
   */
  | { kind: "switch"; orgId: string }
  /** The folder belongs to no vault — this is a genuinely new vault. */
  | { kind: "create-vault" };

export interface TurnOnSyncInput {
  /** The local folder open right now. */
  openPath: string;
  /** `session.activeOrganizationId` — an account-level pointer, not a folder one. */
  activeOrganizationId: string | null;
  /** Vaults we are currently a member of. */
  orgIds: readonly string[];
  /** Persisted { orgId → local folder } bindings. */
  orgVaults: Readonly<Record<string, string>>;
}

export function planTurnOnSync(input: TurnOnSyncInput): TurnOnSyncAction {
  // Which vault, if any, already calls this folder its own.
  const boundOrg =
    Object.entries(input.orgVaults).find(([, p]) => p === input.openPath)?.[0] ??
    null;

  // A binding to a vault we've since been REMOVED from is stale and must not
  // pin the folder to a vault that can never sync again — fall through and let
  // the folder become a new vault, exactly as `planLanding` branch 3 does.
  if (boundOrg && input.orgIds.includes(boundOrg)) {
    return boundOrg === input.activeOrganizationId
      ? { kind: "retry-active", orgId: boundOrg }
      : { kind: "switch", orgId: boundOrg };
  }

  return { kind: "create-vault" };
}
