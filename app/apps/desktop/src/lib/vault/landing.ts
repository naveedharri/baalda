// Where a freshly-established session should put the user.
//
// This used to be an inline chain of early returns in `store.landInLastVault`,
// and its bug was an *absent* branch: several perfectly ordinary states — a
// first sign-in with two or more vaults, or an account with none at all — fell
// off the end of the chain and did nothing, leaving the user looking at the
// signed-out welcome screen they had just signed in from, with no error and no
// hint that anything had happened. A decision table that can silently answer
// "nothing" for a signed-in user is one that needs to be readable in one screen
// and covered case by case, hence this module: pure, no store, no IPC.

/** What the caller should do to land the user. */
export type LandingAction =
  /** The open folder already belongs to the active vault — just turn sync on. */
  | { kind: "enable-sync" }
  /** Make this vault active (which binds/creates its folder and syncs it). */
  | { kind: "switch"; orgId: string }
  /** A local-only folder is open; leave the user in it. */
  | { kind: "stay-local" }
  /** The account has no vaults — create its first one and open that. */
  | { kind: "create-first-vault" }
  /** Nothing to do (and nothing we're allowed to invent). */
  | { kind: "nothing" };

export interface LandingInput {
  /** Vaults we are currently a member of. */
  orgIds: readonly string[];
  /** A vault the user explicitly asked for before being sent through sign-in. */
  requestedOrgId: string | null;
  /** The local folder open right now, if any. */
  openPath: string | null;
  /** Persisted { orgId → local folder } bindings. */
  orgVaults: Readonly<Record<string, string>>;
  /** `session.activeOrganizationId` — null on a fresh sign-in (it's per-session). */
  activeOrganizationId: string | null;
  /** The last vault used on this device. */
  rememberedOrgId: string | null;
  /** May we create a vault for an account that has none? */
  createIfNone: boolean;
  /**
   * The user is part-way through "join a team with a code" on the welcome
   * screen, which runs sign-in/sign-up first and then comes back for the code.
   */
  joiningWithCode?: boolean;
}

export function planLanding(input: LandingInput): LandingAction {
  const isMember = (id: string | null): id is string =>
    !!id && input.orgIds.includes(id);

  // 0) Mid join-with-code: land NOWHERE. The welcome screen still owns this
  //    flow and is waiting to ask for the code, and every branch below would
  //    unmount it — a brand-new account would be handed an auto-created "My
  //    Vault" (branch 6) and an existing one dropped into an old vault, either
  //    way burying the step the user explicitly asked for. `joinVault` is this
  //    flow's landing: it switches into the vault the code names.
  if (input.joiningWithCode) return { kind: "nothing" };

  // 1) An explicit "open this vault" request (a remote vault clicked on the
  //    signed-out welcome screen, which routed through sign-in) wins over every
  //    other heuristic — that's the vault the user just asked for.
  if (isMember(input.requestedOrgId)) {
    return { kind: "switch", orgId: input.requestedOrgId };
  }

  // The folder that's already open (App.tsx reopens the last one at launch) is
  // the strongest signal for "the vault I was last in" — it unifies local and
  // synced vaults under one recency signal.
  const boundOrgOfOpen = input.openPath
    ? (Object.entries(input.orgVaults).find(([, p]) => p === input.openPath)?.[0] ??
      null)
    : null;

  // 2) The open folder belongs to a synced vault → make it active + sync.
  if (input.openPath && isMember(boundOrgOfOpen)) {
    return input.activeOrganizationId === boundOrgOfOpen
      ? { kind: "enable-sync" }
      : { kind: "switch", orgId: boundOrgOfOpen };
  }

  // 3) A local (unsynced) folder is open → keep it local. Don't pull the user
  //    into a different vault just because they happen to be signed in; "Turn
  //    on sync" is the affordance for adopting the folder they're in.
  //
  //    Note the condition is "bound to nothing", not "not bound to a vault we're
  //    in": a folder bound to a vault we've been REMOVED from deliberately falls
  //    through to the restore chain below, so we land in a vault the user still
  //    has rather than sitting in an orphaned folder that can never sync again.
  if (input.openPath && !boundOrgOfOpen) return { kind: "stay-local" };

  // 4) Nothing open → restore the session's active vault, else the last vault
  //    we used on this device (only if we're still a member of it).
  if (isMember(input.activeOrganizationId)) {
    return { kind: "switch", orgId: input.activeOrganizationId };
  }
  if (isMember(input.rememberedOrgId)) {
    return { kind: "switch", orgId: input.rememberedOrgId };
  }

  // 5) We're a member of vaults, but neither signal named one. This is the
  //    ordinary shape of a FIRST sign-in on a device: Better Auth keeps
  //    `activeOrganizationId` on the *session* row, so a new sign-in starts
  //    null, and the store only auto-activates when there is exactly one vault.
  //    With two or more, every branch above came up empty — so open one rather
  //    than none. The first, matching that single-vault auto-activation.
  if (input.orgIds.length > 0) return { kind: "switch", orgId: input.orgIds[0] };

  // 6) Signed in with no vaults at all — a brand-new account. Nothing can be
  //    restored, so make the vault the account obviously needs. Only when the
  //    screen is genuinely empty: creating a vault swaps the open folder for a
  //    new one, which is never right while the user is looking at files.
  return input.createIfNone && !input.openPath
    ? { kind: "create-first-vault" }
    : { kind: "nothing" };
}
