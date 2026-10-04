// Teammates' pictures, loaded in the background when a synced vault opens.
//
// Sidebar presence dots and version rows carry only a user id, so they draw a
// teammate's picked character only once the shared avatar directory
// (`avatarIdentity.ts`) knows it. The members overview is what teaches it
// (`api.getMembersOverview` feeds `rememberAvatarImage`), and until now that
// request ran only when Vault Settings opened. This asks for it once per vault
// open instead, through the SAME request, and never on a vault-channel
// reconnect: the caller's inputs are the vault, the account and the server,
// none of which a reconnect changes, and the interval below absorbs a burst of
// re-opens. Failures are silent; the id-seeded face stays.

/** Minimum time between two background loads for the same vault and account. */
export const MEMBER_PICTURES_INTERVAL_MS = 10 * 60_000;

export interface MemberPicturesInput {
  /** Signed in AND the open vault syncs (a local-only vault has no members). */
  synced: boolean;
  serverUrl: string;
  userId: string | null;
  orgId: string | null;
}

/** The identity a load is for, or null when there is nothing to ask. */
export function memberPicturesKey(input: MemberPicturesInput): string | null {
  if (!input.synced || !input.userId || !input.orgId) return null;
  return `${input.serverUrl}|${input.userId}|${input.orgId}`;
}

/**
 * Remembers when each (server, account, vault) was last asked. Pure apart from
 * the injected clock and fetch, so the trigger rule is unit-testable.
 */
export function createMemberPicturesLoader(deps: {
  fetch: (orgId: string) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const interval = deps.intervalMs ?? MEMBER_PICTURES_INTERVAL_MS;
  const lastAsked = new Map<string, number>();

  /** Starts a load when due. Returns whether a request was made. */
  return function maybeLoad(input: MemberPicturesInput): boolean {
    const key = memberPicturesKey(input);
    if (!key || !input.orgId) return false;
    const t = now();
    const last = lastAsked.get(key);
    if (last !== undefined && t - last < interval) return false;
    // Stamped before the request, so a failure is not retried until the next
    // interval, vault, account or server.
    lastAsked.set(key, t);
    void deps.fetch(input.orgId).catch(() => {});
    return true;
  };
}
