/* The account menu re-reads pending invitations and whether the server takes
   bug reports when it opens. Hover opens it often, so each of those asks at
   most once per minute; the last answer stays on screen in the meantime. A
   click that opens the menu straight from closed still asks at once. */
import type { HoverMenuMode } from "./hoverMenu";

export const MENU_FETCH_MIN_INTERVAL_MS = 60_000;

export interface FetchThrottle {
  /** True (and recorded) when a fetch for `key` should go out now. */
  shouldFetch(key: string, now: number, force?: boolean): boolean;
  /** Forget the last fetch, so the next one goes out (after a sign-out). */
  reset(): void;
}

/** One throttle per fetch; a new `key` (another account or server) always fetches. */
export function createFetchThrottle(intervalMs = MENU_FETCH_MIN_INTERVAL_MS): FetchThrottle {
  let lastKey: string | null = null;
  let lastAt = 0;
  return {
    shouldFetch(key, now, force = false) {
      if (!force && key === lastKey && now - lastAt < intervalMs) return false;
      lastKey = key;
      lastAt = now;
      return true;
    },
    reset() {
      lastKey = null;
      lastAt = 0;
    },
  };
}

/** A click-pinned open from closed may skip the throttle; pinning a hover preview may not. */
export function isForcedMenuOpen(previous: HoverMenuMode, next: HoverMenuMode): boolean {
  return previous === "closed" && next === "pinned";
}
