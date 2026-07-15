import { randomBytes } from "node:crypto";

/**
 * One-time handoff codes for desktop Google sign-in (spec 04 §7).
 *
 * The Google consent completes in the user's *system browser*, but the session
 * token must land in the Tauri app (a separate cookie jar). After Better Auth
 * creates the session, `/api/desktop-auth/finish` mints one of these codes bound
 * to the session token and redirects the browser to the app's loopback listener
 * with `?code=…`. The app then redeems it over an authenticated-by-possession
 * POST to `/api/desktop-auth/exchange`. Codes are:
 *   - single-use (deleted on redeem),
 *   - short-lived (TTL below) — the exchange happens within a second or two,
 *   - opaque 256-bit random.
 *
 * NOTE: the store is in-memory, so mint and redeem must hit the same process.
 * That holds for single-instance deploys (our managed backend today; self-host
 * by default). If the server is ever scaled horizontally behind a load balancer
 * (REDIS_URL set for the vault channel), back this with Redis/Postgres so a code
 * minted on one instance can be redeemed on another.
 */

export interface DesktopCodePayload {
  /** The Better Auth session token — used as the bearer, stored in the keychain. */
  token: string;
  userId: string;
  email: string;
}

interface Entry extends DesktopCodePayload {
  expiresAt: number;
}

/** Codes are redeemed within seconds; a minute is comfortably generous. */
const CODE_TTL_MS = 60_000;

const store = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [code, entry] of store) {
    if (entry.expiresAt <= now) store.delete(code);
  }
}

/** Mint a single-use code bound to the given session. Returns the code string. */
export function mintDesktopCode(payload: DesktopCodePayload): string {
  const now = Date.now();
  sweep(now);
  const code = randomBytes(32).toString("base64url");
  store.set(code, { ...payload, expiresAt: now + CODE_TTL_MS });
  return code;
}

/** Redeem a code, returning its payload once. Null if unknown/expired/used. */
export function redeemDesktopCode(code: string): DesktopCodePayload | null {
  const now = Date.now();
  sweep(now);
  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code); // single-use, even on the expiry path below
  if (entry.expiresAt <= now) return null;
  return { token: entry.token, userId: entry.userId, email: entry.email };
}

/** Test-only: clear the store between cases. */
export function __clearDesktopCodes(): void {
  store.clear();
}
