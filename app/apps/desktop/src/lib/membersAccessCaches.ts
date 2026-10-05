import type { AccessDefault, MemberActivityEvent, MembersOverview, TeamAccess } from "./api";
import { resetAccessMapCache } from "./accessBoardLoad";

/**
 * Session caches behind the Members and access views (#307). PAINT ONLY: a
 * revisit shows the last answer while the fresh load runs; nothing reads them
 * to decide or authorise a write. Cleared on sign-out, account change and
 * server change so one account's roster never paints for another.
 */

/** Last roster answer per (server, org, manager view). */
export type RosterSnapshot = {
  overview: MembersOverview | null;
  teamAccess: TeamAccess | null;
  accessDefault: AccessDefault | null;
};
export const rosterCache = new Map<string, RosterSnapshot>();

/** Last activity answer per (server, org, person). */
export const activityCache = new Map<string, MemberActivityEvent[]>();

export function resetRosterCache(): void {
  rosterCache.clear();
}

export function resetActivityCache(): void {
  activityCache.clear();
}

/** Forget every Members and access session cache. */
export function resetMembersAccessCaches(): void {
  resetRosterCache();
  resetActivityCache();
  resetAccessMapCache();
}
