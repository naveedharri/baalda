/**
 * Which pending invitations this device has already shown in the account menu.
 * A new one (not yet seen) pulses in the menu and on the identity-bar dot.
 * Per device, in localStorage; storage that throws or is empty just means
 * every invitation counts as new, which is the safe direction.
 */
export const SEEN_INVITES_KEY = "context.invites.seen.v1";

/** Ids of `invites` that are not in `seenIds`, in list order. */
export function unseenInvitations(
  invites: ReadonlyArray<{ id: string }>,
  seenIds: ReadonlySet<string> | ReadonlyArray<string>,
): string[] {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds as ReadonlyArray<string>);
  return invites.filter((i) => !seen.has(i.id)).map((i) => i.id);
}

/** The set to store once `invites` have been shown: exactly the current ids,
 *  so an accepted, declined or expired invitation is pruned. */
export function seenIdsToStore(invites: ReadonlyArray<{ id: string }>): string[] {
  return [...new Set(invites.map((i) => i.id))];
}

export function loadSeenInvitations(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_INVITES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveSeenInvitations(invites: ReadonlyArray<{ id: string }>): Set<string> {
  const ids = seenIdsToStore(invites);
  try {
    localStorage.setItem(SEEN_INVITES_KEY, JSON.stringify(ids));
  } catch {
    /* storage blocked: the dot just keeps pulsing on this device */
  }
  return new Set(ids);
}
