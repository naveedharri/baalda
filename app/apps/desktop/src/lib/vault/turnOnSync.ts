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
  /**
   * The folder's own `.context/config.json` says it belongs to a vault this
   * account is NOT a member of — a teammate's vault, or one synced under a
   * different account on this machine. Adopting it would create a fresh vault
   * under the wrong account and upload every note into it (the registry
   * discards a foreign `serverVaultId` and backfills from scratch), i.e. a
   * silent full duplication. Refuse; the caller says why.
   */
  | { kind: "blocked-foreign"; orgId: string }
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
  /**
   * The vault the folder's own `.context/config.json` is stamped for (see
   * `ipc.peekVaultStamp`), or null. This is the on-disk dual of `orgVaults`: the
   * binding is per-device localStorage and easy to lose, while the stamp
   * travels with the folder — so it both heals a lost binding (stamped for a
   * vault we're in → switch) and unmasks a foreign folder (stamped for one
   * we're not → block) that the binding alone would happily re-adopt.
   */
  stampedOrgId?: string | null;
  /**
   * The stamped vault is GONE from the server — `GET /api/orgs/:id/status`
   * answered 404 (see `lib/vault/unsyncPlan.ts`). The refusal below exists to
   * stop us adopting someone else's folder; a vault that no longer exists is
   * nobody's, so there is nothing left to protect and refusing would strand the
   * folder forever. Only ever set from a 404 — never from a network error, or a
   * flaky connection would hand a live teammate's folder to the wrong account.
   */
  stampedOrgGone?: boolean;
}

export function planTurnOnSync(input: TurnOnSyncInput): TurnOnSyncAction {
  // Which vault, if any, already calls this folder its own.
  const boundOrg =
    Object.entries(input.orgVaults).find(([, p]) => p === input.openPath)?.[0] ??
    null;

  const stamped = input.stampedOrgId ?? null;

  // The folder's own stamp outranks the binding when it names a vault this
  // account can't see. The binding is a per-profile convenience (localStorage,
  // keyed by path); the stamp is what the folder itself says it is. A folder
  // synced against another server (say production) can still be bound to a
  // vault on THIS server by path — honouring the binding then routed into
  // `enableSyncForVault`, whose stamp guard refused, and the user was told to
  // check their connection. Refuse up front instead, with the real reason.
  if (
    stamped &&
    !input.stampedOrgGone &&
    !input.orgIds.includes(stamped) &&
    stamped !== boundOrg
  ) {
    return { kind: "blocked-foreign", orgId: stamped };
  }

  // A binding to a vault we've since been REMOVED from is stale and must not
  // pin the folder to a vault that can never sync again — fall through and let
  // the folder become a new vault, exactly as `planLanding` branch 3 does.
  if (boundOrg && input.orgIds.includes(boundOrg)) {
    return boundOrg === input.activeOrganizationId
      ? { kind: "retry-active", orgId: boundOrg }
      : { kind: "switch", orgId: boundOrg };
  }

  // No usable binding — ask the folder itself. Stamped for a vault we're in:
  // the binding was lost (cleared storage, eviction), not the membership, so
  // switch to that vault rather than minting a duplicate.
  if (stamped && input.orgIds.includes(stamped)) {
    return stamped === input.activeOrganizationId
      ? { kind: "retry-active", orgId: stamped }
      : { kind: "switch", orgId: stamped };
  }

  // Stamped for a vault this account can't see: refuse to adopt — UNLESS the
  // server has confirmed that vault no longer exists, in which case the stamp is
  // a tombstone and this folder is free to become a new vault (reusing the doc
  // ids already in the local index, so its history survives the round trip).
  if (stamped && !input.stampedOrgGone) return { kind: "blocked-foreign", orgId: stamped };

  return { kind: "create-vault" };
}

/**
 * What the user is told when a folder is stamped for a vault this account
 * can't see. The stamp records only the vault id, not the server it lives on,
 * so "another server" (the usual case: a folder synced against production
 * while the app points elsewhere) and "another account on this server" can't
 * be told apart here — the sentence names both remedies.
 */
export function foreignFolderMessage(orgId: string): string {
  return (
    `This folder is already synced to a vault on another server or account (vault id ${orgId}). ` +
    "Switch the server URL in Settings → Connection to the one it was synced with, " +
    "sign in with the account it was synced with, or open a different folder."
  );
}
