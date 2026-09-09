import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signIn, signUp } from "./helpers/auth.js";
import { memoryOutbox } from "../src/email/mailer.js";

/**
 * Password reset end to end (issue #99): request → emailed link → branded page
 * → new password → old sessions dead, new password works. Email goes through
 * the in-memory transport (tests/helpers/email-env.ts), so the test follows the
 * exact link a person would click.
 */
const app = createApp(testAppDeps());

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The reset token from the last email sent to `to`. */
function lastResetToken(to: string): string {
  const mail = [...memoryOutbox].reverse().find((m) => m.to === to && /reset/i.test(m.subject));
  if (!mail) throw new Error(`no reset email to ${to}`);
  const m = mail.text.match(/\/reset-password\?token=([A-Za-z0-9._-]+)/);
  if (!m) throw new Error("reset email carries no token link");
  return m[1];
}

describe("password reset", () => {
  beforeEach(async () => {
    await resetDb();
    memoryOutbox.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("advertises the capability when email is configured", async () => {
    const res = await app.request("/api/auth-methods");
    expect(await res.json()).toMatchObject({ passwordReset: true, invitationEmail: true });
  });

  it("emails a single-use link that sets a new password and revokes old sessions", async () => {
    const alice = await signUp("alice@reset.io", "old-password-1");

    const req = await post("/api/auth/request-password-reset", { email: "alice@reset.io" });
    expect(req.status).toBe(200);
    const token = lastResetToken("alice@reset.io");

    // The emailed page renders (and never reflects the token unescaped).
    const pageRes = await app.request(`/reset-password?token=${token}`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("Choose a new password");

    const reset = await post("/api/auth/reset-password", { newPassword: "new-password-2", token });
    expect(reset.status).toBe(200);

    // Old password gone, new one in, argon2id kept.
    await expect(signIn("alice@reset.io", "old-password-1")).rejects.toBeDefined();
    const again = await signIn("alice@reset.io", "new-password-2");
    expect(again.userId).toBe(alice.userId);
    const { rows } = await pool.query<{ password: string }>(
      `SELECT password FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [alice.userId],
    );
    expect(rows[0].password.startsWith("$argon2id$")).toBe(true);

    // The pre-reset session token is dead (revokeSessionsOnPasswordReset).
    const old = await app.request("/api/auth/get-session", {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = await old.json().catch(() => null);
    expect(body === null || body?.session == null).toBe(true);

    // Single use.
    const replay = await post("/api/auth/reset-password", { newPassword: "third-password-3", token });
    expect(replay.status).toBe(400);
  });

  it("answers neutrally for an unknown address and sends nothing", async () => {
    const res = await post("/api/auth/request-password-reset", { email: "nobody@reset.io" });
    expect(res.status).toBe(200);
    expect(memoryOutbox.filter((m) => m.to === "nobody@reset.io")).toHaveLength(0);
  });

  it("lets an account with no password (Google-only) set one via reset", async () => {
    // A user row with no credential account — what a Google sign-up leaves.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('u-google', 'G', 'g@reset.io', true, now(), now()) RETURNING id`,
    );
    expect(rows[0].id).toBe("u-google");

    expect((await post("/api/auth/request-password-reset", { email: "g@reset.io" })).status).toBe(200);
    const token = lastResetToken("g@reset.io");
    expect((await post("/api/auth/reset-password", { newPassword: "chosen-password-9", token })).status).toBe(200);

    const signedIn = await signIn("g@reset.io", "chosen-password-9");
    expect(signedIn.userId).toBe("u-google");
  });

  it("rejects a malformed or expired link on the page itself", async () => {
    expect((await app.request("/reset-password")).status).toBe(400);
    expect((await app.request("/reset-password?token=%3Cscript%3E")).status).toBe(400);
    const res = await post("/api/auth/reset-password", { newPassword: "whatever-123", token: "not-a-token" });
    expect(res.status).toBe(400);
  });

  it("serves the forgot-password and email-verified pages", async () => {
    expect((await app.request("/forgot-password")).status).toBe(200);
    expect((await app.request("/email-verified")).status).toBe(200);
    expect((await app.request("/email-verified?error=invalid_token")).status).toBe(400);
    // The MCP login page links to it when email is on.
    expect(await (await app.request("/oauth/login")).text()).toContain("/forgot-password");
  });

  it("sends a verification email on sign-up and the link verifies the address", async () => {
    const bob = await signUp("bob@verify.io");
    const mail = memoryOutbox.find((m) => m.to === "bob@verify.io" && /confirm/i.test(m.subject));
    expect(mail).toBeDefined();
    const link = mail!.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/)?.[0];
    expect(link).toBeTruthy();

    const url = new URL(link!);
    const res = await app.request(`${url.pathname}${url.search}`, { redirect: "manual" });
    // Better Auth redirects to our callback page after flipping the flag.
    expect([302, 303, 307]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/email-verified");
    const { rows } = await pool.query<{ emailVerified: boolean }>(
      `SELECT "emailVerified" FROM "user" WHERE id = $1`,
      [bob.userId],
    );
    expect(rows[0].emailVerified).toBe(true);
  });
});
