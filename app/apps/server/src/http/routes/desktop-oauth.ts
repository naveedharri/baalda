import { Hono } from "hono";
import { auth, googleEnabled } from "../../auth/auth.js";
import { mintDesktopCode, redeemDesktopCode } from "../../tokens/desktop-code.js";

/**
 * Desktop Google sign-in handoff (spec 04 §7).
 *
 * These live OUTSIDE `/api/auth/*` on purpose: Better Auth owns that prefix via
 * a catch-all, so a route under it would be shadowed. The flow:
 *
 *   1. App binds a loopback listener and POSTs /api/auth/sign-in/social with
 *      callbackURL = `<server>/api/desktop-auth/finish?redirect=http://127.0.0.1:<port>/cb`.
 *   2. System browser does Google consent → Better Auth callback creates the
 *      session (cookie on this origin) and redirects to `finish`.
 *   3. `finish` reads that session, mints a one-time code, and 302s to the
 *      app's loopback URL with `?code=…` (or `?error=…`).
 *   4. App redeems the code at `exchange` for the bearer token + user, then
 *      stores the token in the OS keychain exactly like an email/password login.
 */
export const desktopOauthRoutes = new Hono();

/**
 * Which sign-in methods this server offers. Email+password is always on; Google
 * is on only when the server is configured with OAuth creds. The desktop uses
 * this to decide whether to render the "Continue with Google" button.
 */
desktopOauthRoutes.get("/auth-methods", (c) =>
  c.json({ emailPassword: true, google: googleEnabled }),
);

/**
 * Only ever redirect back to a loopback address — this endpoint hands out a
 * session-bearing code, so it must never become an open redirector.
 */
function loopbackTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return url;
}

desktopOauthRoutes.get("/desktop-auth/finish", async (c) => {
  const target = loopbackTarget(c.req.query("redirect") ?? "");
  if (!target) return c.text("Invalid redirect target", 400);

  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  const token = (result?.session as { token?: string } | undefined)?.token;

  if (!result?.user || !token) {
    target.searchParams.set("error", "no_session");
    return c.redirect(target.toString());
  }

  const code = mintDesktopCode({
    token,
    userId: result.user.id,
    email: result.user.email,
  });
  target.searchParams.set("code", code);
  return c.redirect(target.toString());
});

desktopOauthRoutes.post("/desktop-auth/exchange", async (c) => {
  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const code = body.code;
  if (typeof code !== "string" || code.length === 0) {
    return c.json({ error: "code is required" }, 400);
  }

  const redeemed = redeemDesktopCode(code);
  if (!redeemed) return c.json({ error: "Invalid or expired code" }, 400);

  return c.json({
    token: redeemed.token,
    user: { id: redeemed.userId, email: redeemed.email },
  });
});
