// Last-known vault access mode, cached per (server, vault) for instant paint.
//
// Without it the Access page lies on every open: `mode` is unknown until the
// team-access GET lands, and "unknown" used to render as **Private** — so a
// vault that is Shared flashed Private, and every row badge flashed with it,
// for as long as the network took. A remembered mode is not authoritative (the
// panel still refuses to WRITE one until the real answer arrives, or the confirm
// would count overrides it never fetched), but it is right far more often than
// a guess, and it makes the page stop flickering.
//
// Keyed by server URL like `store.knownVaultsKey`: the same vault id means
// nothing across two servers, and self-hosters switch.

import type { TeamMode } from "./accessMode";

const PREFIX = "context.teamAccess";

/** Storage key for one vault's cached mode. */
export function teamAccessCacheKey(serverUrl: string, orgId: string): string {
  return `${PREFIX}:${serverUrl}:${orgId}`;
}

/** The slice of `Storage` this needs — injectable so the tests run without a DOM. */
export type ModeStore = Pick<Storage, "getItem" | "setItem">;

function ambientStorage(): ModeStore | null {
  try {
    return (globalThis as { localStorage?: ModeStore }).localStorage ?? null;
  } catch {
    // Some embedders throw on the property access itself, not just on use.
    return null;
  }
}

function isMode(v: unknown): v is TeamMode {
  return v === "open" || v === "readonly" || v === "private";
}

/** The remembered mode, or null when nothing usable is stored. */
export function readTeamAccessCache(
  serverUrl: string,
  orgId: string | null,
  storage: ModeStore | null = ambientStorage(),
): TeamMode | null {
  if (!orgId || !storage) return null;
  try {
    const raw = storage.getItem(teamAccessCacheKey(serverUrl, orgId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const mode = (parsed as { mode?: unknown } | null)?.mode;
    return isMode(mode) ? mode : null;
  } catch {
    return null;
  }
}

/** Remember the mode the server just reported. Best effort — never throws. */
export function writeTeamAccessCache(
  serverUrl: string,
  orgId: string | null,
  mode: TeamMode,
  storage: ModeStore | null = ambientStorage(),
): void {
  if (!orgId || !storage) return;
  try {
    storage.setItem(teamAccessCacheKey(serverUrl, orgId), JSON.stringify({ mode }));
  } catch {
    /* quota/unavailable — the cache is a convenience only */
  }
}

/** The slice of `Storage` a forget needs — separate from {@link ModeStore} so
 *  the existing read/write fakes keep type-checking unchanged. */
export type ModeEraser = Pick<Storage, "removeItem">;

function ambientEraser(): ModeEraser | null {
  try {
    return (globalThis as { localStorage?: ModeEraser }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Drop a vault's remembered mode. Called when the vault stops existing (made
 * local only): a cached "shared" left behind would seed the Access page's paint
 * for an id that can never answer again, and vault ids are not reused.
 * Best effort — never throws.
 */
export function forgetTeamAccessCache(
  serverUrl: string,
  orgId: string | null,
  storage: ModeEraser | null = ambientEraser(),
): void {
  if (!orgId || !storage) return;
  try {
    storage.removeItem(teamAccessCacheKey(serverUrl, orgId));
  } catch {
    /* unavailable — the cache is a convenience only */
  }
}
