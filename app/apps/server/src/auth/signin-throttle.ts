import { pool } from "../db/pool.js";

/**
 * Per-account throttle for failed email/password sign-ins (issue #237).
 *
 * Counts failures per lowercased email in Postgres (`signin_throttle`, migration
 * 036), so it holds across restarts and instances and is independent of the
 * client IP. After `MAX_FAILURES` inside `WINDOW_MS` the account is locked for
 * the next step of `LOCKOUT_LADDER_MS`; a success or a password reset clears it.
 * Keyed by the string, not the user row: unknown addresses behave identically.
 */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60_000;
export const LOCKOUT_LADDER_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** A lockout this long in the past no longer escalates the next one. */
const LOCKOUT_MEMORY_MS = 24 * 60 * 60_000;

export function throttleKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Seconds until the account may try again, or 0 when it is not locked. */
export async function lockedForSeconds(email: string): Promise<number> {
  const { rows } = await pool.query<{ ms: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (locked_until - now())) * 1000 AS ms
       FROM signin_throttle WHERE email = $1 AND locked_until > now()`,
    [throttleKey(email)],
  );
  const ms = rows[0]?.ms ? Number(rows[0].ms) : 0;
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** Record one failed attempt; returns the lockout length (s) it triggered, or 0. */
export async function recordFailure(email: string): Promise<number> {
  const key = throttleKey(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO signin_throttle (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [key],
    );
    const { rows } = await client.query<{
      failures: number;
      lockouts: number;
      window_expired: boolean;
      lockout_forgotten: boolean;
    }>(
      `SELECT failures, lockouts,
              window_start < now() - make_interval(secs => $2::double precision / 1000) AS window_expired,
              (locked_until IS NOT NULL
                 AND locked_until < now() - make_interval(secs => $3::double precision / 1000))
                AS lockout_forgotten
         FROM signin_throttle WHERE email = $1 FOR UPDATE`,
      [key, WINDOW_MS, LOCKOUT_MEMORY_MS],
    );
    const row = rows[0]!;
    const lockouts = row.lockout_forgotten ? 0 : row.lockouts;
    const failures = row.window_expired ? 1 : row.failures + 1;
    let lockMs = 0;
    if (failures >= MAX_FAILURES) {
      lockMs = LOCKOUT_LADDER_MS[Math.min(lockouts, LOCKOUT_LADDER_MS.length - 1)]!;
      await client.query(
        `UPDATE signin_throttle
            SET failures = 0, window_start = now(), lockouts = $2,
                locked_until = now() + make_interval(secs => $3::double precision / 1000),
                updated_at = now()
          WHERE email = $1`,
        [key, lockouts + 1, lockMs],
      );
    } else {
      await client.query(
        `UPDATE signin_throttle
            SET failures = $2,
                window_start = CASE WHEN $3::boolean THEN now() ELSE window_start END,
                lockouts = $4, updated_at = now()
          WHERE email = $1`,
        [key, failures, row.window_expired, lockouts],
      );
    }
    await client.query("COMMIT");
    return Math.ceil(lockMs / 1000);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Forget every failure and lockout for this account (success / password reset). */
export async function clearThrottle(email: string): Promise<void> {
  await pool.query(`DELETE FROM signin_throttle WHERE email = $1`, [throttleKey(email)]);
}

/** The 429 every locked attempt gets — the same body whether or not the account exists. */
export function throttledResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      code: "TOO_MANY_ATTEMPTS",
      message: "Too many failed sign-in attempts. Try again later, or reset your password.",
      retryAfterSeconds,
    }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfterSeconds) },
    },
  );
}

/**
 * Wraps Better Auth's handler for `POST /api/auth/sign-in/email`: refuses a
 * locked account before any password check (from any IP), counts a 401 as a
 * failure, and clears the count on success. The attempt that trips the lock
 * still answers its own 401; the NEXT one gets the 429.
 */
export async function throttledSignIn(
  req: Request,
  handler: (req: Request) => Promise<Response>,
): Promise<Response> {
  let email: string | null = null;
  try {
    const body = (await req.clone().json()) as { email?: unknown };
    if (typeof body?.email === "string" && body.email.trim()) email = body.email;
  } catch {
    // Not JSON — let Better Auth produce its own validation error.
  }
  if (!email) return handler(req);

  const wait = await lockedForSeconds(email);
  if (wait > 0) return throttledResponse(wait);

  const res = await handler(req);
  if (res.status === 401) await recordFailure(email);
  else if (res.ok) await clearThrottle(email);
  return res;
}
