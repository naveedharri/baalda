import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { auth, RESET_TOKEN_TTL_SECONDS } from "../../auth/auth.js";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { emailEnabled, sendMail } from "../../email/mailer.js";
import { resetPasswordEmail } from "../../email/templates.js";

/**
 * `POST /api/password-reset/request { email }` — ask for a reset link, and be
 * TOLD what happened (issue #99, second pass).
 *
 * Better Auth's own `request-password-reset` answers the same "if this account
 * exists, check your email" whether the address is unknown, the send failed, or
 * the mail went out, and it swallows the send error (`runInBackgroundOrAwait`
 * only logs). Neutral-by-design, but in practice it hid the two things that
 * actually go wrong: the person typed an address that has no account on THIS
 * server (they signed up on the managed instance, or with another email), or
 * the mail provider refused the message. Both ended as "the email never came".
 *
 * The enumeration this gives up is already given up by sign-up, which answers
 * "user already exists" for a taken address — so this route says plainly:
 *
 *   200 { sent: true }                       the email is with the provider
 *   404 { error: "no_account" }              no account for that address here
 *   502 { error: "send_failed", message }    the provider rejected it (logged too)
 *   400 { error: "email_not_configured" }    this server can't send email
 *   429 { error: "too_many_requests" }       per-address throttle
 *
 * The token is minted through Better Auth's own internal adapter, exactly as its
 * endpoint does, so its `reset-password` endpoint consumes it unchanged (single
 * use, `RESET_TOKEN_TTL_SECONDS`, revokes other sessions — see auth.ts).
 */
export const passwordResetRoutes = new Hono();

/** Per-address throttle: a burst of requests for one email is either a stuck
 *  retry loop or someone hammering the oracle; neither needs more mail. */
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

function throttled(email: string, now = Date.now()): boolean {
  const stamps = (recent.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_PER_WINDOW) {
    recent.set(email, stamps);
    return true;
  }
  stamps.push(now);
  recent.set(email, stamps);
  // Keep the map from growing forever on a long-running process.
  if (recent.size > 10_000) {
    for (const [k, v] of recent) if (v.every((t) => now - t >= WINDOW_MS)) recent.delete(k);
  }
  return false;
}

/** Tests only. */
export function __clearResetThrottle(): void {
  recent.clear();
}

passwordResetRoutes.post("/password-reset/request", async (c) => {
  if (!emailEnabled()) {
    return c.json(
      { error: "email_not_configured", message: "This server doesn't send email, so passwords can't be reset here." },
      400,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return c.json({ error: "invalid_email" }, 400);
  if (throttled(email)) {
    return c.json(
      { error: "too_many_requests", message: "Too many reset requests for this address. Try again in an hour." },
      429,
    );
  }

  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM "user" WHERE lower(email) = $1`,
    [email],
  );
  const user = rows[0];
  if (!user) return c.json({ error: "no_account" }, 404);

  // Same shape Better Auth's request-password-reset writes: the token is the
  // identifier, the user id the value. Its reset-password endpoint consumes it.
  const token = randomBytes(24).toString("base64url");
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: user.id,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000),
  });

  const url = `${config.betterAuthUrl}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendMail(
      resetPasswordEmail({ to: user.email, url, validMinutes: RESET_TOKEN_TTL_SECONDS / 60 }),
    );
  } catch (err) {
    console.error(`[email] password reset to ${user.email} failed:`, err);
    return c.json(
      {
        error: "send_failed",
        message: `The mail provider refused the message: ${(err as Error).message}`,
      },
      502,
    );
  }
  return c.json({ sent: true });
});
